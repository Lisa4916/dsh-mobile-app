// 探测「在会话页把 DSH 切回开始界面」的轻量路径。
//
// 问题背景：当前实现用 `location.reload()`，视觉上等于「退出软件再重进」（用户指出两次）。
//
// 关键判据：**页面上打一个非落盘标记**（挂 window）。reload 会丢，视图切换不会。
// 于是可以严格区分「真的切了视图」与「整页重来」。
//
// 探测策略：对每个候选操作，执行 → 等 → 读 (位置, 标记是否还在)。命中条件：
//   位置变成 home 且 标记仍在 → 这就是轻量路径。
//
// 用法：node tools/probe-home-entry.mjs
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 9222;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.nextId = 1; this.waiters = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.host, port: this.port, path: this.path,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.sock = socket; socket.on('data', (d) => this.onData(d)); socket.on('error', () => {}); resolve();
      });
      req.on('error', reject); req.end();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; const hi = this.buf.readUInt32BE(off); const lo = this.buf.readUInt32BE(off + 4); len = hi * 0x100000000 + lo; off += 8; }
      let maskKey = null;
      if (masked) { if (this.buf.length < off + 4) return; maskKey = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x1) {
        let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) { const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); w(msg); }
      }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8'); const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    const mask = crypto.randomBytes(4); const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve); this.send({ id, method, params });
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

const evalJs = async (ws, expr) => {
  try {
    const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  } catch { return '<nav>'; }
};

// 位置判定（与 App 内 DSH_LOCATION_JS 同口径）
const WHERE = `(function(){
  var b=(document.body?document.body.innerText:'')||'';
  var t=b.indexOf('对话')!==-1&&b.indexOf('轨迹')!==-1;
  return t?'session':(b.indexOf('探索未至之境')!==-1?'home':'other');
})()`;

const snapshot = async (ws) => ({
  where: await evalJs(ws, WHERE),
  // 标记：写在 window 上，reload 必然丢失
  markKept: !!(await evalJs(ws, 'window.__probeMark === 12345')),
  href: await evalJs(ws, 'location.href'),
});

async function main() {
  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');
  await ws.call('Page.enable');

  const start = await snapshot(ws);
  console.log(`起始: where=${start.where}  mark=${start.markKept}`);
  if (start.where !== 'session') {
    console.log('!! 当前不在会话页，请先进入一个会话再跑本探测');
    ws.sock.end(); process.exit(2);
  }

  // 列可供探测的候选：先看会话页有哪些可能「退出当前会话」的控件
  const candidates = await evalJs(ws, `(function(){
    var out=[];
    document.querySelectorAll('button,a,[role=button]').forEach(function(n){
      var r=n.getBoundingClientRect();
      if(r.width<10||r.height<10||r.x<0||r.y<0) return;
      var txt=(n.textContent||'').trim().slice(0,14);
      out.push(txt ? (txt+' ['+(n.className||'').toString().slice(0,22)+']') : ('(无文字) ['+(n.className||'').toString().slice(0,26)+']'));
    });
    return out.join('\\n');
  })()`);
  console.log('\n会话页可见控件：\n' + candidates);

  // 候选操作：逐个试，每个都重新打标记
  const trials = [
    {
      name: 'DSH 顶部会话切换器 (mOxcpG_main)',
      run: `(function(){var b=document.querySelector('.mOxcpG_main'); if(!b) return 'not-found'; b.click(); return 'clicked';})()`,
    },
    {
      name: 'DSH 顶部 chevron (mOxcpG_chevron)',
      run: `(function(){var b=document.querySelector('.mOxcpG_chevron'); if(!b) return 'not-found'; b.click(); return 'clicked';})()`,
    },
    {
      name: '侧栏「新会话」按钮 (wtg9ga_newSession)',
      run: `(function(){var b=document.querySelector('.wtg9ga_newSession'); if(!b) return 'not-found'; b.click(); return 'clicked';})()`,
    },
    {
      name: '侧栏切换按钮 (wtg9ga_toggl)',
      run: `(function(){var b=document.querySelector('.wtg9ga_toggl'); if(!b) return 'not-found'; b.click(); return 'clicked';})()`,
    },
    {
      name: '顶部返回类按钮（无类名的 headerActions 内）',
      run: `(function(){
        var out=document.querySelector('.an3WzG_headerActions');
        if(!out) return 'not-found';
        var b=out.querySelectorAll('button');
        for(var i=0;i<b.length;i++){ if(!b[i].className){ b[i].click(); return 'clicked-idx'+i; } }
        return 'no-blank-button';
      })()`,
    },
    {
      name: '模拟 ESC 键（部分前端绑定）',
      run: `(function(){
        ['keydown','keyup'].forEach(function(t){
          window.dispatchEvent(new KeyboardEvent(t,{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));
        });
        return 'dispatched';
      })()`,
    },
  ];

  const results = [];
  for (const t of trials) {
    // 打标记 + 记录当前状态
    await evalJs(ws, 'window.__probeMark = 12345; "marked"');
    const before = await snapshot(ws);
    const act = await evalJs(ws, t.run);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await snapshot(ws);

    const verdict = (after.where === 'home' && after.markKept) ? 'LIGHT-SWITCH ✓'
      : (after.where === 'home' && !after.markKept) ? 'RELOAD（不可用）'
      : (after.where === 'session') ? '无变化'
      : `其他(${after.where})`;

    results.push({ name: t.name, act, before: before.where, after: after.where, mark: after.markKept, verdict });
    console.log(`\n[${t.name}]`);
    console.log(`  action=${act}  ${before.where} → ${after.where}  markKept=${after.markKept}`);
    console.log(`  → ${verdict}`);

    // 若已切到 home，且标记还在，说明找到轻量路径，直接收工
    if (verdict === 'LIGHT-SWITCH ✓') {
      console.log('\n*** 找到轻量路径 ***');
      break;
    }
    // 若页面被重载（标记丢失），需要重新进会话才能继续试下一个
    if (!after.markKept) {
      console.log('  （页面被重载，探测中断）');
      break;
    }
  }

  const hit = results.find((r) => r.verdict === 'LIGHT-SWITCH ✓');
  if (!hit) {
    console.log('\n未找到轻量路径。已尝试：' + results.map((r) => r.name).join(' / '));
    console.log('结论：这些 UI 控件都不是「回开始界面」的入口，需要另找（例如前端未暴露的 API）。');
  }

  ws.sock.end();
  process.exit(hit ? 0 : 1);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
