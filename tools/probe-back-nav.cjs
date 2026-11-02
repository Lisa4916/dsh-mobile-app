// 返回导航现场探针：在真 WebView 里读页面自报的位置、侧栏/新会话按钮几何、
// 以及「点返回之后页面到底变了什么」。
//
// 用法：
//   node probe-back-nav.cjs <cdpPort> [--state]    只看当前状态
//   node probe-back-nav.cjs <cdpPort> --back      触发一次返回并逐帧记录
//
// 为什么需要它：滑动返回的问题全在「按下之后几百毫秒里页面发生了什么」，
// 截图只能看到终态。这个脚本同时抓 DOM 快照与 Document 级请求，
// 能区分「真的视图切换」与「页面被重载」。
const http = require('http');

const PORT = process.argv[2] || '9222';
const MODE = process.argv[3] || '--state';

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 手搓最小 WebSocket 客户端（项目里其它探针都是这个写法，零依赖）
class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    this.nextId = 1;
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
      let upgraded = false;
      this.sock.on('data', (chunk) => {
        if (!upgraded) {
          this.buf = Buffer.concat([this.buf, chunk]);
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx >= 0) {
            upgraded = true;
            this.buf = this.buf.subarray(idx + 4);
            resolve();
            if (this.buf.length) this._drain();
          }
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this._drain();
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
      const payload = this.buf.subarray(off, off + len).toString('utf8');
      const opcode = b0 & 0x0f;
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) {
        let msg;
        try { msg = JSON.parse(payload); } catch { continue; }
        const h = this.handlers.get(msg.id);
        if (h) { this.handlers.delete(msg.id); h(msg); }
        if (this.onEvent) this.onEvent(msg);
      }
    }
  }
  cmd(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, resolve);
      const body = JSON.stringify({ id, method, params: params || {} });
      const payload = Buffer.from(body, 'utf8');
      const mask = Buffer.from([0, 0, 0, 0]);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      this.sock.write(Buffer.concat([header, mask, payload]));
      setTimeout(() => {
        if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); }
      }, 8000);
    });
  }
}

/** 在页面里取一份「现场快照」：位置、侧栏状态、可点的返回目标几何。 */
const SNAPSHOT_JS = `
(function(){
  function vis(el){
    if(!el) return null;
    var r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top),
             w: Math.round(r.width), h: Math.round(r.height) };
  }
  var b = (document.body ? document.body.innerText : '') || '';
  var ns = document.querySelector('.wtg9ga_newSession');
  // 顶部侧栏开关：收起态下它是「顶部、无类名」的 button
  var toggles = [];
  var btns = document.querySelectorAll('button');
  for (var i=0;i<btns.length;i++){
    var x = btns[i], r = x.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    if (r.top > 60) continue;
    toggles.push({ cls: x.className || '(none)', geo: vis(x) });
  }
  return JSON.stringify({
    title: document.title,
    href: location.href,
    historyLength: history.length,
    bodyHead: b.slice(0, 120),
    hasHero: b.indexOf('探索未至之境') !== -1,
    hasComposer: b.indexOf('描述你想要构建的内容') !== -1,
    hasSessionTabs: b.indexOf('对话') !== -1 && b.indexOf('轨迹') !== -1,
    newSession: vis(ns),
    headerToggles: toggles,
    goingHome: !!window.__dshGoingHome,
    homeReset: !!window.__dshHomeReset
  });
})();
`;

async function main() {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }

  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.cmd('Network.enable');
  await ws.cmd('Page.enable');

  const docs = [];
  ws.onEvent = (msg) => {
    if (msg.method === 'Network.requestWillBeSent' && msg.params.type === 'Document') {
      docs.push(msg.params.request.url);
    }
    if (msg.method === 'Page.frameNavigated' && msg.params.frame.parentId == null) {
      docs.push('⤴ frameNavigated ' + msg.params.frame.url);
    }
  };

  const snap = async () => {
    const r = await ws.cmd('Runtime.evaluate', {
      expression: SNAPSHOT_JS, returnByValue: true, awaitPromise: false,
    });
    if (!r.result || r.__timeout) return '(取不到)';
    return r.result.result.value;
  };

  const before = await snap();
  console.log('=== 当前快照 ===');
  try {
    const o = JSON.parse(before);
    for (const k of Object.keys(o)) console.log(`  ${k} = ${JSON.stringify(o[k])}`);
  } catch { console.log(before); }

  if (MODE !== '--back') { ws.sock.end(); return; }

  console.log('\n=== 触发返回（等同系统返回/手势返回走的分发路径）===');
  // 注意：MIUI 拒绝 input tap/swipe 注入，但 keyevent 可用；
  // 两者最终都进 OnBackPressedDispatcher，代码路径相同。
  const { execFileSync } = require('child_process');
  const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';
  const DEV = process.env.DEV_SERIAL || '8PCE7LJB99VG7TRO';
  execFileSync(ADB, ['-s', DEV, 'shell', 'input', 'keyevent', 'KEYCODE_BACK']);

  // 逐帧记录 3 秒
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await snap();
    let brief = s;
    try {
      const o = JSON.parse(s);
      brief = `t=${o.title} hero=${o.hasHero} tabs=${o.hasSessionTabs} ` +
              `goingHome=${o.goingHome} hist=${o.historyLength} ns=${JSON.stringify(o.newSession)}`;
    } catch { /* keep */ }
    console.log(`  [${(i * 0.25).toFixed(2)}s] ${brief}`);
  }

  console.log('\n=== Document 级事件 ===');
  if (docs.length === 0) console.log('  （一条都没有 → 页面没有重载 ✅）');
  else docs.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  const after = await snap();
  console.log('\n=== 返回后快照 ===');
  try {
    const o = JSON.parse(after);
    for (const k of Object.keys(o)) console.log(`  ${k} = ${JSON.stringify(o[k])}`);
  } catch { console.log(after); }

  ws.sock.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
