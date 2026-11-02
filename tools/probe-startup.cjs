// 冷启动逐帧采样：抓「启动瞬间侧栏有没有动」。
//
// 为什么必须单独写一个：`record-back.cjs` 是「已连上 CDP → 触发返回 → 采样」，
// 而启动时的问题发生在 **CDP 还没连上的那段时间**（WebView 刚创建、文档还没解析完）。
// 所以这里反过来：先 force-stop，再 am start，然后**边等边连**，一旦连上立刻开始采样。
// 连上的那一刻可能已经错过了头几百毫秒，所以同时把 `Performance.getMetrics` 的
// `NavigationStart` 拿来做时间基准，把采样时间换算回「页面启动后多少毫秒」。
//
// 判据（侧栏闪动的定义）：连续采样中 sideL 出现 >= -60 的帧（= 侧栏大半个身子进了屏幕），
// 且之后又回到收起的负值。只出现一次大幅正值再回去，就是一次「闪」。
//
// 用法：node probe-startup.cjs [cdpPort] [采样毫秒数] [间隔ms]
const http = require('http');
const { execFileSync } = require('child_process');
const { resolveSerial, ADB } = require('./device.cjs');

const CDP_PORT = process.argv[2] || '9222';
const TOTAL_MS = Number(process.argv[3] || 24000);
const STEP_MS = Number(process.argv[4] || 40);
const PKG = 'com.dsh.remote';

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
}

class WS {
  constructor(url) { this.url = url; this.events = []; this.handlers = []; }
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
      setTimeout(() => rej(new Error('timeout ' + method)), 8000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次求值拿全部需要的量，避免每帧多次往返（往返延迟会吃掉帧间隔）。
const SAMPLE_JS = `(function(){
  var out = { t: Date.now() };
  var b = document.body ? (document.body.innerText || '') : '';
  out.tabs = b.indexOf('\u5bf9\u8bdd') !== -1 && b.indexOf('\u8f68\u8ff9') !== -1;
  out.hero = b.indexOf('\u63a2\u7d22\u672a\u81f3\u4e4b\u5883') !== -1;
  out.len = b.length;
  var best = -9999, panelCls = '';
  var all = document.querySelectorAll('[class*="wtg9ga_side"],[class*="side"],[class*="drawer"]');
  for (var i = 0; i < all.length; i++) {
    var e = all[i];
    var r = e.getBoundingClientRect();
    if (r.width < 60) continue;
    if (r.left > best) { best = r.left; panelCls = (e.className || '').toString().slice(0, 40); }
  }
  out.sideL = best === -9999 ? null : Math.round(best);
  out.sideCls = panelCls;
  return JSON.stringify(out);
})()`;

(async () => {
  const dev = resolveSerial(process.env.DEV_SERIAL);
  const adb = (...args) => execFileSync(ADB, ['-s', dev, ...args], { encoding: 'utf8' });

  adb('forward', '--remove-all');
  adb('shell', 'am', 'force-stop', PKG);
  await sleep(600);
  adb('shell', 'am', 'start', '-W', '-n', PKG + '/.MainActivity');
  const t0 = Date.now();

  // 边等边连：socket 名要等 WebView 起来才出现
  let ws = null, sock = null;
  let lastErr = '';
  while (Date.now() - t0 < 20000) {
    try {
      const unix = adb('shell', 'cat', '/proc/net/unix');
      const m = unix.match(/@?webview_devtools_remote_[0-9]+/);
      sock = m ? m[0].replace(/^@/, '') : null;
      if (sock) {
        adb('forward', 'tcp:' + CDP_PORT, 'localabstract:' + sock);
        const list = JSON.parse(await get('http://127.0.0.1:' + CDP_PORT + '/json'));
        const t = list.find((x) => x.type === 'page');
        if (t) { ws = new WS(t.webSocketDebuggerUrl); await ws.connect(); break; }
        lastErr = '有 socket 无 page target';
      } else {
        lastErr = '还没有 webview_devtools_remote socket';
      }
    } catch (e) { lastErr = e.message; }
    await sleep(150);
  }
  if (!ws) { console.error('20 秒内没连上 CDP，放弃。最后一次原因：' + lastErr); process.exit(1); }
  const connectedAt = Date.now() - t0;
  console.log('连上 CDP 耗时 = ' + connectedAt + 'ms（此前的时间窗看不到，只能靠 DOM 快照猜）');

  let id = 1;
  const frames = [];
  const deadline = Date.now() + TOTAL_MS;
  while (Date.now() < deadline) {
    const r = await ws.cmd(id++, 'Runtime.evaluate', { expression: SAMPLE_JS, returnByValue: true }).catch(() => null);
    if (r && r.result && typeof r.result.value === 'string') {
      try {
        const o = JSON.parse(r.result.value);
        o.ms = Date.now() - t0;
        frames.push(o);
      } catch (e) { }
    }
    await sleep(STEP_MS);
  }

  console.log('\n采样帧数 = ' + frames.length + '，间隔目标 ' + STEP_MS + 'ms');
  console.log('\n--- 只打印侧栏位置发生变化的帧 ---');
  let last = null;
  for (const f of frames) {
    const key = f.sideL + '|' + f.sideCls + '|' + f.tabs + '|' + f.hero;
    if (key === last) continue;
    last = key;
    console.log(`[${String(f.ms).padStart(6)}ms] sideL=${f.sideL} cls=${f.sideCls} tabs=${f.tabs} hero=${f.hero} len=${f.len}`);
  }

  // 判据：出现过 >= -60 的 sideL，且随后又回到负值
  const entered = frames.filter((f) => f.sideL !== null && f.sideL >= -60);
  const negative = frames.filter((f) => f.sideL !== null && f.sideL < -60);
  const flashed = entered.length > 0 && negative.length > 0;
  console.log('\n--- 判定 ---');
  console.log('sideL >= -60 的帧数 = ' + entered.length + (entered.length ? '（首次 ' + entered[0].ms + 'ms）' : ''));
  console.log('sideL <  -60 的帧数 = ' + negative.length);
  console.log('侧栏闪动 = ' + (flashed ? '是 ❌' : '否 ✅'));
  if (entered.length) {
    console.log('进入屏幕的样本：' + JSON.stringify(entered.slice(0, 6).map((f) => ({ ms: f.ms, l: f.sideL, c: f.sideCls }))));
  }

  // 必须显式退出：WebSocket 长连接会让 Node 进程永远挂着（不 exit 就一直算「仍在运行」）。
  try { ws.socket.destroy(); } catch (e) { }
  process.exit(0);
})();
