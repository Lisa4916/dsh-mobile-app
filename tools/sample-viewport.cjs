// 采样页面视口高度随键盘动画的变化，用来与原生 insets 曲线逐帧对齐。
//
// 做法：
//   1. 在页面里装一个 requestAnimationFrame 采样器，每帧记录
//      { wall: Date.now(), innerH, composerTop }；
//   2. adb input tap 点输入框；
//   3. 等动画结束，把采样数组取回来。
//
// 为什么要 wall clock：原生侧日志（logcat 的 DshIme）用的是 uptimeMillis，
// 页面里只有 performance.now()/Date.now()。两者不同源，但对齐只需要「同一面墙上的时刻」，
// 所以页面记 Date.now()，再用 logcat 行首的本地时间戳（精确到毫秒）对齐。
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const PORT = 9222;
const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';

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

function adb(args) {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout: 30000 }).trim();
}

// 采样器：连续 90 帧，只记录变化，避免噪声。
const INSTALL = `(function(){
  window.__vpSamples = [];
  window.__vpRunning = true;
  var last = -1;
  function tick(){
    if (!window.__vpRunning) return;
    var h = window.innerHeight;
    if (h !== last) {
      var el = document.querySelector('[contenteditable="true"]');
      var top = el ? Math.round(el.getBoundingClientRect().top) : null;
      window.__vpSamples.push({ wall: Date.now(), innerH: h, composerTop: top });
      last = h;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return 'installed';
})()`;

const COLLECT = `(function(){
  window.__vpRunning = false;
  return JSON.stringify(window.__vpSamples || []);
})()`;

const LOCATE = `(function(){
  const els = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
  if (!els.length) return 'NOT_FOUND';
  const el = els[els.length-1]; const r = el.getBoundingClientRect();
  return JSON.stringify({ cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2), innerW: window.innerWidth, innerH: window.innerHeight });
})()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }

  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  const loc = JSON.parse((await client.call('Runtime.evaluate', { expression: LOCATE, returnByValue: true })).result.result.value);
  const scale = 1080 / loc.innerW;
  const tapX = Math.round(loc.cx * scale);
  const tapY = Math.round(loc.cy * scale);
  console.log(`输入框 CSS(${loc.cx},${loc.cy}) innerH=${loc.innerH} → tap(${tapX},${tapY})`);

  const inst = (await client.call('Runtime.evaluate', { expression: INSTALL, returnByValue: true })).result.result.value;
  console.log('采样器:', inst);

  adb(['logcat', '-c']);
  // 第二个参数决定用哪种动作触发：默认点输入框（弹键盘），也可传 back（收键盘）。
  const action = process.argv[2] || 'tap';
  if (action === 'back') {
    adb(['shell', 'input keyevent 4']);
  } else {
    adb(['shell', `input tap ${tapX} ${tapY}`]);
  }
  await new Promise((r) => setTimeout(r, 2000));

  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const samples = JSON.parse(raw);
  console.log(`\n=== 页面视口采样（${samples.length} 个变化点）===`);
  const base = samples.length ? samples[0] : null;
  for (const s of samples) {
    const dt = base ? s.wall - base.wall : 0;
    const drop = base ? base.innerH - s.innerH : 0;
    console.log(`+${String(dt).padStart(4)}ms  innerH=${String(s.innerH).padStart(4)}  下降=${String(drop).padStart(4)}  composerTop=${s.composerTop}`);
  }

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
