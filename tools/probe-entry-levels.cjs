// 探测 DSH 页面内的层级结构：首页上每个入口点进去之后，是「同一页的浮层」还是「新的一层」。
//
// 判据（每一项都要有可观测证据，不靠猜）：
//   - overlayN：可见遮罩层/弹层数量（position:fixed|absolute 且覆盖 >300x300，z-index 有值）
//   - dialogN ：role=dialog / [aria-modal] 数量
//   - sideL   ：侧栏容器左边缘（收起时是负数）
//   - histLen ：history.length（SPA 内部切换通常不变，变了说明真入了历史栈）
//   - backCtl ：页面上"返回/关闭"类按钮文案（× / 返回 / 关闭 / 取消）
//   - head    ：正文前 90 字
//
// 用法：node probe-entry-levels.cjs [cdpPort] [单个入口 aria-label]
//   不带入口名 = 逐个走完预设入口清单
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

// 采样一次页面结构。所有判据都在这里算，调用方只看结果。
const SAMPLE = `(function(){
  try{
    var out={};
    var b=(document.body?document.body.innerText:'')||'';
    out.head=b.slice(0,90).replace(/\\n/g,' | ');
    out.histLen=history.length;
    out.tabs=(b.indexOf('对话')>=0&&b.indexOf('轨迹')>=0);
    out.hero=(b.indexOf('探索未至之境')>=0);
    var ov=0, ovCls=[];
    var dz=0, dCls=[];
    var all=document.querySelectorAll('div,[role=dialog]');
    for(var i=0;i<all.length;i++){
      var el=all[i];
      var cs=getComputedStyle(el);
      var r=el.getBoundingClientRect();
      if((cs.position==='fixed'||cs.position==='absolute')&&r.width>300&&r.height>300&&cs.display!=='none'&&cs.visibility!=='hidden'&&Number(cs.opacity)>0){
        ov++; if(ovCls.length<4) ovCls.push(((el.className||'')+'').slice(0,40));
      }
      if((el.getAttribute('role')==='dialog'||el.getAttribute('aria-modal')==='true')&&cs.display!=='none'){
        dz++; if(dCls.length<4) dCls.push(((el.className||'')+'').slice(0,40));
      }
    }
    out.overlayN=ov; out.overlayCls=ovCls;
    out.dialogN=dz; out.dialogCls=dCls;
    var side=document.querySelector('[class*="_sidebarCol"]');
    out.sideL=side?Math.round(side.getBoundingClientRect().left):null;
    var back=[];
    var btns=document.querySelectorAll('button,[role=button],a');
    for(var j=0;j<btns.length;j++){
      var t=(btns[j].innerText||btns[j].getAttribute('aria-label')||'').trim();
      if(!t) continue;
      if(/^(×|✕|返回|关闭|取消|←)/.test(t)||t.indexOf('返回')>=0||t.indexOf('关闭')>=0||t.indexOf('取消')>=0){
        var rr=btns[j].getBoundingClientRect();
        if(rr.width>0&&rr.height>0) back.push(t.slice(0,10));
      }
      if(back.length>=6) break;
    }
    out.backCtl=back;
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

// 每个入口的点击表达式：优先 aria-label 精确匹配，退回文案匹配。
function clickExpr(name) {
  return `(function(){
    var els=document.querySelectorAll('button,[role=button],a,div');
    var hit=null;
    for(var i=0;i<els.length;i++){
      var el=els[i];
      var al=el.getAttribute&&el.getAttribute('aria-label');
      if(al===${JSON.stringify(name)}){ hit=el; break; }
    }
    if(!hit){
      for(var i=0;i<els.length;i++){
        var el=els[i];
        var t=(el.innerText||'').trim();
        if(t===${JSON.stringify(name)}){ hit=el; break; }
      }
    }
    if(!hit) return 'not-found';
    hit.click();
    return 'clicked';
  })()`;
}

const ENTRIES = [
  '选择工作区',
  '添加文件或调用指令',
  '访问模式，当前：完全权限',
  '选择模型，当前 DeepSeek-V4.1-Flash · x0.11，推理等级 High',
  '账号菜单',
  '搜索会话',
  '展开会话知识库',
  '打开目录',
];

async function main() {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();

  const load = async () => {
    const raw = await ws.eval(SAMPLE);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { __raw: raw }; } }
    return raw;
  };

  const base = await load();
  console.log('=== 基线 ===');
  console.log(JSON.stringify(base, null, 1));

  const list = ONLY ? [ONLY] : ENTRIES;
  for (const name of list) {
    console.log(`\n=== 进入「${name}」 ===`);
    const r = await ws.eval(clickExpr(name));
    console.log('点击结果:', r);
    if (r !== 'clicked') continue;
    await new Promise((s) => setTimeout(s, 700));
    const after = await load();
    const delta = {
      overlayN: `${base.overlayN} -> ${after.overlayN}`,
      dialogN: `${base.dialogN} -> ${after.dialogN}`,
      sideL: `${base.sideL} -> ${after.sideL}`,
      histLen: `${base.histLen} -> ${after.histLen}`,
      tabs: `${base.tabs} -> ${after.tabs}`,
      hero: `${base.hero} -> ${after.hero}`,
    };
    console.log('变化:', JSON.stringify(delta));
    console.log('新图层:', JSON.stringify(after.overlayCls), '对话框:', JSON.stringify(after.dialogCls));
    console.log('返回控件:', JSON.stringify(after.backCtl));
    console.log('正文:', after.head);

    // 收尾：能点"取消/关闭/×"就点，点不动就用 Escape 派发，把页面还原到基线。
    const closeExpr = `(function(){
      var els=document.querySelectorAll('button,[role=button]');
      for(var i=0;i<els.length;i++){
        var t=(els[i].innerText||els[i].getAttribute('aria-label')||'').trim();
        if(t==='取消'||t==='关闭'||t==='×'||t==='✕'||t==='返回'){ els[i].click(); return 'closed:'+t; }
      }
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      return 'escape';
    })()`;
    console.log('复原:', await ws.eval(closeExpr));
    await new Promise((s) => setTimeout(s, 600));
    const back = await load();
    console.log('复原后:', JSON.stringify({ overlayN: back.overlayN, dialogN: back.dialogN, sideL: back.sideL, tabs: back.tabs, hero: back.hero }));
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
