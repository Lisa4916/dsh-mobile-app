// 验证「当前最上面那一层是什么」的判据（DSH_LAYER_JS）在每种真实状态下都认得对。
//
// 背景：用户要求返回与进入严格互逆 —— 进几层就退几层。要做到「一次只退一层」，
// 必须先能准确回答「现在最上面压着哪一层」。这个脚本就是把候选判据拿到真机上逐态核实：
// 构造出每一种进入态，读一次 layer，看它报的是不是那一层。
//
// 判据的优先级必须是「视觉上压在最上面的先判」：
//   panel（有「关闭xxx」按钮的浮层） > overlay（role=menu/listbox/dialog） >
//   sidebar（左抽屉展开） > feature（侧栏功能视图） > session（会话页） > home（首页）
//
// 用法：node probe-layer.cjs [cdpPort]
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

// ==== 候选判据：与将要写进 WebViewFactory 的 DSH_LAYER_JS 保持一致 ====
const LAYER_JS = `(function(){
  try{
    function visible(el){
      if(!el) return false;
      var cs=getComputedStyle(el), r=el.getBoundingClientRect();
      if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)<0.05) return false;
      return r.width>8 && r.height>8;
    }
    // 1) 带「关闭xxx」按钮的浮层（会话知识库那种面板）
    var closers=document.querySelectorAll('button,[role=button]');
    for(var i=0;i<closers.length;i++){
      var al=closers[i].getAttribute('aria-label')||'';
      if(al.indexOf('关闭')===0 && visible(closers[i])) return 'panel';
    }
    // 2) 菜单 / 下拉 / 对话框
    var ov=document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]');
    for(var j=0;j<ov.length;j++) if(visible(ov[j])) return 'overlay';
    // 3) 左抽屉展开（实测收起态 left≈-209，展开态 0）
    var s=document.querySelector('[class*="_sidebarCol"]');
    if(s && s.getBoundingClientRect().left>-40) return 'sidebar';
    var b=(document.body?document.body.innerText:'')||'';
    if(b.length===0) return 'other';
    // 4) 会话页（「对话」「轨迹」这对 tab 只有会话页有）。
    //    ★ 必须排在 feature 之前：会话页也有 aria-selected="true"（就是「对话」那个 tab），
    //    若先判 feature 会把会话页当成功能视图 —— 实测就是这里判错了一次。
    if(b.indexOf('对话')!==-1 && b.indexOf('轨迹')!==-1) return 'session';
    // 5) 侧栏功能视图：靠 [aria-current] 认，首页/会话页都没有这个属性。
    //    功能视图里 aria-current 挂在侧栏入口上（侧栏收起也仍在 DOM 里），
    //    而会话页的 aria-selected 挂在主区域 tab 上 —— 两者用 hasTrack 已经分开了。
    var cur=document.querySelector('[aria-current="page"],[aria-current="true"],[aria-selected="true"]');
    if(cur){
      var t=((cur.getAttribute('aria-label')||cur.innerText||'')+'').trim();
      if(t && t!=='新会话') return 'feature';
    }
    // 6) 首页
    if(b.indexOf('探索未至之境')!==-1) return 'home';
    if(b.indexOf('描述你想要构建的内容')!==-1) return 'home';
    if(b.indexOf('发消息或创建任务')!==-1) return 'home';
    if(b.indexOf('选择一个工作区开始')!==-1) return 'home';
    return 'other';
  }catch(e){ return 'other'; }
})()`;

const CLICK_ARIA = (n) => `(function(){
  var e=document.querySelectorAll('button,[role=button],a,div');
  for(var i=0;i<e.length;i++) if(e[i].getAttribute&&e[i].getAttribute('aria-label')===${JSON.stringify(n)}){e[i].click();return 'ok';}
  return 'nf';
})()`;

const NEW_SESSION = `(function(){var n=document.querySelector('.wtg9ga_newSession');if(n){n.click();return 'ok';}return 'nf';})()`;
const ENTER_SESSION = `(function(){var r=document.querySelectorAll('.wnFoaW_sessionRow');if(!r.length)return 'no-rows';r[2].click();return 'ok';})()`;

async function main() {
  const t = await listTargets();
  const p = t.find((x) => x.type === 'page');
  if (!p) throw new Error('没有 page target');
  const ws = new WS(p.webSocketDebuggerUrl);
  await ws.connect();
  const layer = async () => ws.eval(LAYER_JS);

  // 每一层用「页面自己认的方式」关，别硬点「新会话」——菜单浮层会把点击吃掉，
  // 于是循环空转到次数上限，报「没能回到首页」（上一版就是这么假失败的）。
  const ESCAPE = `(function(){
    var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
    var t=document.activeElement||document.body||document.documentElement;
    t.dispatchEvent(new KeyboardEvent('keydown',o));
    t.dispatchEvent(new KeyboardEvent('keyup',o));
    return 'sent';
  })()`;

  const resetToHome = async () => {
    for (let i = 0; i < 10; i++) {
      const l = await layer();
      if (l === 'home') return true;
      if (l === 'overlay') { await ws.eval(ESCAPE); await wait(800); continue; }
      if (l === 'panel') {
        await ws.eval(`(function(){var bs=document.querySelectorAll('button,[role=button]');for(var i=0;i<bs.length;i++){var al=bs[i].getAttribute('aria-label')||'';var r=bs[i].getBoundingClientRect();if(al.indexOf('关闭')===0&&r.width>8){bs[i].click();return 'ok';}}return 'nf';})()`);
        await wait(800); continue;
      }
      // sidebar / feature / session → 点屏外「新会话」，不展开侧栏、视觉零动画
      await ws.eval(NEW_SESSION);
      await wait(1600);
    }
    return false;
  };

  const cases = [
    ['首页', async () => {}, 'home'],
    ['首页 + 侧栏展开', async () => { await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(900); }, 'sidebar'],
    ['首页 + 弹出菜单', async () => { await ws.eval(CLICK_ARIA('添加文件或调用指令')); await wait(900); }, 'overlay'],
    ['会话页 + 知识库面板', async () => {
      await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
      await ws.eval(ENTER_SESSION); await wait(2400);
      await ws.eval(CLICK_ARIA('收起侧边栏')); await wait(800);
      await ws.eval(CLICK_ARIA('展开会话知识库')); await wait(1100);
    }, 'panel'],
    ['功能视图（插件）+ 侧栏收起', async () => {
      await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
      await ws.eval(CLICK_ARIA('插件')); await wait(1500);
      await ws.eval(CLICK_ARIA('收起侧边栏')); await wait(900);
    }, 'feature'],
    ['功能视图（插件）+ 侧栏展开', async () => {
      await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
      await ws.eval(CLICK_ARIA('插件')); await wait(1500);
    }, 'sidebar'],
    ['会话页', async () => {
      await ws.eval(CLICK_ARIA('打开侧边栏')); await wait(800);
      await ws.eval(ENTER_SESSION); await wait(2400);
      await ws.eval(CLICK_ARIA('收起侧边栏')); await wait(800);
    }, 'session'],
  ];

  let bad = 0;
  for (const [name, build, expect] of cases) {
    const ok = await resetToHome();
    if (!ok) { console.log(`\n=== ${name} ===\n  ⚠ 没能回到首页，跳过`); continue; }
    await build();
    const got = await layer();
    const pass = got === expect;
    if (!pass) bad++;
    console.log(`\n=== ${name} ===\n  期望 ${expect} / 实际 ${got}  ${pass ? '✅' : '❌'}`);
  }
  console.log(`\n合计：${cases.length} 项，失败 ${bad} 项`);
  ws.close();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
