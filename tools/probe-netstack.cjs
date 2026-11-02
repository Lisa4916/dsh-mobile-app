// 诊断「断网恢复后 WebView 导航仍然失败」到底是 WebView 网络栈卡死，
// 还是我们自己的 loadUrl / 错误页残留问题。
//
// 做法：完全绕过 App 的 UI 与 connect()，直接用 CDP 的 Page.navigate 导航，
// 分别在「网络正常」与「飞行模式恢复后」两种状态下跑一次，比较结果。
//   - 两种状态下 CDP 导航都失败 → WebView/Chromium 的 network context 没重新绑定新网络（系统/内核层）
//   - 正常态成功、恢复态失败但 am force-stop 重启后成功 → 同上，进程级
//   - CDP 导航成功而 App 点击失败 → 我们自己的 loadUrl / 错误页残留
//
// 用法：
//   node probe-netstack.cjs <cdpPort>                     探一次，打印 title/url/readyState
//   node probe-netstack.cjs <cdpPort> --navigate <url>    强制导航后再探（观察是否成功）
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
      setTimeout(() => { if (this._waitId === id) { this._waitId = null; res({ error: 'timeout' }); } }, 12000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = process.argv[2] || '9222';
const NAV_ARG = process.argv.indexOf('--navigate');
const NAV_URL = NAV_ARG !== -1 ? process.argv[NAV_ARG + 1] : null;

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let i = 1;

  await ws.cmd(i++, 'Network.enable', {});
  await ws.cmd(i++, 'Page.enable', {});
  await ws.cmd(i++, 'Runtime.enable', {});

  if (NAV_URL) {
    console.log('--- Page.navigate 到 ' + NAV_URL + ' ---');
    ws.events.length = 0;
    const r = await ws.cmd(i++, 'Page.navigate', { url: NAV_URL });
    console.log('  Page.navigate 返回:', JSON.stringify(r.result || r.error));
    await sleep(15000);
    const docs = ws.events.filter((e) => e.method === 'Network.requestWillBeSent' && e.params.type === 'Document');
    const resps = ws.events.filter((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document');
    const fails = ws.events.filter((e) => e.method === 'Network.loadingFailed');
    console.log('  Document 请求数 =', docs.length, '/ 响应数 =', resps.length, '/ loadingFailed 数 =', fails.length);
    docs.forEach((e, k) => console.log(`   req ${k + 1}: ${e.params.request.url}`));
    resps.forEach((e, k) => console.log(`   res ${k + 1}: ${e.params.response.status} ${e.params.response.url}`));
    fails.forEach((e, k) => console.log(`   fail ${k + 1}: ${e.params.errorText} (${e.params.type}) blocked=${!!e.params.blockedReason}`));
  }

  const ev = await ws.cmd(i++, 'Runtime.evaluate', {
    expression: "JSON.stringify({t:document.title,u:location.href,rs:document.readyState,b:((document.body?document.body.innerText:'')||'').replace(/\\s+/g,' ').slice(0,70)})",
    returnByValue: true,
  });
  let page = {};
  try { page = JSON.parse((ev.result && ev.result.result && ev.result.result.value) || '{}'); } catch (e) {}
  console.log('\n--- FINAL ---');
  console.log('  title      =', page.t);
  console.log('  url        =', page.u);
  console.log('  readyState =', page.rs);
  console.log('  body       =', JSON.stringify((page.b || '').trim()));
  process.exit(0);
})();
