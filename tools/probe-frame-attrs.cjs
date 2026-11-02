// 用 CDP 的 addScriptToEvaluateOnNewDocument 在文档创建**之前**装观察器，
// 记录 [data-mobile-nav="frame"] 出现时与后续变化时的那一刻：
// 属性值、侧栏 transform、是否已经有过 transition。
//
// 为什么要在文档前装：这问题就发生在首帧，页面自己的 JS 跑起来之后再注入已经晚了。
//
// 用法：node probe-frame-attrs.cjs [cdpPort]
const http = require('http');
const { resolveSerial, ADB } = require('./device.cjs');
const { execFileSync } = require('child_process');

const CDP_PORT = process.argv[2] || '9222';

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
}

class WS {
  constructor(url) { this.url = url; this.handlers = []; }
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
      let obj = null; try { obj = JSON.parse(payload.toString('utf8')); } catch (e) { }
      if (obj) this.handlers.forEach((h) => h(obj));
    }
  }
  cmd(id, method, params) {
    return new Promise((res, rej) => {
      const msg = JSON.stringify({ id, method, params: params || {} });
      const data = Buffer.from(msg, 'utf8');
      const mask = Buffer.from([1, 2, 3, 4]);
      let head;
      if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
      else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      const onMsg = (o) => { if (o.id === id) { this.handlers = this.handlers.filter((h) => h !== onMsg); res(o.result); } };
      this.handlers.push(onMsg);
      this.socket.write(Buffer.concat([head, mask, masked]));
      setTimeout(() => rej(new Error('timeout ' + method)), 10000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 观察器：每次 frame 元素属性变化就记一条，带 performance.now() 与侧栏 transform。
const OBSERVER = `(function(){
  window.__flashLog = [];
  var t0 = performance.now();
  function snap(why, el) {
    var row = null;
    if (el) {
      var kids = el.children, col = null;
      for (var i = 0; i < kids.length; i++) {
        var c = (kids[i].className || '').toString();
        if (c.indexOf('sidebarCol') !== -1) { col = kids[i]; break; }
      }
      row = {
        collapsed: el.getAttribute('data-sidebar-collapsed'),
        rightbar: el.getAttribute('data-rightbar-collapsed'),
        nav: el.getAttribute('data-mobile-nav'),
        grid: el.style.gridTemplateColumns,
        colTr: col ? getComputedStyle(col).transform : null,
        colRectL: col ? Math.round(col.getBoundingClientRect().left) : null
      };
    }
    window.__flashLog.push({ t: Math.round(performance.now()), why: why, row: row });
  }
  var mo = new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.type === 'attributes' && r.target && r.target.getAttribute && r.target.getAttribute('data-mobile-nav')) {
        snap('attr:' + r.attributeName, r.target);
      }
    }
  });
  function start() {
    var el = document.querySelector('[data-mobile-nav="frame"]');
    if (!el) return false;
    snap('first-seen', el);
    mo.observe(el, { attributes: true });
    return true;
  }
  if (!start()) {
    var t = setInterval(function () { if (start()) clearInterval(t); }, 8);
    window.__flashLog.push({ t: 0, why: 'waiting-for-frame', row: null });
  }
  document.addEventListener('DOMContentLoaded', function () { snap('DOMContentLoaded', document.querySelector('[data-mobile-nav="frame"]')); });
  window.addEventListener('load', function () { snap('load', document.querySelector('[data-mobile-nav="frame"]')); });
})();`;

(async () => {
  const dev = resolveSerial(process.env.DEV_SERIAL);
  const list = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json'));
  const target = list.find((x) => x.type === 'page');
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.connect();
  let id = 1;

  await ws.cmd(id++, 'Page.enable');
  const added = await ws.cmd(id++, 'Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER });
  console.log('已注入 document-start 观察器 id=' + (added && added.identifier));

  await ws.cmd(id++, 'Page.reload', { ignoreCache: false });
  await sleep(9000);

  const r = await ws.cmd(id++, 'Runtime.evaluate', {
    expression: 'JSON.stringify(window.__flashLog || [])', returnByValue: true,
  });
  const log = JSON.parse((r.result && r.result.value) || '[]');
  console.log('\n--- 观察记录（' + log.length + ' 条）---');
  for (const e of log) {
    const row = e.row;
    if (!row) { console.log(`[${String(e.t).padStart(6)}ms] ${e.why}`); continue; }
    console.log(`[${String(e.t).padStart(6)}ms] ${e.why.padEnd(22)} collapsed=${row.collapsed} colRectL=${row.colRectL} tr=${row.colTr}`);
  }

  // 关键判定：首帧出现时 collapsed 是不是已经是 true
  const first = log.find((e) => e.why === 'first-seen');
  console.log('\n--- 判定 ---');
  if (!first || !first.row) {
    console.log('没抓到首帧（页面可能没重新挂载 frame）');
  } else {
    console.log('首帧 data-sidebar-collapsed = ' + first.row.collapsed + '  侧栏 left = ' + first.row.colRectL);
    console.log('首帧就是收起态？ = ' + (first.row.collapsed === 'true' ? '是 ✅' : '否 ❌（说明首帧侧栏是展开的）'));
  }

  try { ws.socket.destroy(); } catch (e) { }
  process.exit(0);
})();
