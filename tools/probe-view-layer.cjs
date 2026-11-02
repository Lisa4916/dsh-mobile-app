// 探测「主区域视图切换」这类层：点侧栏里的功能项后，主区域整块换掉，
// 但它既不是弹窗也不是抽屉 —— 没有 role=menu、没有「关闭」按钮、Escape 也不管。
//
// 要回答三个问题：
//   1. 这种视图有没有稳定可观测的特征（用于返回键识别「我在某一层功能视图里」）
//   2. 它怎么退回去（再点一次同入口？点侧栏开关？点某个返回？）
//   3. 它和侧栏、首页的层序关系
//
// 用法：node probe-view-layer.cjs [cdpPort] [功能项名]
const http = require('http');

const PORT = process.argv[2] || '9222';
const ONLY = process.argv[3] || null;

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
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); } }, 10000);
    });
  }
  async eval(expr) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.__timeout) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 300) };
    return r.result && r.result.result ? r.result.result.value : r;
  }
}

// 判断「主区域现在显示的是什么」——这才是功能视图的真特征。
// 思路：主区域一定在 frame 里、且不含侧栏列；用它在 DOM 里的 role/aria 或者
// 页面自己声明的 data-* 来找。找不到就退回「正文里有没有这个功能的独有文案」。
const VIEW = `(function(){
  try{
    var b=(document.body?document.body.innerText:'')||'';
    var side=document.querySelector('[class*="_sidebarCol"]');
    var sideL=side?Math.round(side.getBoundingClientRect().left):null;

    // 主区域的候选：frame 的兄弟/子节点里宽度接近整屏、且不是侧栏的那块
    var frame=document.querySelector('[data-mobile-nav="frame"]');
    var mainCls=null;
    if(frame){
      var kids=frame.children;
      for(var i=0;i<kids.length;i++){
        var k=kids[i]; var r=k.getBoundingClientRect();
        var cls=(k.className||'').toString();
        if(cls.indexOf('sidebarCol')>=0) continue;
        if(r.width>window.innerWidth*0.6 && r.height>200){ mainCls=cls.slice(0,60); break; }
      }
    }

    // 页面里所有带 aria-current / aria-selected 的导航项 —— 功能视图会点亮对应项
    var current=[];
    var nav=document.querySelectorAll('[aria-current],[aria-selected="true"],[data-active="true"],[data-state="active"]');
    for(var j=0;j<nav.length&&current.length<6;j++){
      var el=nav[j];
      current.push(((el.getAttribute('aria-label')||el.innerText||'')+'').trim().slice(0,14));
    }

    return JSON.stringify({
      hero:b.indexOf('探索未至之境')>=0,
      tabs:(b.indexOf('对话')>=0&&b.indexOf('轨迹')>=0),
      sideL:sideL,
      mainCls:mainCls,
      current:current,
      head:b.replace(/\\s+/g,' ').slice(0,80)
    });
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

const ESC = `(function(){
  var t=document.activeElement||document.body;
  var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
  t.dispatchEvent(new KeyboardEvent('keydown',o));
  document.dispatchEvent(new KeyboardEvent('keydown',o));
  return 'esc';
})()`;

const CLICK_ARIA = (name) => `(function(){
  var els=document.querySelectorAll('button,[role=button],a,div');
  for(var i=0;i<els.length;i++){
    if(els[i].getAttribute&&els[i].getAttribute('aria-label')===${JSON.stringify(name)}){ els[i].click(); return 'ok'; }
  }
  return 'nf';
})()`;

const OPEN_SIDEBAR = `(function(){
  var els=document.querySelectorAll('button,[role=button]');
  for(var i=0;i<els.length;i++){ if(els[i].getAttribute('aria-label')==='打开侧边栏'){ els[i].click(); return 'ok'; } }
  return 'nf';
})()`;

const NEW_SESSION = `(function(){
  var ns=document.querySelector('.wtg9ga_newSession');
  if(ns){ ns.click(); return 'ok'; }
  return 'nf';
})()`;

const ENTRIES = ['插件', '自动化任务', 'XD Pool', 'Purge'];

async function main() {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const view = async () => {
    const raw = await ws.eval(VIEW);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { raw }; } }
    return raw;
  };
  const b = (o) => JSON.stringify({ hero: o.hero, tabs: o.tabs, sideL: o.sideL, cur: o.current, main: o.mainCls });

  // 先回到确定的起点：首页 + 侧栏收起
  await ws.eval(NEW_SESSION);
  await wait(1200);
  const home = await view();
  console.log('起点（首页）:', b(home));
  console.log('  正文:', home.head);

  const list = ONLY ? [ONLY] : ENTRIES;
  for (const name of list) {
    console.log(`\n===== ${name} =====`);
    await ws.eval(OPEN_SIDEBAR);
    await wait(700);
    const side = await view();
    console.log('  侧栏展开:', b(side));

    console.log('  点入口:', await ws.eval(CLICK_ARIA(name)));
    await wait(1200);
    const inView = await view();
    console.log('  进入后:', b(inView));
    console.log('    正文:', inView.head);

    // 试验 1：Escape
    await ws.eval(ESC);
    await wait(900);
    const a1 = await view();
    console.log('  Escape →', b(a1), (a1.hero === inView.hero && a1.head === inView.head) ? '❌ 没动' : '✅ 有变化');

    // 试验 2：再点一次同入口（toggle）
    if (a1.head === inView.head) {
      const again = await ws.eval(CLICK_ARIA(name));
      await wait(1000);
      const a2 = await view();
      console.log('  再点同入口', again, '→', b(a2), (a2.head !== inView.head) ? '✅ 有变化' : '❌ 没动');
    }

    // 试验 3：点「新建会话」
    const ns = await ws.eval(NEW_SESSION);
    await wait(1200);
    const a3 = await view();
    console.log('  点新建会话', ns, '→', b(a3), a3.hero ? '✅ 回首页' : '❌ 未回首页');
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
