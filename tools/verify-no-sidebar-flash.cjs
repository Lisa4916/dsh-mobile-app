// 验证方案：在 document-start 注入一条 CSS，把「移动端 frame 的侧栏列」的过渡禁掉，
// 看启动时侧栏还会不会从 left=0 滑到 -209。
//
// 判据与 probe-startup.cjs 一致：出现 sideL >= -60 的帧就算闪。
//
// 用法：node verify-no-sidebar-flash.cjs [cdpPort] [采样毫秒]
const http = require('http');
const { resolveSerial, ADB } = require('./device.cjs');
const { execFileSync } = require('child_process');

const CDP_PORT = process.argv[2] || '9222';
const TOTAL_MS = Number(process.argv[3] || 14000);
const STEP_MS = 40;
const PKG = 'com.dsh.remote';

// 关键：选择器只用 data 属性 + 类名后缀，不写死构建哈希（mP3x-q_ 会随 DSH 版本变）。
// 只禁 transition，不写 transform —— 位置仍由页面自己决定，我们只让它「不带动画地就位」。
const KILL_CSS = `
  [data-mobile-nav="frame"] [class*="_sidebarCol"],
  [data-mobile-nav="frame"] [class*="_rightbarCol"] {
    transition: none !important;
    animation: none !important;
  }
`;

const INJECT = `(function(){
  // document-start 时 document.documentElement 可能是 null，head 一定没有。
  // 所以每一步都要能失败而不中断（上一版就是 appendChild 抛错，后面的监听器没注册上，
  // 结果 css=false、测出来是「没注入」而不是「注入了没用」）。
  window.__injectState = 'start';
  function mark(){
    try {
      if (document.getElementById('__dshNoSidebarAnim')) { window.__injectState = 'ok'; return true; }
      var parent = document.head || document.documentElement || document.getElementsByTagName('html')[0];
      if (!parent) { window.__injectState = 'no-parent'; return false; }
      var st = document.createElement('style');
      st.id = '__dshNoSidebarAnim';
      st.textContent = ${JSON.stringify(KILL_CSS)};
      parent.appendChild(st);
      window.__injectState = 'ok';
      return true;
    } catch (e) {
      window.__injectState = 'err:' + e.message;
      return false;
    }
  }
  if (!mark()) {
    var timer = setInterval(function(){ if (mark()) clearInterval(timer); }, 4);
    document.addEventListener('DOMContentLoaded', mark, { once: true });
  }
})();`;

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

const SAMPLE_JS = `(function(){
  var out = { t: Date.now() };
  var b = document.body ? (document.body.innerText || '') : '';
  out.tabs = b.indexOf('\u5bf9\u8bdd') !== -1 && b.indexOf('\u8f68\u8ff9') !== -1;
  out.hero = b.indexOf('\u63a2\u7d22\u672a\u81f3\u4e4b\u5883') !== -1;
  out.len = b.length;
  var best = -9999, cls = '';
  var all = document.querySelectorAll('[class*="sidebarCol"]');
  for (var i = 0; i < all.length; i++) {
    var r = all[i].getBoundingClientRect();
    if (r.left > best) { best = r.left; cls = (all[i].className || '').toString().slice(0, 40); }
  }
  out.sideL = best === -9999 ? null : Math.round(best);
  out.sideCls = cls;
  out.styleInjected = window.__injectState + '|' + !!document.getElementById('__dshNoSidebarAnim');
  return JSON.stringify(out);
})()`;

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json'));
  const target = list.find((x) => x.type === 'page');
  const ws = new WS(target.webSocketDebuggerUrl);
  await ws.connect();
  let id = 1;
  await ws.cmd(id++, 'Page.enable');
  await ws.cmd(id++, 'Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  console.log('已注入 document-start 去过渡样式');
  await ws.cmd(id++, 'Page.reload', { ignoreCache: false });

  const t0 = Date.now();
  const frames = [];
  while (Date.now() - t0 < TOTAL_MS) {
    const r = await ws.cmd(id++, 'Runtime.evaluate', { expression: SAMPLE_JS, returnByValue: true }).catch(() => null);
    if (r && r.result && typeof r.result.value === 'string') {
      try { const o = JSON.parse(r.result.value); o.ms = Date.now() - t0; frames.push(o); } catch (e) { }
    }
    await sleep(STEP_MS);
  }

  console.log('采样帧数 = ' + frames.length);
  console.log('\n--- 侧栏位置变化的帧 ---');
  let last = null;
  for (const f of frames) {
    const key = f.sideL + '|' + f.styleInjected + '|' + f.hero;
    if (key === last) continue;
    last = key;
    console.log(`[${String(f.ms).padStart(6)}ms] sideL=${f.sideL} hero=${f.hero} len=${f.len} css=${f.styleInjected}`);
  }

  const entered = frames.filter((f) => f.sideL !== null && f.sideL >= -60);
  const negative = frames.filter((f) => f.sideL !== null && f.sideL < -60);
  console.log('\n--- 判定 ---');
  console.log('sideL >= -60 的帧数 = ' + entered.length + (entered.length ? '（首次 ' + entered[0].ms + 'ms）' : ''));
  console.log('sideL <  -60 的帧数 = ' + negative.length);
  console.log('侧栏闪动 = ' + (entered.length > 0 && negative.length > 0 ? '是 ❌' : '否 ✅'));

  try { ws.socket.destroy(); } catch (e) { }
  process.exit(0);
})();
