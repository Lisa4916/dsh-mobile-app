// 打开侧栏并列出会话，用于把 App 推进到「会话页」以便复现滑动返回。
// 用法：
//   node probe-sessions.cjs <cdpPort>        列出侧栏里的会话
//   node probe-sessions.cjs <cdpPort> open   打开侧栏
const http = require('http');
const PORT = process.argv[2] || '9222';
const CMD = process.argv[3] || 'list';

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
    this.buf = Buffer.alloc(0); this.handlers = new Map(); this.nextId = 1;
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
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); } }, 8000);
    });
  }
}

const OPEN_JS = `
(function(){
  // 侧栏收起时，开关是 aria-label=打开侧边栏 的按钮，可能在屏外 —— 用 .click() 直接点不依赖坐标
  var btn = document.querySelector('[aria-label="打开侧边栏"]');
  if (!btn) {
    var bs = document.querySelectorAll('button');
    for (var i=0;i<bs.length;i++){
      var a = bs[i].getAttribute('aria-label') || '';
      if (a.indexOf('侧边栏') !== -1 || a.indexOf('sidebar') !== -1) { btn = bs[i]; break; }
    }
  }
  if (!btn) return 'no-toggle';
  btn.click();
  return 'clicked:' + (btn.className||'') + '|' + (btn.getAttribute('aria-label')||'');
})();
`;

const LIST_JS = `
(function(){
  var root = document.querySelector('.wtg9ga_root');
  if (!root) return JSON.stringify({ err: 'no-sidebar' });
  var r = root.getBoundingClientRect();
  var items = [];
  var all = root.querySelectorAll('[class]');
  for (var i=0;i<all.length;i++){
    var el = all[i], c = (el.className||'').toString();
    if (c.indexOf('session') === -1 && c.indexOf('Session') === -1) continue;
    var g = el.getBoundingClientRect();
    if (g.width < 60 || g.height < 16) continue;
    items.push({ cls: c.slice(0,60), txt: (el.textContent||'').trim().slice(0,40),
                 l: Math.round(g.left), t: Math.round(g.top),
                 w: Math.round(g.width), h: Math.round(g.height) });
  }
  return JSON.stringify({
    sidebar: { cls: root.className, l: Math.round(r.left), w: Math.round(r.width) },
    items: items.slice(0, 30)
  });
})();
`;

(async () => {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();

  if (CMD === 'open') {
    const r = await ws.cmd('Runtime.evaluate', { expression: OPEN_JS, returnByValue: true });
    console.log('open:', r.result && r.result.result ? r.result.result.value : JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 900));
  }

  const r2 = await ws.cmd('Runtime.evaluate', { expression: LIST_JS, returnByValue: true });
  const o = JSON.parse(r2.result.result.value);
  console.log('sidebar', JSON.stringify(o.sidebar));
  if (o.items) {
    console.log('--- 会话条目 ---');
    o.items.forEach((it, i) => console.log(`  ${i}. l=${it.l} t=${it.t} ${it.w}x${it.h} cls=${it.cls} txt=${it.txt}`));
  }
  ws.sock.end();
})().catch((e) => { console.error(e); process.exit(1); });
