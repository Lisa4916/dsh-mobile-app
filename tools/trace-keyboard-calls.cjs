// 追 __dshNativeKeyboard 的每次调用：记录入参、算出的 targetH、以及随后 #root 的实际高度。
// 目的：分清「原生没下发 / 下发值不对 / 页面自己又改回去了」三种情况。
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

// 包一层：记录每次调用，同时每帧记 #root 高度，看谁在改
const WRAP = `(function(){
  if (window.__traceOn) return 'already';
  window.__traceOn = true;
  window.__calls = [];
  var orig = window.__dshNativeKeyboard;
  window.__dshNativeKeyboard = function(h){
    var r = document.getElementById('root');
    window.__calls.push({
      w: Date.now(), h: h,
      ih: window.innerHeight,
      rootBefore: r ? Math.round(r.getBoundingClientRect().height) : null,
      inline: r ? r.style.height : null
    });
    return orig ? orig.apply(this, arguments) : undefined;
  };
  window.__rootTrace = [];
  function tick(){
    if (!window.__traceOn) return;
    var r = document.getElementById('root');
    window.__rootTrace.push({ w: Date.now(), rh: r ? Math.round(r.getBoundingClientRect().height) : null, inline: r ? r.style.height : null });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return 'ok';
})()`;

const COLLECT = `(function(){
  window.__traceOn = false;
  var c = window.__calls || [];
  var t = window.__rootTrace || [];
  var changes = [];
  for (var i = 0; i < t.length; i++) {
    if (i === 0 || t[i].rh !== t[i-1].rh || t[i].inline !== t[i-1].inline) changes.push(t[i]);
  }
  return JSON.stringify({ calls: c, rootChanges: changes.slice(0, 60), rootTotal: t.length });
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

  const w = (await client.call('Runtime.evaluate', { expression: WRAP, returnByValue: true })).result.result.value;
  console.log(`wrap=${w}  tap(${tapX},${tapY})`);

  adb(['logcat', '-c']);
  const t0 = Date.now();
  adb(['shell', `input tap ${tapX} ${tapY}`]);
  await new Promise((r) => setTimeout(r, 2600));

  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const { calls, rootChanges, rootTotal } = JSON.parse(raw);

  console.log(`\n=== __dshNativeKeyboard 调用（${calls.length} 次）===`);
  for (const c of calls) console.log(`+${String(c.w - t0).padStart(5)}ms  h=${c.h}  innerH=${c.ih}  rootBefore=${c.rootBefore}  inline="${c.inline}"`);

  console.log(`\n=== #root 高度变化（共 ${rootTotal} 帧采样，${rootChanges.length} 条变化）===`);
  for (const c of rootChanges) console.log(`+${String(c.w - t0).padStart(5)}ms  h=${String(c.rh).padStart(4)}  inline="${c.inline}"`);

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
