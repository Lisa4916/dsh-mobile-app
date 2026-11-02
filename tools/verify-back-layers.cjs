// 真机验证「返回与进入严格互逆」：逐层构造进入态，按一次返回，看是否**只退一层**。
//
// 用户契约（m04570 / m04585）：「返回要与进入的步骤相反，不能缺少步骤也不能多」，
// 「无论进入哪个功能项都应如此」。所以判据只能是逐层比对：
//   构造 → 读层 → 按返回 → 读层 → 期望落在**紧邻的下一层**，且不能一退到底。
//
// 用法：node verify-back-layers.cjs [cdpPort]
const http = require('http');
const { execFileSync } = require('child_process');
const { ADB, resolveSerial } = require('./device.cjs');

const PORT = process.argv[2] || '9222';
const SERIAL = resolveSerial(process.env.DEV_SERIAL);
const wait = (ms) => new Promise((s) => setTimeout(s, ms));
const adb = (args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim();

function listTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    // App 在后台时 WebView 被冻结，/json 会一直挂着 —— 必须自己超时，
    // 否则 attach 的 40 次重试能拖到 200 秒，外面看着就是脚本卡死。
    req.setTimeout(2500, () => { req.destroy(new Error('cdp-json-timeout')); });
    req.on('error', reject);
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

// 与 WebViewFactory.DSH_LOCATION_JS 完全一致的判据（逐字同步，避免测的和跑的不是同一个东西）
const LAYER_JS = `(function(){
  try{
    function visible(el){
      if(!el) return false;
      var cs=getComputedStyle(el), r=el.getBoundingClientRect();
      if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)<0.05) return false;
      return r.width>8 && r.height>8;
    }
    var closers=document.querySelectorAll('button,[role=button]');
    for(var i=0;i<closers.length;i++){
      var al=closers[i].getAttribute('aria-label')||'';
      if(al.indexOf('关闭')===0 && visible(closers[i])) return 'panel';
    }
    var ov=document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]');
    for(var j=0;j<ov.length;j++) if(visible(ov[j])) return 'overlay';
    var s=document.querySelector('[class*="_sidebarCol"]');
    if(s && s.getBoundingClientRect().left>-40) return 'sidebar';
    var b=(document.body?document.body.innerText:'')||'';
    if(b.length===0) return 'other';
    if(b.indexOf('对话')!==-1 && b.indexOf('轨迹')!==-1) return 'session';
    var cur=document.querySelector('[aria-current="page"],[aria-current="true"],[aria-selected="true"]');
    if(cur){
      var t=((cur.getAttribute('aria-label')||cur.innerText||'')+'').trim();
      if(t && t!=='新会话') return 'feature';
    }
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
const ESCAPE = `(function(){
  var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
  var t=document.activeElement||document.body||document.documentElement;
  t.dispatchEvent(new KeyboardEvent('keydown',o));
  t.dispatchEvent(new KeyboardEvent('keyup',o));
  return 'sent';
})()`;

async function main() {
  let ws = null;
  let curPid = null;

  // App 每次 force-stop / 崩溃后 pid 都会变，webview_devtools_remote_<pid> 也跟着变。
  // 不重建转发时所有 evaluateJavascript 都会 8 秒超时 —— 看起来就像脚本卡死（踩过）。
  // force=true 用于「App 刚从后台回到前台」：pid 没变，但后台期间 WebView 被冻结，
  // 旧 WebSocket 已经废了，必须重建，否则每条求值都吃满 8 秒超时。
  const attach = async (force) => {
    const pid = adb(['shell', 'pidof', 'com.dsh.remote']).trim();
    if (!pid) throw new Error('App 没在跑');
    if (!force && pid === curPid && ws) return;
    if (ws) { ws.close(); ws = null; }
    curPid = null;
    adb(['forward', '--remove-all']);
    adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
    for (let i = 0; i < 30; i++) {
      try {
        const t = await listTargets();
        const p = t.find((x) => x.type === 'page');
        if (p) {
          const s = new WS(p.webSocketDebuggerUrl);
          await s.connect();
          ws = s; curPid = pid;
          return;
        }
      } catch { /* 还没有 page target，继续等 */ }
      await wait(500);
    }
    throw new Error('没法连上 CDP（port ' + PORT + '）');
  };

  const layer = async () => ws.eval(LAYER_JS);

  await attach();

  const resetToHome = async () => {
    for (let i = 0; i < 10; i++) {
      const l = await layer();
      if (l === 'home') return true;
      if (l === 'overlay') { await ws.eval(ESCAPE); await wait(800); continue; }
      if (l === 'panel') {
        await ws.eval(`(function(){var bs=document.querySelectorAll('button,[role=button]');for(var i=0;i<bs.length;i++){var al=bs[i].getAttribute('aria-label')||'';var r=bs[i].getBoundingClientRect();if(al.indexOf('关闭')===0&&r.width>8){bs[i].click();return 'ok';}}return 'nf';})()`);
        await wait(800); continue;
      }
      await ws.eval(NEW_SESSION);
      await wait(1600);
    }
    return false;
  };

  // ★ 判「App 在不在前台」只能看 topResumedActivity 那一行。
  //   dumpsys activity activities 的整段输出里还留着历史 ActivityRecord，
  //   用整段 indexOf('com.dsh.remote') 判断会把「已经退到桌面」当成「还在前台」，
  //   然后拿一个后台 WebView 反复求值、永远等不到 home —— 上一版就是这么空转卡死的。
  const foreground = () => {
    const out = adb(['shell', 'dumpsys', 'activity', 'activities']);
    const line = out.split('\n').find((l) => l.indexOf('topResumedActivity') !== -1) || '';
    const m = line.match(/u0 ([^\s}]+)/);
    return m ? m[1] : '(? )';
  };
  const inForeground = () => foreground().indexOf('com.dsh.remote') !== -1;

  // 首页按返回会真的退出 App（这正是待验的契约之一）—— 退出了就重新拉起来并重建转发
  const ensureApp = async () => {
    if (!inForeground()) {
      adb(['shell', 'am', 'start', '-n', 'com.dsh.remote/.MainActivity']);
      await wait(2500);
    }
    await attach(true);
    for (let i = 0; i < 30; i++) {
      const l = await layer();
      if (l === 'home' || l === 'session') return;
      await wait(500);
    }
  };

  // 侧栏展开：点一次 aria-label，然后**确认真的展开**（left 从 -209 变成 0）才继续
  const openSidebar = async () => {
    for (let i = 0; i < 3; i++) {
      await ws.eval(CLICK_ARIA('打开侧边栏'));
      await wait(900);
      if ((await layer()) === 'sidebar') return true;
    }
    return false;
  };

  // 进功能视图：功能页入口不在侧栏上，在侧栏「更多」菜单里。
  // 实测侧栏有这些 aria-label：打开侧边栏 / 新建会话 / 更多 / 搜索会话 / 展开会话知识库 /
  // 导出会话日志 / 账号菜单 —— 里面没有「插件」，硬点会 nf（上一版就是这么卡住的）。
  const enterFeature = async (name) => {
    if (!(await openSidebar())) return false;
    for (let i = 0; i < 3; i++) {
      await ws.eval(CLICK_ARIA('更多'));
      await wait(1000);
      const hit = await ws.eval(`(function(){
        var els=document.querySelectorAll('[role=menu] button,[role=menu] [role=menuitem],[role=menu] a');
        for(var i=0;i<els.length;i++){
          if(((els[i].innerText||'')+'').trim()===${JSON.stringify(name)}){
            var r=els[i].getBoundingClientRect(); if(r.width>8){ els[i].click(); return 'ok'; }
          }
        }
        return 'nf';
      })()`);
      if (hit === 'ok') { await wait(1800); return true; }
      await wait(600);
    }
    return false;
  };

  // 进会话页：确认侧栏开着 → 点第 3 条会话 → 确认 tabs 出现
  const enterSession = async () => {
    if (!(await openSidebar())) return false;
    for (let i = 0; i < 3; i++) {
      await ws.eval(ENTER_SESSION);
      await wait(2400);
      if ((await layer()) === 'session') return true;
    }
    return false;
  };

  const collapseSidebar = async () => {
    for (let i = 0; i < 3; i++) {
      await ws.eval(CLICK_ARIA('收起侧边栏'));
      await wait(800);
      if ((await layer()) !== 'sidebar') return true;
    }
    return false;
  };

  const openPanel = async () => {
    for (let i = 0; i < 3; i++) {
      await ws.eval(CLICK_ARIA('展开会话知识库'));
      await wait(1200);
      if ((await layer()) === 'panel') return true;
    }
    return false;
  };

  // 每项：构造进入态 → 期望的层 → 按一次返回 → 期望落在哪一层（null 表示期望退出 App）
  const cases = [
    ['首页 + 弹出菜单',
      async () => { await ws.eval(CLICK_ARIA('添加文件或调用指令')); await wait(900); return (await layer()) === 'overlay'; },
      'overlay', 'home'],
    ['首页 + 侧栏展开',
      async () => openSidebar(),
      'sidebar', 'home'],
    ['功能视图（插件）',
      async () => (await enterFeature('插件')) && (await collapseSidebar()),
      'feature', 'home'],
    ['功能视图（插件）+ 侧栏展开',
      async () => enterFeature('插件'),
      'sidebar', 'feature'],
    ['会话页',
      async () => (await enterSession()) && (await collapseSidebar()),
      'session', 'home'],
    ['会话页 + 侧栏展开',
      // 进会话后页面会把抽屉收回去（实测 sideL 回到 -209），所以要再开一次
      async () => (await enterSession()) && (await openSidebar()),
      'sidebar', 'session'],
    ['会话页 + 知识库面板',
      async () => (await enterSession()) && (await collapseSidebar()) && (await openPanel()),
      'panel', 'session'],
  ];

  let bad = 0;
  for (const [name, build, expectLayer, expectAfter] of cases) {
    await ensureApp();
    let ok = await resetToHome();
    if (!ok) { await ensureApp(); ok = await resetToHome(); }
    if (!ok) { console.log(`\n=== ${name} ===\n  ⚠ 没能回到首页，跳过`); continue; }
    const built = await build();
    const before = await layer();
    if (!built || before !== expectLayer) {
      // 构造没成功就不许判产品对错 —— 上一版就是这么把「点插件没点上」记成了产品缺陷
      console.log(`\n=== ${name} ===\n  ⚠ 构造失败（实际停在 ${before}），跳过`);
      continue;
    }

    // 用真实返回键（不是直接调 JS）：要验的正是「按返回键之后 App 做了什么」
    adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await wait(2600);

    const fg = foreground();
    const after = await layer();

    const stillOurs = fg.indexOf('com.dsh.remote') !== -1;
    const pass = stillOurs
      ? after === expectAfter
      : expectAfter === null;
    if (!pass) bad++;
    console.log(`\n=== ${name} ===`);
    console.log(`  按返回前 ${before}（期望 ${expectLayer}）`);
    console.log(`  按返回后 ${stillOurs ? after : '已退出 App'}（期望 ${expectAfter === null ? '退出 App' : expectAfter}）`);
    console.log(`  ${pass ? '✅ 只退了一层' : '❌ 层数不对'}`);
  }
  console.log(`\n合计：${cases.length} 项，失败 ${bad} 项`);
  ws.close();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
