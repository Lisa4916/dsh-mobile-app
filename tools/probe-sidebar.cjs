// 现场勘查：把「当前页面里所有可点的顶层按钮」和「能打开侧栏的候选」都列出来，
// 并逐个试探哪个真的能打开侧栏。
//
// 用法： node probe-sidebar.cjs <cdpPort>
//
// 为什么需要它：`DSH_GO_HOME_JS` 靠 `if (b.className) continue` 认「顶部无类名按钮」，
// 这条判据是照着某个版本的 DOM 写的。页面版本一变，类名长出来、位置也变，
// 判据就静默失效 —— 表现为「按返回没反应」。这个脚本用来在真机上直接看当前 DOM。
const http = require('http');
const PORT = process.argv[2] || '9222';

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80;
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.handlers = new Map(); this.nextId = 1;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(String(Math.random())).toString('base64');
      this.sock = require('net').connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
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

const DUMP_JS = `
(function(){
  function geo(el){
    if(!el) return null;
    var r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height) };
  }
  var out = { buttons: [], newSession: null, sidebar: null };
  var ns = document.querySelector('.wtg9ga_newSession');
  out.newSession = ns ? { cls: ns.className, geo: geo(ns),
                          text: (ns.textContent||'').trim().slice(0,20) } : null;

  // 找侧栏容器：class 里带 sidebar / wtg9ga 的、宽度接近半屏的
  var all = document.querySelectorAll('*');
  for (var i=0;i<all.length;i++){
    var el = all[i], c = (el.className||'').toString();
    if (!c) continue;
    if (c.indexOf('wtg9ga') === 0 && el.children.length > 3) {
      var g = geo(el);
      if (g && g.w > 100 && g.w < 700) {
        out.sidebar = { cls: c, geo: g };
        break;
      }
    }
  }

  var btns = document.querySelectorAll('button, [role=button]');
  for (var j=0;j<btns.length;j++){
    var b = btns[j], g2 = geo(b);
    if (!g2 || g2.w < 16 || g2.h < 16) continue;
    out.buttons.push({
      cls: (b.className||'(none)').toString().slice(0,48),
      id: b.id || '',
      aria: (b.getAttribute('aria-label')||'').slice(0,24),
      txt: (b.textContent||'').trim().slice(0,16),
      geo: g2,
      onScreen: g2.l >= 0 && g2.t >= 0 && g2.l < innerWidth && g2.t < innerHeight,
      topBar: g2.t < 70
    });
  }
  out.viewport = { w: innerWidth, h: innerHeight };
  return JSON.stringify(out);
})();
`;

(async () => {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  const r = await ws.cmd('Runtime.evaluate', { expression: DUMP_JS, returnByValue: true });
  const o = JSON.parse(r.result.result.value);
  console.log('viewport', JSON.stringify(o.viewport));
  console.log('newSession', JSON.stringify(o.newSession));
  console.log('sidebar', JSON.stringify(o.sidebar));
  console.log('\n--- 顶部（t<70）的按钮 ---');
  o.buttons.filter((b) => b.topBar).forEach((b) => {
    console.log(`  ${b.onScreen ? '屏内' : '屏外'} l=${b.geo.l} t=${b.geo.t} ${b.geo.w}x${b.geo.h} cls=${b.cls} aria=${b.aria} txt=${b.txt}`);
  });
  console.log('\n--- 屏内按钮（最多 25 个）---');
  o.buttons.filter((b) => b.onScreen && !b.topBar).slice(0, 25).forEach((b) => {
    console.log(`  l=${b.geo.l} t=${b.geo.t} ${b.geo.w}x${b.geo.h} cls=${b.cls} txt=${b.txt}`);
  });
  ws.sock.end();
})().catch((e) => { console.error(e); process.exit(1); });
