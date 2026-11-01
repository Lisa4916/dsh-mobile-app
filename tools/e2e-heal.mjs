// 握手自愈端到端演练：复现**用户真实遇到的那种故障**，再看 App 自己是否恢复。
//
// 故障的准确成因（本轮实测确认，别再猜别的路径）：
// dsh-pocket 的 upstreamPathWithLaunchToken（proxy.mjs:599-610）只要看到请求带着
// `dsh-auth-*` 就**永不**补 launch token。于是当这条 cookie 的 authority 指向一个
// 已经不存在的上游端口（dsh web 重启后端口会变，实测 54282 → 17169）时：
//   代理不补 token → 上游不认这条 cookie → 401 → 页面只剩
//   "dsh web authentication required; reopen the URL printed by dsh web."
// 这正是不停重试也修不好的原因：请求一直带着那条坏 cookie，代理就一直不补 token。
//
// 注意这条路径**不会**触发 503 限流页：不注入 token 就不记一次握手，计数永远不涨。
// 所以判据必须覆盖裸 401 页（HEAL_PROBE_JS 的第二条），只等 503 会永远等不到。
//
// 断言三件事：
//   a. 中途确实出现 401 裸文案（AUTHREQ）；
//   b. 最终回到 DSH 主界面（MAIN）；
//   c. dsh_pocket_token 始终在 —— 否则「修好」等于把用户踢回 PIN 登录页。
//
// 用法：node tools/e2e-heal.mjs [--total=20000]
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 9222;
const PROXY_URL = 'http://192.168.50.58:3081/';
const AUTH_NAME = 'dsh-auth-EsoXtJryKJQ28wPgFmAwoh5SXSZuIJJnQzgBqP1AcaA';
/** authority 指向不存在的端口，签名保持原样 —— 模拟「dsh web 重启换了端口」。 */
const STALE_AUTH =
  'v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MSIsImlzc3VlZEF0IjoxNzkzNTAwODgzNjU1LCJleHBpcmVzQXQiOjE3OTYwOTI4ODM2NTV9.0c3h3trsA_gktEYLA_6ssu9QU0VzhrK5JbTrRAcymjw';

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.nextId = 1; this.waiters = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.host, port: this.port, path: this.path,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.sock = socket; socket.on('data', (d) => this.onData(d)); socket.on('error', () => {}); resolve();
      });
      req.on('error', reject); req.end();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; const hi = this.buf.readUInt32BE(off); const lo = this.buf.readUInt32BE(off + 4); len = hi * 0x100000000 + lo; off += 8; }
      let maskKey = null;
      if (masked) { if (this.buf.length < off + 4) return; maskKey = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x1) {
        let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) { const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); w(msg); }
      }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8'); const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    const mask = crypto.randomBytes(4); const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve); this.send({ id, method, params });
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

const PROBE = `(function(){
  try {
    var t = (document.title || '');
    var b = (document.body ? document.body.innerText : '') || '';
    if (b.indexOf('访问密码') !== -1) return 'PIN';
    if (b.indexOf('无法完成登录握手') !== -1) return 'HANDBLOCK';
    if (b.indexOf('dsh web authentication required') !== -1) return 'AUTHREQ';
    if (b.indexOf('导出会话日志') !== -1 || b.indexOf('探索未至之境') !== -1) return 'MAIN';
    if (b.indexOf('正在进入') !== -1 || t.indexOf('正在进入') !== -1) return 'TRANSITION';
    if (b.length === 0 && t.length === 0) return 'EMPTY';
    return 'OTHER';
  } catch (e) { return 'ERR'; }
})()`;

