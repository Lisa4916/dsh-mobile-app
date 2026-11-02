// 单独测「Escape 在每种层状态下到底能不能退一层」。
//
// 为什么要单测这一条：返回的实现要走「后进先出」，而最省事、最不会跟页面打架的退层方式
// 是让**页面自己**处理（它已经实现了 Escape = 退一层）。但实测发现它不是万能的：
//   · 侧栏抽屉、菜单/列表弹层 —— 页面自己收 ✅
//   · 「展开会话知识库」面板   —— Escape 无效 ❌
//   · 功能视图（插件/Purge…） —— Escape 无效，只能点「新会话」❌
// 所以这里把每种「进入态」都构造出来，发一次 Escape，看层签名有没有真的变。
//
// 用法：node probe-escape.cjs [cdpPort]
const http = require('http');
const { execFileSync } = require('child_process');
const { ADB, resolveSerial } = require('./device.cjs');

const PORT = process.argv[2] || '9222';
const SERIAL = resolveSerial(process.env.DEV_SERIAL);
const wait = (ms) => new Promise((s) => setTimeout(s, ms));

function adb(args) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim();
}

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
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); } }, 8000);
    });
  }
  async eval(expr) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.__timeout) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __error: 'js-exception' };
    return r.result && r.result.result ? r.result.result.value : r;
  }
  close() { try { this.sock.end(); } catch {} }
}

const FP = `(function(){
  try{
    function vis(el){
      if(!el) return false;
      var cs=getComputedStyle(el), r=el.getBoundingClientRect();
      return cs.display!=='none' && cs.visibility!=='hidden' && Number(cs.opacity)>0.05 && r.width>8 && r.height>8;
    }
    var b=(document.body?document.body.innerText:'')||'';
    var out={ bodyLen:b.length };
    var menu=0, ms=document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]');
    for(var i=0;i<ms.length;i++) if(vis(ms[i])) menu++;
    out.menu=menu;
    var panel=0, bs=document.querySelectorAll('button,[role=button]');
    for(var j=0;j<bs.length;j++){
      var al=bs[j].getAttribute('aria-label')||'';
      if(al.indexOf('关闭')===0 && vis(bs[j])) panel++;
    }
    out.panel=panel;
    var s=document.querySelector('[class*="_sidebarCol"]');
    out.sideL = s?Math.round(s.getBoundingClientRect().left):null;
    out.sideOpen = out.sideL!==null && out.sideL>-40;
    var tabs=(b.indexOf('对话')>=0 && b.indexOf('轨迹')>=0);
    var hero=(b.indexOf('探索未至之境')>=0);
    var cur=document.querySelector('[aria-current="page"],[aria-current="true"],[aria-selected="true"]');
    var curTxt=cur?((cur.getAttribute('aria-label')||cur.innerText||'')+'').trim().slice(0,10):'';
    out.cur=curTxt;
    var base;
    if(tabs) base='session';
    else if(hero) base='home';
    else if(curTxt && curTxt!=='新会话') base='feature:'+curTxt;
    else base='other';
    out.base=base;
    out.sig=[base,'side'+(out.sideOpen?1:0),'panel'+out.panel,'menu'+out.menu].join('|');
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

const CLICK_ARIA = (n) => `(function(){
  var e=document.querySelectorAll('button,[role=button],a,div');
  for(var i=0;i<e.length;i++) if(e[i].getAttribute&&e[i].getAttribute('aria-label')===${JSON.stringify(n)}){e[i].click();return 'ok';}
  return 'nf';
})()`;

const NEW_SESSION = `(function(){var n=document.querySelector('.wtg9ga_newSession');if(n){n.click();return 'ok';}return 'nf';})()`;

const ENTER_SESSION = `(function(){
  var rows=document.querySelectorAll('.wnFoaW_sessionRow');
  if(!rows.length) return 'no-rows';
  rows[2].click(); return 'ok';
})()`;

// 用真实的键盘事件路径发 Escape：页面多半监听 document/window 的 keydown。
const ESCAPE = `(function(){
  var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
  var t=document.activeElement||document.body||document.documentElement;
  t.dispatchEvent(new KeyboardEvent('keydown',o));
  t.dispatchEvent(new KeyboardEvent('keyup',o));
  return 'sent';
})()`;

async function main() {
  const connect = async () => {
    const t = await listTargets();
    const p = t.find((x) => x.type === 'page');
    if (!p) throw new Error('没有 page target');
    const ws = new WS(p.webSocketDebuggerUrl);
    await ws.connect();
    return ws;
  };

  const S = async (ws) => {
    const raw = await ws.eval(FP);
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { sig: '(parse-fail)' }; } }
    return { sig: '(bad)' };
  };

  let ws = await connect();
  const cases = [
    {
      name: '1. 首页 + 侧栏展开',
      build: async () => { await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(900); },
    },
    {
      name: '2. 首页 + 弹出菜单（添加文件）',
      build: async () => { await ws.eval(CLICK_ARIA('添加文件或调用指令')); await wait(900); },
    },
    {
      name: '3. 首页 + 会话知识库面板',
      build: async () => { await ws.eval(CLICK_ARIA('展开会话知识库')); await wait(1000); },
    },
    {
      name: '4. 功能视图（插件）+ 侧栏展开',
      build: async () => {
        await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
        await ws.eval(CLICK_ARIA('插件')); await wait(1400);
      },
    },
    {
      name: '5. 会话页',
      build: async () => {
        await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
        await ws.eval(ENTER_SESSION); await wait(2400);
        const s = await S(ws);
        if (s.sideOpen) { await ws.eval(CLICK_ARIA('收起侧边栏')); await wait(800); }
      },
    },
    {
      name: '6. 会话页 + 侧栏展开',
      build: async () => {
        const s0 = await S(ws);
        if (!String(s0.base).startsWith('session')) {
          await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
          await ws.eval(ENTER_SESSION); await wait(2400);
        }
        await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(900);
      },
    },
  ];

  // 每个 case 结束后都要把状态清回首页，否则后面的 case 起点不对。
  const resetToHome = async () => {
    for (let i = 0; i < 3; i++) {
      const s = await S(ws);
      if (s.base === 'home' && !s.sideOpen && s.panel === 0 && s.menu === 0) return true;
      if (s.panel > 0) { await ws.eval(`(function(){var bs=document.querySelectorAll('button,[role=button]');for(var i=0;i<bs.length;i++){var al=bs[i].getAttribute('aria-label')||'';var r=bs[i].getBoundingClientRect();if(al.indexOf('关闭')===0&&r.width>8){bs[i].click();return 'ok';}}return 'nf';})()`); await wait(700); continue; }
      if (s.sideOpen) { await ws.eval(NEW_SESSION); await wait(1500); continue; }
      await ws.eval(NEW_SESSION); await wait(1500);
    }
    return false;
  };

  for (const c of cases) {
    console.log(`\n=== ${c.name} ===`);
    await resetToHome();
    await c.build();
    const before = await S(ws);
    await ws.eval(ESCAPE);
    await wait(1100);
    const after = await S(ws);
    const changed = before.sig !== after.sig;
    console.log(`  Escape 前: ${before.sig}  (body ${before.bodyLen})`);
    console.log(`  Escape 后: ${after.sig}  (body ${after.bodyLen})`);
    console.log(`  结论     : ${changed ? 'Escape 有效 ✅' : 'Escape 无效 ❌'}`);
  }

  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
