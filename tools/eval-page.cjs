// 通用 CDP 求值器：把一段 JS 送到真机 WebView 里跑，打印返回值。
// 用法：
//   node eval-page.cjs <cdpPort> "<js表达式>"
//   node eval-page.cjs <cdpPort> --file <path>
// 这是本项目调试 WebView 的最短路径 —— 比 adb shell input 可靠（MIUI 拒绝触摸注入）。
const http = require('http');
const fs = require('fs');

const PORT = process.argv[2] || '9222';
let EXPR;
if (process.argv[3] === '--file') EXPR = fs.readFileSync(process.argv[4], 'utf8');
else EXPR = process.argv.slice(3).join(' ');

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.handlers = new Map(); this.nextId = 1; this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(String(Math.random())).toString('base64');
      this.sock = require('net').connect(this.port, this.host, () => {
        this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let up = false;
      this.sock.on('data', (c) => {
        if (!up) {
          this.buf = Buffer.concat([this.buf, c]);
          const i = this.buf.indexOf('\r\n\r\n');
          if (i >= 0) { up = true; this.buf = this.buf.subarray(i + 4); resolve(); if (this.buf.length) this._drain(); }
          return;
        }
        this.buf = Buffer.concat([this.buf, c]); this._drain();
      });
      this.sock.on('error', reject);
    });
  }
  _drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const p = this.buf.subarray(off, off + len).toString('utf8');
      const op = b0 & 0x0f;
      this.buf = this.buf.subarray(off + len);
      if (op === 1) {
        let m; try { m = JSON.parse(p); } catch { continue; }
        const h = this.handlers.get(m.id);
        if (h) { this.handlers.delete(m.id); h(m); }
        else if (m.method) this.events.push(m);
      }
    }
  }
  cmd(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, resolve);
      const payload = Buffer.from(JSON.stringify({ id, method, params: params || {} }), 'utf8');
      const mask = Buffer.alloc(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      this.sock.write(Buffer.concat([header, mask, payload]));
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); } }, 10000);
    });
  }
}

(async () => {
  if (!EXPR) { console.error('缺少表达式'); process.exit(1); }
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  const r = await ws.cmd('Runtime.evaluate', {
    expression: EXPR, returnByValue: true, awaitPromise: true,
  });
  if (r.__timeout) { console.log('(求值超时)'); ws.sock.end(); return; }
  if (r.result && r.result.exceptionDetails) {
    console.log('异常:', JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  } else {
    const v = r.result && r.result.result ? r.result.result.value : r;
    if (typeof v === 'string') console.log(v);
    else console.log(JSON.stringify(v, null, 2));
  }
  ws.sock.end();
})().catch((e) => { console.error(e); process.exit(1); });
