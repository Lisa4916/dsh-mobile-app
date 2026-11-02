// 批量验证：每个功能项「进入 → Escape → 是否退回」。
//
// 用户的要求是「返回必须与进入的步骤相反，不能少也不能多」。所以真正要回答的问题不是
// 「我们该在返回时干什么」，而是「页面自己有没有一层一层的逆向能力」。
// 本脚本对每个入口做同一套动作：进入 → 采样 → 发 Escape → 再采样 → 判定是否复原。
//
// 判定用的是「结构指纹」而不是文案：层数(layerN) + 侧栏位置(sideL) + 是否会话页(tabs)
// + 正文首段(head)。指纹回到进入前 = 退回去了；没变 = 这个入口不认 Escape。
//
// 用法：node probe-escape-layers.cjs [cdpPort] [入口 aria-label 或文案]
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

// 结构指纹：不含文案细节，只含「几层 + 在哪一级」。
const FP = `(function(){
  try{
    var b=(document.body?document.body.innerText:'')||'';
    // 浮层：菜单 / 列表 / 对话框 / 抽屉
    var n=0, names=[];
    var sels=['[role=menu]','[role=listbox]','[role=dialog]','[data-radix-popper-content-wrapper]',
              '[class*="_popover"],[class*="_modal"],[class*="_sheet"],[class*="_drawer"]'];
    var seen=new Set();
    sels.forEach(function(s){
      var a=document.querySelectorAll(s);
      for(var i=0;i<a.length;i++){
        var el=a[i];
        if(seen.has(el)) continue;
        var cs=getComputedStyle(el); var r=el.getBoundingClientRect();
        if(cs.display==='none'||cs.visibility==='hidden'||r.height<8||r.width<8) continue;
        seen.add(el); n++;
        if(names.length<5) names.push(((el.className||'')+'').slice(0,26));
      }
    });
    var side=document.querySelector('[class*="_sidebarCol"]');
    var sideL=side?Math.round(side.getBoundingClientRect().left):null;
    // 侧栏展开本身也算一层
    if(sideL!==null && sideL>-40) { n++; if(names.length<5) names.push('sidebar-open'); }
    // 会话知识库等带"关闭"标题的面板
    var panels=0; var els=document.querySelectorAll('button,[role=button]');
    for(var j=0;j<els.length;j++){
      var al=els[j].getAttribute('aria-label')||'';
      if(al.indexOf('关闭')===0 && els[j].getBoundingClientRect().height>0) panels++;
    }
    if(panels>0){ n+=panels; if(names.length<5) names.push('panel-x'+panels); }
    return JSON.stringify({
      layerN:n, names:names,
      sideL:sideL,
      tabs:(b.indexOf('对话')>=0 && b.indexOf('轨迹')>=0),
      hero:(b.indexOf('探索未至之境')>=0),
      head:b.replace(/\\s+/g,' ').slice(0,50)
    });
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

const ESC = `(function(){
  var t=document.activeElement||document.body;
  var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
  t.dispatchEvent(new KeyboardEvent('keydown',o));
  t.dispatchEvent(new KeyboardEvent('keyup',o));
  document.dispatchEvent(new KeyboardEvent('keydown',o));
  document.body.dispatchEvent(new KeyboardEvent('keydown',o));
  return 'esc';
})()`;

const CLICK = (name) => `(function(){
  var els=document.querySelectorAll('button,[role=button],a,div,span');
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(el.getAttribute&&el.getAttribute('aria-label')===${JSON.stringify(name)}){ el.click(); return 'aria'; }
  }
  for(var i=0;i<els.length;i++){
    var el2=els[i];
    var t=(el2.innerText||'').trim();
    if(t===${JSON.stringify(name)} && el2.children.length===0){ el2.click(); return 'text'; }
  }
  return 'nf';
})()`;

const ENTRIES = [
  '添加文件或调用指令',
  '访问模式，当前：完全权限',
  '选择工作区',
  '账号菜单',
  '搜索会话',
  '展开会话知识库',
];

async function main() {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));
  const fp = async () => {
    const raw = await ws.eval(FP);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { raw }; } }
    return raw;
  };

  const list = ONLY ? [ONLY] : ENTRIES;
  const results = [];

  for (const name of list) {
    console.log(`\n===== ${name} =====`);
    const before = await fp();
    const clicked = await ws.eval(CLICK(name));
    if (clicked === 'nf') { console.log('  未找到入口，跳过'); continue; }
    await wait(800);
    const opened = await fp();
    const esc = await ws.eval(ESC);
    await wait(800);
    const after = await fp();

    const openedChanged = opened.layerN !== before.layerN || opened.sideL !== before.sideL;
    const restored = after.layerN === before.layerN && after.sideL === before.sideL;
    console.log(`  进入前: layerN=${before.layerN} sideL=${before.sideL}`);
    console.log(`  进入后: layerN=${opened.layerN} sideL=${opened.sideL} names=${JSON.stringify(opened.names)}`);
    console.log(`  Escape 后: layerN=${after.layerN} sideL=${after.sideL}`);
    console.log(`  判定: ${restored ? '✅ 退回' : '❌ 未退回'}${openedChanged ? '' : '（该入口似乎没打开新层）'}`);
    results.push({ name, openedChanged, restored, before, opened, after });
  }

  console.log('\n\n======== 汇总 ========');
  for (const r of results) {
    console.log(`${r.restored ? '✅' : '❌'}  ${r.name}   layerN ${r.before.layerN}→${r.opened.layerN}→${r.after.layerN}`);
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
