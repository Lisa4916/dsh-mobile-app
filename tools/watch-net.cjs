// 在指定秒数内持续监听 CDP 网络事件，打印所有 Document 级请求与失败。
// 用途：在它运行期间用 adb 点 App 的「连接」，判断点击到底有没有真的发起导航。
//
//   - 有 Document 请求 → loadUrl 确实发了，失败在网络层
//   - 完全没有 Document 请求 → loadUrl 被 Chromium 短路（典型：页面停在
//     chrome-error://chromewebdata/ 时对同一 URL 再次 loadUrl，走错误页重试路径）
//
// 用法：node watch-net.cjs <cdpPort> <秒数>
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
        if (s.id && s.id === this._waitId) {
          const cb = this._waitCb; this._waitId = null; this._waitCb = null; cb(s);
        } else if (s.method && this.onEvent) {
          this.onEvent(s);
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
const SECS = Number(process.argv[3] || 25);

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:' + PORT + '/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有 page target'); process.exit(1); }

  const ws = new WS(t.webSocketDebuggerUrl);
  const t0 = Date.now();
  let docCount = 0;

  ws.onEvent = (s) => {
    const at = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    if (s.method === 'Network.requestWillBeSent') {
      const ty = s.params.type;
      if (ty === 'Document') {
        docCount++;
        console.log(`[${at}] → Document 请求 #${docCount}: ${s.params.request.url}`);
      }
    } else if (s.method === 'Network.responseReceived' && s.params.type === 'Document') {
      console.log(`[${at}] ← Document 响应 ${s.params.response.status}: ${s.params.response.url}`);
    } else if (s.method === 'Network.loadingFailed') {
      console.log(`[${at}] ✗ loadingFailed (${s.params.type}): ${s.params.errorText}`);
    } else if (s.method === 'Page.frameNavigated' && !s.params.frame.parentId) {
      console.log(`[${at}] ⤴ frameNavigated: ${s.params.frame.url}`);
    } else if (s.method === 'Page.frameRequestedNavigation' && !s.params.frame?.parentId) {
      console.log(`[${at}] ⤵ frameRequestedNavigation: ${s.params.url}`);
    }
  };

  await ws.connect();
  let i = 1;
  await ws.cmd(i++, 'Network.enable', {});
  await ws.cmd(i++, 'Page.enable', {});
  await ws.cmd(i++, 'Runtime.enable', {});
  console.log('监听已开始（' + SECS + ' 秒）。现在去点 App 的「连接」。\n');

  await sleep(SECS * 1000);

  const ev = await ws.cmd(i++, 'Runtime.evaluate', {
    expression: "JSON.stringify({t:document.title,u:location.href,rs:document.readyState})",
    returnByValue: true,
  });
  let page = {};
  try { page = JSON.parse((ev.result && ev.result.result && ev.result.result.value) || '{}'); } catch (e) {}
  console.log('\n--- FINAL ---');
  console.log('  title      =', page.t);
  console.log('  url        =', page.u);
  console.log('  readyState =', page.rs);
  console.log('  Document 请求总数 =', docCount, docCount === 0 ? '  ← 一条都没发，loadUrl 被短路' : '');
  process.exit(0);
})();