async function main() {
  const total = Number((process.argv.find((a) => a.startsWith('--total=')) || '--total=20000').split('=')[1]);

  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');
  await ws.call('Network.enable');
  await ws.call('Page.enable');

  const state = async () => {
    try {
      const r = await ws.call('Runtime.evaluate', { expression: PROBE, returnByValue: true });
      return r.result?.result?.value;
    } catch { return 'NAV'; }
  };

  const ck = await ws.call('Network.getCookies', {});
  const pin = (ck.result?.cookies || []).find((c) => c.name === 'dsh_pocket_token');
  if (!pin) {
    console.log('!! WebView 没有 dsh_pocket_token —— 不在登录态');
    ws.sock.end(); process.exit(2);
  }
  console.log(`start: ${await state()}  pin=present`);

  // 1) 先删掉现有 auth cookie，再注入 authority 失效的同名 cookie。
  //    顺序很重要：不删就注入会与 domain-cookie 并存，请求仍带有效那条（实测踩过）。
  //    而且 CDP 的 setCookie 默认建 hostOnly cookie，deleteCookies 若不显式给 domain/path，
  //    可能只删掉其中一个变体 —— 所以注入后必须回读确认「只剩失效值」。
  const existing = (ck.result?.cookies || []).filter((c) => c.name.startsWith('dsh-auth-'));
  for (const c of existing) {
    await ws.call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' });
  }
  const inject = await ws.call('Network.setCookie', {
    name: AUTH_NAME, value: STALE_AUTH,
    domain: '192.168.50.58', path: '/',
    httpOnly: true, secure: false, sameSite: 'Strict',
  });
  console.log(`injected stale auth: success=${inject.result?.success}`);

  const verify = await ws.call('Network.getCookies', {});
  const authNow = (verify.result?.cookies || []).filter((c) => c.name.startsWith('dsh-auth-'));
  console.log(`auth cookies now: ${authNow.map((c) => `${c.name.slice(0, 14)}…@${c.domain}${c.path}`).join(' | ') || '(none)'}`);
  if (authNow.length !== 1 || authNow[0].value !== STALE_AUTH) {
    console.log('!! 注入后 auth cookie 不唯一或不是失效值，故障前提不成立');
    ws.sock.end(); process.exit(2);
  }

  // 2) 导航到根路径。此时代理见 cookie 就不补 token → 上游 401。
  await ws.call('Page.navigate', { url: PROXY_URL });
  console.log('navigated; watching App self-heal...');

  const t0 = Date.now();
  let sawBroken = false;
  let last = '';
  let finalState = '';
  let healedAt = -1;
  // 「看到故障」的判定要容错：401 页是极小的裸文本响应，WebView 从导航到渲染完
  // 只需几十毫秒，采样很可能正好落在中间态（OTHER / EMPTY）。真实故障态是
  // AUTHREQ 或 HANDBLOCK，但中间态同样不该算「一切正常」。
  const isBrokenish = (s) => s === 'AUTHREQ' || s === 'HANDBLOCK' || s === 'OTHER' || s === 'EMPTY';
  while (Date.now() - t0 < total) {
    await new Promise((r) => setTimeout(r, 150));
    const s = await state();
    if (s !== last) {
      last = s;
      console.log(`  +${String(Date.now() - t0).padStart(5)}ms  ${s}`);
    }
    if (isBrokenish(s)) sawBroken = true;
    finalState = s;
    if (sawBroken && s === 'MAIN') { healedAt = Date.now() - t0; break; }
  }

  const after = await ws.call('Network.getCookies', {});
  const authAfter = (after.result?.cookies || []).filter((c) => c.name.startsWith('dsh-auth-'));
  const pinKept = (after.result?.cookies || []).some((c) => c.name === 'dsh_pocket_token');
  const href = await ws.call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });

  finalState = await state();
  const ok = sawBroken && finalState === 'MAIN' && pinKept;
  console.log(`\nfinal=${finalState}  healedAt=${healedAt}ms  pinKept=${pinKept}`);
  console.log(`auth cookies after: ${authAfter.length}  href=${href.result?.result?.value}`);
  console.log(ok
    ? 'E2E PASS: 真实 401 故障 → App 自动恢复主界面，且保住 PIN 会话'
    : 'E2E FAIL');

  ws.sock.end();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
