// 模拟「dsh_pocket_token 已失效」这个真实故障，用来验证 App 侧自愈是否生效。
//
// 背景（见 PROGRESS.md 第 7b 步）：
//   dsh-pocket 的 maybeSeedAuthCookie（lib/proxy.mjs:509-525）看到请求里**有任何**
//   dsh_pocket_token 就直接 return，拒绝下发新的。而该 cookie 的值是
//   sha256(PIN:sessionKey)，sessionKey 是 dsh web 的进程级随机数 —— Harness 每重启
//   一次就换新，手机上那枚必然失配。于是带着 ?token= 也停在「访问验证」页。
//
// 这个脚本把 HttpOnly 的 dsh_pocket_token 改写成垃圾值，制造同一种故障。
//
// 用法：
//   node simulate-stale-cookie.cjs dump        # 看当前 cookie
//   node simulate-stale-cookie.cjs stale       # 把 dsh_pocket_token 改成垃圾（不重载页面）
// 之后用 adb 重启 App（force-stop + start），观察是否自动回到主界面。
const http = require('http');

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
}

class WS {
  constructor(url) { this.url = url; }
  connect() {
    return new Promise((res, rej) => {
      const u = new URL(this.url);
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (r, socket) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
        res();
      });
      req.on('error', rej); req.end();
    });
  }
  _drain() {
    while (true) {
      if (this.buf.length < 2) return;
      const b2 = this.buf[1]; let len = b2 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      try {
        const s = JSON.parse(payload.toString('utf8'));
        if (s.id === this._waitId) { const cb = this._waitCb; this._waitId = null; this._waitCb = null; cb(s); }
      } catch (e) { /* 非 JSON 帧忽略 */ }
    }
  }
  send(obj) {
    const p = Buffer.from(JSON.stringify(obj));
    const mask = Buffer.from([0, 0, 0, 0]); let head;
    if (p.length < 126) { head = Buffer.from([0x81, 0x80 | p.length]); }
    else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    this.socket.write(Buffer.concat([head, mask, p]));
  }
  cmd(id, method, params) {
    return new Promise((res) => {
      this._waitId = id; this._waitCb = res;
      this.send({ id, method, params });
      setTimeout(() => { if (this._waitId === id) { this._waitId = null; res({ error: 'timeout' }); } }, 8000);
    });
  }
}

(async () => {
  const mode = process.argv[2] || 'dump';
  const list = JSON.parse(await get('http://127.0.0.1:9222/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有找到 page target'); process.exit(1); }
  console.log('URL   =', t.url);
  console.log('TITLE =', t.title);

  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let i = 1;

  const enable = await ws.cmd(i++, 'Network.enable', {});
  if (enable.error) console.log('Network.enable 失败:', JSON.stringify(enable.error));

  const cookies = await ws.cmd(i++, 'Network.getCookies', { urls: [t.url] });
  const list2 = (cookies.result && cookies.result.cookies) || [];
  console.log('--- cookies on this origin ---');
  for (const c of list2) {
    const v = c.name === 'dsh_pocket_token' ? c.value.slice(0, 16) + '…' : '(略)';
    console.log(`  ${c.name}  httpOnly=${c.httpOnly}  domain=${c.domain}  value=${v}`);
  }

  if (mode === 'stale') {
    const old = list2.find((c) => c.name === 'dsh_pocket_token');
    if (!old) { console.error('没有 dsh_pocket_token，先正常登录一次再来'); process.exit(1); }
    // 写一个格式合法但 sessionKey 已对不上的值 —— 正对应「Harness 重启过」的真实现场
    const fake = 'deadbeef'.repeat(8);
    const r = await ws.cmd(i++, 'Network.setCookie', {
      name: 'dsh_pocket_token',
      value: fake,
      domain: old.domain,
      path: old.path || '/',
      httpOnly: true,
      secure: old.secure,
      expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    console.log('setCookie ->', JSON.stringify(r.result || r.error));
    const after = await ws.cmd(i++, 'Network.getCookies', { urls: [t.url] });
    const now = ((after.result && after.result.cookies) || []).find((c) => c.name === 'dsh_pocket_token');
    console.log('现在 dsh_pocket_token =', now ? now.value.slice(0, 16) + '…' : '(没了)');
    console.log('\n下一步：adb -s <设备> shell am force-stop com.dsh.remote 然后 am start，观察是否自动回主界面。');
  }
  process.exit(0);
})();
