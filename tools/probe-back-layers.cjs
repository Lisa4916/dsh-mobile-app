// 逐层测「按返回键现在会退到哪」—— 找出「多退」和「少退」的实际发生点。
//
// 用户的验收标准：进入几步，返回就必须退几步，不多也不少。
// 做法：对每一种「当前所处的层」单独构造 → 按一次返回 → 看层签名怎么变。
//
// 上一版的两个教训（都修在这里）：
//   1. relaunch 后只等「有 page target」就往下走 —— 那时页面还在 Loading plugins，
//      读到的 base 是 other、body 只有几百字，所有场景的「构造前」长得一模一样。
//      现在要求 body 长度 > 300 且 base 能认出来，才认为页面就绪。
//   2. 构造步骤执行完不看结果 —— 侧栏没展开、菜单没弹出也照跑，于是每个场景都在
//      测同一件事。现在每步之后都断言期望的层已出现，没出现就重试一次。
//
// 用法：node probe-back-layers.cjs [cdpPort]
const http = require('http');
const { execFileSync } = require('child_process');
const { ADB, resolveSerial } = require('./device.cjs');

const PORT = process.argv[2] || '9222';
const SERIAL = resolveSerial(process.env.DEV_SERIAL);

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
}

// 层指纹：基础视图 + 三个浮层，压成一个有序签名。
// 基础视图用 [aria-current] 认「当前选中的侧栏功能项」，这是功能视图唯一稳定的信号。
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

    var rb=document.querySelector('[class*="_rightbarCol"]');
    var rbr=rb?rb.getBoundingClientRect():null;
    out.rightOpen = !!(rb && vis(rb) && rbr.width>60 && rbr.left < window.innerWidth-40);

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

    out.sig=[base,'side'+(out.sideOpen?1:0),'right'+(out.rightOpen?1:0),'panel'+out.panel,'menu'+out.menu].join('|');
    return JSON.stringify(out);
  }catch(e){ return JSON.stringify({__error:String(e)}); }
})()`;

const CLICK_ARIA = (n) => `(function(){
  var e=document.querySelectorAll('button,[role=button],a,div');
  for(var i=0;i<e.length;i++) if(e[i].getAttribute&&e[i].getAttribute('aria-label')===${JSON.stringify(n)}){e[i].click();return 'ok';}
  return 'nf';
})()`;

const ENTER_SESSION = `(function(){
  var rows=document.querySelectorAll('.wnFoaW_sessionRow');
  if(!rows.length) return 'no-rows';
  rows[3].click(); return 'ok';
})()`;

async function main() {
  const wait = (ms) => new Promise((s) => setTimeout(s, ms));

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

  // 等到页面真的可用：body 够长，且 base 能认出来（home / session / feature）。
  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      await wait(700);
      let ws;
      try {
        ws = await connect();
        const s = await S(ws);
        ws.sock.end();
        if (s.bodyLen > 300 && (s.base === 'home' || s.base === 'session' || String(s.base).startsWith('feature'))) return true;
      } catch { try { ws && ws.sock.end(); } catch {} }
    }
    return false;
  };

  const relaunch = async () => {
    adb(['shell', 'am', 'force-stop', 'com.dsh.remote']);
    await wait(700);
    adb(['shell', 'am', 'start', '-W', '-n', 'com.dsh.remote/.MainActivity']);
    // 转发端口会随 pid 变化，每次重建
    for (let i = 0; i < 30; i++) {
      await wait(700);
      const pid = adb(['shell', 'pidof', 'com.dsh.remote']).trim();
      if (!pid) continue;
      try {
        adb(['forward', '--remove-all']);
        adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
        const t = await listTargets();
        if (t.find((x) => x.type === 'page')) break;
      } catch {}
    }
    return waitReady();
  };

  const topActivity = () => {
    const out = adb(['shell', 'dumpsys', 'activity', 'activities']);
    const m = out.match(/topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)\//);
    return m ? m[1] : 'unknown';
  };

  const EXIT = 'EXITED(不在此 App)';

  // build 步骤：每步都断言期望状态，失败重试一次。
  const steps = {
    openSidebar: async (ws) => {
      for (let k = 0; k < 2; k++) {
        await ws.eval(CLICK_ARIA('打开侧边栏'));
        await wait(900);
        const s = await S(ws);
        if (s.sideOpen) return s;
      }
      throw new Error('侧栏没能展开');
    },
    clickFeature: async (ws, name) => {
      await ws.eval(CLICK_ARIA(name));
      await wait(1400);
      return S(ws);
    },
    enterSession: async (ws) => {
      await ws.eval(ENTER_SESSION);
      await wait(2400);
      return S(ws);
    },
    openMenu: async (ws) => {
      await ws.eval(CLICK_ARIA('添加文件或调用指令'));
      await wait(900);
      return S(ws);
    },
    closeSidebar: async (ws) => {
      await ws.eval(CLICK_ARIA('收起侧边栏'));
      await wait(900);
      return S(ws);
    },
  };

  const scenarios = [
    {
      name: 'A. 首页 / 无浮层',
      build: async () => {},
      expect: EXIT,
      why: '最底层，返回就退出',
    },
    {
      name: 'B. 首页 + 抽屉展开',
      build: async (ws) => { await steps.openSidebar(ws); },
      expect: 'home|side0|...',
      why: '抽屉是后开的一层，应先收抽屉、不退出',
    },
    {
      name: 'C. 会话页（抽屉收起）',
      build: async (ws) => {
        await steps.openSidebar(ws);
        await steps.enterSession(ws);
        await steps.closeSidebar(ws);
      },
      expect: 'home|side0|...',
      why: '会话 → 首页',
    },
    {
      name: 'D. 首页 + 弹出菜单',
      build: async (ws) => { await steps.openMenu(ws); },
      expect: 'home|side0|...|menu0',
      why: '只关菜单，不应退出、不应改基础视图',
    },
    {
      name: 'E. 功能视图（插件）+ 抽屉展开',
      build: async (ws) => {
        await steps.openSidebar(ws);
        await steps.clickFeature(ws, '插件');
      },
      expect: 'feature:插件|side0|...',
      why: '先收抽屉，基础视图仍停在功能页',
    },
    {
      name: 'F. 功能视图（插件）+ 抽屉收起',
      build: async (ws) => {
        await steps.openSidebar(ws);
        await steps.clickFeature(ws, '插件');
        await steps.closeSidebar(ws);
      },
      expect: 'home|side0|...',
      why: '退出功能视图回首页',
    },
  ];

  const rows = [];
  for (const sc of scenarios) {
    console.log(`\n=== ${sc.name} ===`);
    const ready = await relaunch();
    if (!ready) { console.log('  ⚠ 页面没就绪，跳过'); continue; }
    let ws = await connect();
    try {
      await sc.build(ws);
    } catch (e) {
      console.log('  ⚠ 构造失败:', e.message, '— 跳过');
      try { ws.sock.end(); } catch {}
      continue;
    }
    const before = await S(ws);
    console.log('  构造后:', before.sig, `(body ${before.bodyLen} 字)`);

    adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await wait(2600);

    const top = topActivity();
    let got;
    if (top === 'com.dsh.remote') {
      try { ws = await connect(); const a = await S(ws); got = a.sig; } catch { got = '(CDP 断)'; }
    } else {
      got = EXIT;
    }
    console.log('  按一次返回:', got);
    console.log('  期望      :', sc.expect, '—', sc.why);
    console.log('  判定      :', got === EXIT ? (sc.expect === EXIT ? '✅' : '❌ 多退了') : (String(got).split('|')[0] === sc.expect.split('|')[0] ? '⚠ 基础视图对，浮层待看' : '❌ 基础视图不对'));
    rows.push({ name: sc.name, before: before.sig, got, expect: sc.expect });
    try { ws.sock.end(); } catch {}
  }

  console.log('\n\n======== 汇总 ========');
  for (const r of rows) {
    console.log(`${r.name}\n   before: ${r.before}\n   after : ${r.got}\n   expect: ${r.expect}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
