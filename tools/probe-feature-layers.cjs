// 探测侧栏与顶栏的各功能项：点进去之后形成的是什么形态的「一层」，
// 以及哪种动作能把它退掉（Escape / 「关闭」按钮 / 再点一次入口）。
//
// 这一步是为了给出「通用退一层」的实现依据 —— 不能按入口名写死，
// 否则新增一个功能项就又漏一层。
//
// 用法：node probe-feature-layers.cjs [cdpPort]
const http = require('http');

const PORT = process.argv[2] || '9222';

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

// 与 App 里要用的探针保持同一套判据，先在这里验证
const LAYERS = `(function(){
  try{
    function vis(el){
      if(!el) return false;
      var cs=getComputedStyle(el); var r=el.getBoundingClientRect();
      return cs.display!=='none' && cs.visibility!=='hidden' && Number(cs.opacity)>0.05 && r.width>8 && r.height>8;
    }
    var menu=0;
    var ms=document.querySelectorAll('[role=menu],[role=listbox]');
    for(var i=0;i<ms.length;i++) if(vis(ms[i])) menu++;
    var panel=0, panelNames=[];
    var bs=document.querySelectorAll('button,[role=button]');
    for(var j=0;j<bs.length;j++){
      var al=bs[j].getAttribute('aria-label')||'';
      if(al.indexOf('关闭')===0 && vis(bs[j])){ panel++; if(panelNames.length<3) panelNames.push(al.slice(0,18)); }
    }
    var side=document.querySelector('[class*="_sidebarCol"]');
    var sideL=side?Math.round(side.getBoundingClientRect().left):null;
    var sidebarOpen = sideL!==null && sideL>-40;
    var rb=document.querySelector('[class*="_rightbarCol"]');
    var rbL=rb?Math.round(rb.getBoundingClientRect().left):null;
    var rbW=rb?Math.round(rb.getBoundingClientRect().width):0;
    var rightbarOpen = false;
    if(rb){ var rbr=rb.getBoundingClientRect(); rightbarOpen = rbr.width>40 && rbr.left < window.innerWidth-40 && vis(rb); }
    var b=(document.body?document.body.innerText:'')||'';
    return JSON.stringify({menu:menu,panel:panel,panelNames:panelNames,sideL:sideL,sidebarOpen:sidebarOpen,rightbarOpen:rightbarOpen,rbW:rbW,
      tabs:(b.indexOf('对话')>=0&&b.indexOf('轨迹')>=0), hero:(b.indexOf('探索未至之境')>=0)});
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

const ESC = `(function(){
  var t=document.activeElement||document.body;
  var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
  t.dispatchEvent(new KeyboardEvent('keydown',o));
  document.dispatchEvent(new KeyboardEvent('keydown',o));
  return 'esc';
})()`;

const CLICK_CLOSE = `(function(){
  var bs=document.querySelectorAll('button,[role=button]');
  for(var i=0;i<bs.length;i++){
    var al=bs[i].getAttribute('aria-label')||'';
    var r=bs[i].getBoundingClientRect();
    if(al.indexOf('关闭')===0 && r.width>8 && r.height>8){ bs[i].click(); return 'closed:'+al.slice(0,18); }
  }
  return 'nf';
})()`;

const CLICK_ARIA = (name) => `(function(){
  var els=document.querySelectorAll('button,[role=button],a,div');
  for(var i=0;i<els.length;i++){
    if(els[i].getAttribute&&els[i].getAttribute('aria-label')===${JSON.stringify(name)}){ els[i].click(); return 'ok'; }
  }
  for(var j=0;j<els.length;j++){
    var el2=els[j];
    if(el2.children.length===0 && (el2.innerText||'').trim()===${JSON.stringify(name)}){ el2.click(); return 'ok-text'; }
  }
  return 'nf';
})()`;

const ENTRIES = ['插件', '自动化任务', 'XD Pool', 'Purge', '更多', '打开目录', '分栏', '新标签页', '导出会话日志'];

async function main() {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const layers = async () => {
    const raw = await ws.eval(LAYERS);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { raw }; } }
    return raw;
  };
  const brief = (o) => JSON.stringify({ menu: o.menu, panel: o.panel, sideL: o.sideL, rightbar: o.rightbarOpen, tabs: o.tabs, hero: o.hero, names: o.panelNames });

  for (const name of ENTRIES) {
    console.log(`\n===== ${name} =====`);
    const before = await layers();
    const c = await ws.eval(CLICK_ARIA(name));
    if (c === 'nf') { console.log('  入口未找到，跳过'); continue; }
    await wait(900);
    const opened = await layers();
    console.log('  进入后:', brief(opened));

    const byEsc = await ws.eval(ESC);
    await wait(800);
    const afterEsc = await layers();
    const escWorked = JSON.stringify(afterEsc) === JSON.stringify(before) ||
      (afterEsc.menu === before.menu && afterEsc.panel === before.panel && afterEsc.sideL === before.sideL && afterEsc.rightbarOpen === before.rightbarOpen);

    if (escWorked) {
      console.log('  Escape →', brief(afterEsc), '✅ 已退一层');
      continue;
    }
    console.log('  Escape →', brief(afterEsc), '❌ 未退');
    const cl = await ws.eval(CLICK_CLOSE);
    await wait(800);
    const afterClose = await layers();
    const closeWorked = afterClose.menu === before.menu && afterClose.panel === before.panel && afterClose.sideL === before.sideL;
    console.log('  点「关闭」', cl, '→', brief(afterClose), closeWorked ? '✅ 已退一层' : '❌ 仍未退');

    // 兜底：再点一次同一个人口（toggle 型入口）
    if (!closeWorked) {
      const again = await ws.eval(CLICK_ARIA(name));
      await wait(800);
      const afterToggle = await layers();
      console.log('  再点同入口', again, '→', brief(afterToggle),
        (afterToggle.menu === before.menu && afterToggle.panel === before.panel && afterToggle.sideL === before.sideL) ? '✅ toggle 生效' : '❌ 无效');
    }
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
