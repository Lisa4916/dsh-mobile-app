// 干净的两阶段测量：先按 BACK 收键盘并等稳定，再 tap 弹键盘，逐帧记录 composerTop。
// 判据：
//   1. composerTop 位移帧间隔中位数 <= 30ms（修复前 108ms）
//   2. 全程时长 <= 550ms（修复前 897ms）
//   3. 单调无回弹
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const PORT = 9222;
const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';
const SERIAL = '8PCE7LJB99VG7TRO';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshook = false, buf = Buffer.alloc(0), nextId = 1;
    const pending = new Map();
    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj)); const len = payload.length;
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) header = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      else { header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 4); }
      const mask = crypto.randomBytes(4); const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }
    function parseFrames() {
      while (buf.length >= 2) {
        const b1 = buf[1]; let len = b1 & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const frame = buf.subarray(off, off + len); buf = buf.subarray(off + len);
        try { const m = JSON.parse(frame.toString('utf8')); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
      }
    }
    sock.on('data', (chunk) => {
      if (!handshook) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n'); if (idx === -1) return;
        buf = buf.subarray(idx + 4); handshook = true;
        resolve({ call(method, params) { const id = nextId++; return new Promise((res) => { pending.set(id, res); send({ id, method, params }); }); }, close() { try { sock.destroy(); } catch {} } });
        parseFrames(); return;
      }
      buf = Buffer.concat([buf, chunk]); parseFrames();
    });
    sock.on('error', reject);
  });
}

function adb(args, timeout = 30000) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout }).trim();
}

const STATE = `(function(){
  var el = document.querySelector('[contenteditable="true"]');
  return JSON.stringify({
    ih: window.innerHeight,
    ct: el ? Math.round(el.getBoundingClientRect().top) : null,
    ime: (window.__dshNativeKeyboardState && window.__dshNativeKeyboardState()) || null
  });
})()`;

const LOCATE = `(function(){
  const els = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
  if (!els.length) return 'NOT_FOUND';
  const el = els[els.length-1]; const r = el.getBoundingClientRect();
  return JSON.stringify({ cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), innerW: window.innerWidth, innerH: window.innerHeight });
})()`;

const INSTALL = `(function(){
  window.__sm = [];
  window.__smOn = true;
  function tick(){
    if (!window.__smOn) return;
    var el = document.querySelector('[contenteditable="true"]');
    var r = document.getElementById('root');
    window.__sm.push({
      w: Date.now(),
      ih: window.innerHeight,
      ct: el ? Math.round(el.getBoundingClientRect().top) : null,
      rh: r ? Math.round(r.getBoundingClientRect().height) : null
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return 'ok';
})()`;

const COLLECT = `(function(){
  window.__smOn = false;
  var a = window.__sm || [];
  return JSON.stringify({ total: a.length, all: a });
})()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  // ---- 阶段 0：确保键盘是收起态 ----
  for (let i = 0; i < 3; i++) {
    const st = JSON.parse((await client.call('Runtime.evaluate', { expression: STATE, returnByValue: true })).result.result.value);
    if (st.ih >= 890) { console.log(`键盘已收起 innerH=${st.ih} composerTop=${st.ct}`); break; }
    console.log(`键盘还开着 innerH=${st.ih}，按 BACK 收起…`);
    adb(['shell', 'input keyevent 4']);
    await new Promise((r) => setTimeout(r, 900));
  }
  const st0 = JSON.parse((await client.call('Runtime.evaluate', { expression: STATE, returnByValue: true })).result.result.value);
  if (st0.ih < 890) { console.log('收不起来，放弃'); process.exit(1); }

  const loc = JSON.parse((await client.call('Runtime.evaluate', { expression: LOCATE, returnByValue: true })).result.result.value);
  const scale = 1080 / loc.innerW;
  const tapX = Math.round(loc.cx * scale);
  const tapY = Math.round(loc.cy * scale);
  console.log(`开始态 innerH=${loc.innerH} composerTop=${st0.ct} → tap(${tapX},${tapY})`);

  await client.call('Runtime.evaluate', { expression: INSTALL, returnByValue: true });
  await new Promise((r) => setTimeout(r, 200));

  const t0 = Date.now();
  adb(['shell', `input tap ${tapX} ${tapY}`]);
  await new Promise((r) => setTimeout(r, 2600));

  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const { total, all } = JSON.parse(raw);

  const marks = all.filter((s, i) => i === 0 || s.ih !== all[i-1].ih || s.ct !== all[i-1].ct || s.rh !== all[i-1].rh);
  console.log(`\n采样 ${total} 帧，变化点 ${marks.length} 条`);
  console.log('偏移ms  innerH  rootH  composerTop  帧间隔');
  let prev = null;
  for (const s of marks) {
    const gap = prev ? s.w - prev.w : null;
    console.log(`${String(s.w - t0).padStart(5)}  ${String(s.ih).padStart(5)}  ${String(s.rh).padStart(5)}  ${String(s.ct).padStart(6)}      ${gap === null ? '-' : gap}`);
    prev = s;
  }

  const moving = all.filter((s, i) => i > 0 && s.ct !== null && all[i-1].ct !== null && s.ct !== all[i-1].ct);
  const gaps = [];
  for (let i = 1; i < moving.length; i++) gaps.push(moving[i].w - moving[i-1].w);
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const span = moving.length ? moving[moving.length-1].w - moving[0].w : null;

  let monotonic = true;
  for (let i = 1; i < moving.length; i++) {
    if (moving[i].ct > moving[i-1].ct) { monotonic = false; break; }
  }

  console.log('\n=== 结论（键盘弹出，界面跟随）===');
  console.log(`composerTop 位移帧数 ${moving.length}，帧间隔中位数 ${med === null ? 'n/a' : med + 'ms'}（修复前 108ms）`);
  console.log(`全程时长 ${span === null ? 'n/a' : span + 'ms'}（修复前 897ms）`);
  console.log(`单调无回弹: ${monotonic ? '是' : '否'}`);
  const ok = med !== null && med <= 30 && monotonic && span !== null && span <= 550;
  console.log(`→ ${ok ? 'PASS：逐帧跟随，与键盘同步' : 'FAIL'}`);

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
