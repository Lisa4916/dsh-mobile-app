// 验证 ASK_USER 分支：地址里没有 ?token= 时，落到「访问验证」页只提示一次，不清 cookie、不重导航。
//
// 前提（必须先在手机侧把端点写成不带 token 的地址，再启动 App）：
//   dsh_endpoints.xml 里只有一条 https://<host>/        （无 ?token=）
// 然后本脚本：弄脏 dsh_pocket_token → Page.navigate 到 origin/ →
//   期望：页面停在「DSH Pocket · 访问验证」，且 Document 序列里**没有**带 retry / token 的跳转。
// 如果 cookie 被清掉并重导航，说明 ASK_USER 分支写错了，用户会被永久锁在验证页外。
//
// 用法：node verify-ask-user.cjs [cdpPort]
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
const CDP_PORT = process.argv[2] || '9222';

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有 page target'); process.exit(1); }
  const origin = new URL(t.url).origin;
  const host = new URL(t.url).hostname;
  console.log('当前页面 =', t.url);
  console.log('注意：只有当前 App 的端点 URL 不带 ?token= 时，本脚本的结论才对应 ASK_USER 分支。');

  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let i = 1;

  await ws.cmd(i++, 'Network.enable', {});
  await ws.cmd(i++, 'Page.enable', {});

  // 弄脏 cookie（模拟 dsh web 重启导致 sessionKey 变化后的失效 cookie）
  const stale = 'deadbeef'.repeat(8);
  await ws.cmd(i++, 'Network.setCookie', {
    name: 'dsh_pocket_token', value: stale, domain: host, path: '/',
    httpOnly: true, expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  });

  ws.events.length = 0;
  console.log('\n--- Page.navigate 到 ' + origin + '/ ---');
  await ws.cmd(i++, 'Page.navigate', { url: origin + '/' });
  await sleep(15000);

  const navs = ws.events.filter((e) => e.method === 'Network.requestWillBeSent' && e.params.type === 'Document');
  const all = ws.events.filter((e) => e.method === 'Network.requestWillBeSent');
  console.log('\n--- Document 级请求序列 ---');
  navs.forEach((e, k) => {
    const u = e.params.request.url;
    console.log(`  ${k + 1}. ${u}${u.indexOf('dsh-pocket-retry') !== -1 ? '   ← retry' : ''}${u.indexOf('token=') !== -1 ? '   ← 带 token' : ''}`);
  });

  const ev = await ws.cmd(i++, 'Runtime.evaluate', {
    expression: "JSON.stringify({t:document.title,b:((document.body?document.body.innerText:'')||'').replace(/\\s+/g,' ').slice(0,90)})",
    returnByValue: true,
  });
  let page = {};
  try { page = JSON.parse(ev.result.result.value || '{}'); } catch (e) {}

  const ck = await ws.cmd(i++, 'Network.getCookies', { urls: [t.url] });
  const tok = ((ck.result && ck.result.cookies) || []).find((c) => c.name === 'dsh_pocket_token');

  console.log('\n--- FINAL ---');
  console.log('  title =', page.t);
  console.log('  body  =', JSON.stringify((page.b || '').trim()));
  console.log('  dsh_pocket_token =', tok ? (tok.value === stale ? '仍是脏值（未清）' : tok.value.slice(0, 16) + '…（被重下发）') : '(无)');
  console.log('  15 秒内全部请求数 =', all.length);

  const selfHealed = navs.some((e) => {
    const u = e.params.request.url;
    return u.indexOf('dsh-pocket-retry') !== -1 || u.indexOf('token=') !== -1;
  });
  const onPinPage = (page.t || '').indexOf('访问验证') !== -1 || (page.b || '').indexOf('访问密码') !== -1;
  const cookieUntouched = !!tok && tok.value === stale;

  console.log('\n  未触发自愈重连（ASK_USER 只提示）=', !selfHealed ? '是 ✅' : '否 ❌');
  console.log('  停在访问验证页                     =', onPinPage ? '是 ✅' : '否 ❌');
  console.log('  未清 cookie（不锁死用户）          =', cookieUntouched ? '是 ✅' : '否 ❌');
  console.log('\n  提示：测完请把端点改回带 ?token= 的地址，否则手机会一直停在验证页。');
  process.exit(0);
})();
