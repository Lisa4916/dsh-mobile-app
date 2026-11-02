// 逐帧（rAF）记录侧栏位置 + 该元素上是否有正在跑的 transition 动画 + 样式表数量变化。
// 目的：判定「侧栏从 left=0 滑到 -209」到底是
//   (a) 一次真正的 CSS transition（getAnimations() 里会有 CSSTransition）
//   (b) 页面 JS 慢一步写 transform（没有动画对象，位置直接跳）
// 这两者的修法完全不同，不能靠猜。
//
// 用法：node probe-sidebar-anim.cjs [cdpPort]
const http = require('http');
const { resolveSerial, ADB } = require('./device.cjs');

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
      setTimeout(() => rej(new Error('timeout ' + method)), 12000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECORDER = `(function(){
  window.__anim = [];
  var lastKey = null, n = 0;
  function col() {
    var f = document.querySelector('[data-mobile-nav="frame"]');
    if (!f) return null;
    var kids = f.children;
    for (var i = 0; i < kids.length; i++) {
      if ((kids[i].className || '').toString().indexOf('sidebarCol') !== -1) return kids[i];
    }
    return null;
  }
  function tick() {
    var c = col();
    var st = document.styleSheets.length;
    if (c) {
      var cs = getComputedStyle(c);
      var r = c.getBoundingClientRect();
      var anims = (c.getAnimations ? c.getAnimations() : []).map(function (a) {
        return (a.transitionProperty || a.animationName || a.constructor.name) + ':' + a.playState;
      });
      var key = Math.round(r.left) + '|' + cs.transform + '|' + st + '|' + anims.join(',');
      if (key !== lastKey) {
        lastKey = key;
        window.__anim.push({
          t: Math.round(performance.now()),
          left: Math.round(r.left),
          tr: cs.transform,
          sheets: st,
          anims: anims,
          inline: c.getAttribute('style')
        });
      }
    }
    if (++n < 900) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  document.addEventListener('transitionrun', function (e) {
    window.__anim.push({ t: Math.round(performance.now()), ev: 'transitionrun', prop: e.propertyName, target: (e.target.className || '').toString().slice(0, 50) });
  }, true);
  document.addEventListener('transitionstart', function (e) {
    window.__anim.push({ t: Math.round(performance.now()), ev: 'transitionstart', prop: e.propertyName, target: (e.target.className || '').toString().slice(0, 50) });
  }, true);
})();`;

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json'));
  const target = list.find((x) => x.type === 'page');
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.connect();
  let id = 1;
  await ws.cmd(id++, 'Page.enable');
  await ws.cmd(id++, 'Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await ws.cmd(id++, 'Page.reload', { ignoreCache: false });
  await sleep(9000);

  const r = await ws.cmd(id++, 'Runtime.evaluate', { expression: 'JSON.stringify(window.__anim || [])', returnByValue: true });
  const log = JSON.parse((r.result && r.result.value) || '[]');
  console.log('--- 侧栏逐帧变化（' + log.length + ' 条）---');
  for (const e of log) {
    if (e.ev) { console.log(`[${String(e.t).padStart(6)}ms] ${e.ev} prop=${e.prop} target=${e.target}`); continue; }
    console.log(`[${String(e.t).padStart(6)}ms] left=${String(e.left).padStart(6)} sheets=${e.sheets} anims=[${e.anims.join(',')}] inline=${e.inline}`);
  }

  const animated = log.some((e) => (e.anims && e.anims.length) || e.ev === 'transitionrun');
  console.log('\n--- 判定 ---');
  console.log('存在 CSS transition 参与？ = ' + (animated ? '是（是 transition 动画）' : '否（位置是直接跳过去的）'));

  try { ws.socket.destroy(); } catch (e) { }
  process.exit(0);
})();
