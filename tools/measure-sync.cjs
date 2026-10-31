// 同钟对齐：把「原生每帧设的 bottomMargin」与「页面 innerHeight 实际变化」放在一条时间线上。
//
// 背景：页面侧采样器只在数值变化时记一条，第一条样本是安装那一刻（innerH 还是原值），
// 所以「+0ms 到 +391ms 都是 895」并不能证明延迟——它包含了 tap 之前的等待。
// 要证明或推翻「传导延迟」，必须两边都用 Date.now() 这条同一面墙上的时钟。
//
// 原生侧在 applyKeyboardHeight 里打了：DshSync apply h=<px> wall=<ms> up=<ms>
// 所以从 logcat 消息体里就能直接取到 wall，不怕 logcat 时间戳格式问题。
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

function adb(args, timeout = 30000) {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout }).trim();
}

// 每帧都采样（不是只采变化点），才能看清「原生已经改了、页面还没改」的区间。
const INSTALL = `(function(){
  window.__syncSamples = [];
  window.__syncRunning = true;
  function tick(){
    if (!window.__syncRunning) return;
    var el = document.querySelector('[contenteditable="true"]');
    window.__syncSamples.push({
      wall: Date.now(),
      innerH: window.innerHeight,
      composerTop: el ? Math.round(el.getBoundingClientRect().top) : null
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return 'installed';
})()`;

const COLLECT = `(function(){
  window.__syncRunning = false;
  var a = window.__syncSamples || [];
  // 每帧一条太多，只留「innerH 或 composerTop 发生变化」的帧，外加变化前最后一帧作为基线
  var out = [];
  for (var i = 0; i < a.length; i++) {
    var changed = i === 0 || a[i].innerH !== a[i-1].innerH || a[i].composerTop !== a[i-1].composerTop;
    if (changed && i > 0) out.push(a[i-1]);
    if (changed) out.push(a[i]);
  }
  return JSON.stringify({ total: a.length, marks: out });
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

  await client.call('Runtime.evaluate', { expression: INSTALL, returnByValue: true });

  adb(['logcat', '-c']);
  const action = process.argv[2] || 'tap';
  const tapAt = Date.now();
  if (action === 'back') adb(['shell', 'input keyevent 4']);
  else adb(['shell', `input tap ${tapX} ${tapY}`]);
  console.log(`触发时刻 wall=${tapAt}`);
  await new Promise((r) => setTimeout(r, 2500));

  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const { total, marks } = JSON.parse(raw);

  const log = adb(['logcat', '-d', '-s', 'DshSync:I']);
  const native = [];
  for (const line of log.split(/\r?\n/)) {
    const m = /apply h=(\d+) wall=(\d+) up=(\d+)/.exec(line);
    if (m) native.push({ h: Number(m[1]), wall: Number(m[2]) });
  }

  console.log(`\n=== 原生 applyKeyboardHeight（${native.length} 次）===`);
  const nBase = native.length ? native[0].wall : tapAt;
  for (const n of native) console.log(`+${String(n.wall - tapAt).padStart(5)}ms  nativeH=${String(n.h).padStart(4)}`);

  console.log(`\n=== 页面 innerHeight（采样 ${total} 帧，变化点 ${marks.length} 条）===`);
  for (const s of marks) console.log(`+${String(s.wall - tapAt).padStart(5)}ms  innerH=${String(s.innerH).padStart(4)}  composerTop=${s.composerTop}`);

  // 关键判据：原生第一次「有效变化」与页面第一次「有效变化」的时间差
  const nFirst = native.find((n) => n.h > 0);
  const pBase = marks.length ? marks[0] : null;
  const pFirst = marks.find((s) => pBase && s.innerH < pBase.innerH);
  console.log('\n=== 传导延迟 ===');
  console.log(`原生首次 h>0: ${nFirst ? `+${nFirst.wall - tapAt}ms (h=${nFirst.h})` : '未捕获'}`);
  console.log(`页面首次内缩: ${pFirst ? `+${pFirst.wall - tapAt}ms (innerH=${pFirst.innerH})` : '未捕获'}`);
  if (nFirst && pFirst) console.log(`→ 页面比原生晚 ${pFirst.wall - nFirst.wall}ms 才开始动`);

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
