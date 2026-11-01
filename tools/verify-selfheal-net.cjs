// 用 CDP 的网络事件抓包，判定 App 的「访问验证页自愈」到底有没有触发。
//
// 判定签名：自愈成功必然出现一次请求 URL 同时带 `dsh-pocket-retry=1` 和 `token=`。
// 因为 RecoveryPlanner 的动作链是「清 dsh_pocket_token → 带 retry 参数重导航」，
// 而只有带 ?token= 时 dsh-pocket 才会重新下发 dsh_pocket_token（proxy.mjs:509-525）。
//
// 用法：node verify-selfheal-net.cjs
const http = require('http');

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
}

class WS {
  constructor(url) { this.url = url; this.events = []; }
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
        if (s.id && s.id === this._waitId) {
          const cb = this._waitCb; this._waitId = null; this._waitCb = null; cb(s);
        } else if (s.method) {
          this.events.push(s);
        }
      } catch (e) { /* 忽略非 JSON 帧 */ }
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
      setTimeout(() => { if (this._waitId === id) { this._waitId = null; res({ error: 'timeout' }); } }, 10000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有 page target'); process.exit(1); }
  const origin = new URL(t.url).origin;
  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let i = 1;

  await ws.cmd(i++, 'Network.enable', {});
  await ws.cmd(i++, 'Page.enable', {});
  await ws.cmd(i++, 'Runtime.enable', {});

  async function tokenNow() {
    const ck = await ws.cmd(i++, 'Network.getCookies', { urls: [t.url] });
    const arr = (ck.result && ck.result.cookies) || [];
    const tok = arr.find((c) => c.name === 'dsh_pocket_token');
    return tok ? tok.value : null;
  }

  const tok0 = await tokenNow();
  console.log('原始 dsh_pocket_token =', tok0 ? tok0.slice(0, 16) + '…' : '(无)');
  if (!tok0) { console.error('没有 dsh_pocket_token，先正常进一次主界面'); process.exit(1); }

  // 弄脏
  await ws.cmd(i++, 'Network.setCookie', {
    name: 'dsh_pocket_token',
    value: 'deadbeef'.repeat(8),
    domain: '192.168.50.58',
    path: '/',
    httpOnly: true,
    expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  });
  console.log('已弄脏 ->', (await tokenNow() || '').slice(0, 16) + '…');

  ws.events.length = 0;
  console.log('\n--- Page.navigate 到 ' + origin + '/ ---');
  const t0 = Date.now();
  await ws.cmd(i++, 'Page.navigate', { url: origin + '/' });

  // 观察 30 秒，把导航类请求按发生顺序打出来
  await sleep(30000);

  const navs = ws.events.filter(
    (e) => e.method === 'Network.requestWillBeSent' && e.params.type === 'Document'
  );
  console.log('\n--- Document 级请求序列 ---');
  navs.forEach((e, k) => {
    const u = e.params.request.url;
    const hasRetry = u.indexOf('dsh-pocket-retry') !== -1;
    const hasToken = u.indexOf('token=') !== -1;
    console.log(`  ${k + 1}. ${u}${hasRetry ? '   ← 自愈重连(retry)' : ''}${hasToken ? '   ← 带 token' : ''}`);
  });

  const res = ws.events.filter((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document');
  console.log('\n--- Document 响应（含响应体摘录）---');
  for (let k = 0; k < res.length; k++) {
    const e = res[k];
    let snippet = '(取不到响应体)';
    const body = await ws.cmd(i++, 'Network.getResponseBody', { requestId: e.params.requestId });
    if (body.result && typeof body.result.body === 'string') {
      // base64 编码的二进制不处理，只摘文本
      if (!body.result.base64Encoded) {
        snippet = body.result.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
      } else {
        snippet = '(二进制)';
      }
    }
    console.log(`  ${k + 1}. ${e.params.response.status}  ${e.params.response.url}`);
    console.log(`     body: ${snippet}`);
  }

  // 最终状态
  const ev = await ws.cmd(i++, 'Runtime.evaluate', {
    expression: "JSON.stringify({t:document.title,b:((document.body?document.body.innerText:'')||'').replace(/\\s+/g,' ').slice(0,60)})",
    returnByValue: true,
  });
  let page = {};
  try { page = JSON.parse(ev.result.result.value || '{}'); } catch (e) {}
  const tok1 = await tokenNow();
  console.log('\n--- FINAL ---');
  console.log('  title =', page.t);
  console.log('  body  =', JSON.stringify((page.b || '').trim()));
  console.log('  token =', tok1 ? tok1.slice(0, 16) + '…' : '(无)');

  const healedReq = navs.some((e) => {
    const u = e.params.request.url;
    return u.indexOf('dsh-pocket-retry') !== -1 && u.indexOf('token=') !== -1;
  });
  console.log('\n  自愈重连请求出现 =', healedReq ? '是 ✅' : '否 ❌');
  console.log('  cookie 被重新下发 =', tok1 && tok1 !== 'deadbeef'.repeat(8) ? '是 ✅' : '否 ❌');
  process.exit(0);
})();
