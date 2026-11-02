// 单独验证「键盘收起」方向：按 BACK 后页面是否收到 h=0，#root 是否恢复到满高。
// 这是上一轮暴露出的真问题：WebView 现在全屏不缩，window.innerHeight 恒为 895，
// 页面无法靠 resize 判断键盘状态，完全依赖原生下发。收起方向若漏发，root 就会卡在矮高度。
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const PORT = 9222;
const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';
const SERIAL = require('./device.cjs').resolveSerial();

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

const WRAP = `(function(){
  window.__calls = [];
  if (!window.__wrapped) {
    window.__wrapped = true;
    var orig = window.__dshNativeKeyboard;
    window.__dshNativeKeyboard = function(h){
      var r = document.getElementById('root');
      window.__calls.push({ w: Date.now(), h: h, rootBefore: r ? Math.round(r.getBoundingClientRect().height) : null });
      return orig ? orig.apply(this, arguments) : undefined;
    };
  }
  window.__rt = [];
  window.__rtOn = true;
  function tick(){
    if (!window.__rtOn) return;
    var r = document.getElementById('root');
    var el = document.querySelector('[contenteditable="true"]');
    window.__rt.push({ w: Date.now(), rh: r ? Math.round(r.getBoundingClientRect().height) : null,
      ct: el ? Math.round(el.getBoundingClientRect().top) : null });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return 'ok';
})()`;

const COLLECT = `(function(){
  window.__rtOn = false;
  var c = window.__calls || [];
  var t = window.__rt || [];
  var ch = [];
  for (var i = 0; i < t.length; i++) if (i === 0 || t[i].rh !== t[i-1].rh || t[i].ct !== t[i-1].ct) ch.push(t[i]);
  return JSON.stringify({ calls: c, changes: ch, total: t.length });
})()`;

const STATE = `(function(){
  var r = document.getElementById('root');
  var el = document.querySelector('[contenteditable="true"]');
  return JSON.stringify({
    ih: window.innerHeight,
    rh: r ? Math.round(r.getBoundingClientRect().height) : null,
    inline: r ? r.style.height : null,
    ct: el ? Math.round(el.getBoundingClientRect().top) : null
  });
})()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  const before = JSON.parse((await client.call('Runtime.evaluate', { expression: STATE, returnByValue: true })).result.result.value);
  console.log(`按 BACK 前: innerH=${before.ih} rootH=${before.rh} inline="${before.inline}" composerTop=${before.ct}`);

  await client.call('Runtime.evaluate', { expression: WRAP, returnByValue: true });

  const t0 = Date.now();
  adb(['shell', 'input keyevent 4']);
  await new Promise((r) => setTimeout(r, 1800));

  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const { calls, changes, total } = JSON.parse(raw);

  console.log(`\n=== BACK 后 __dshNativeKeyboard 调用（${calls.length} 次）===`);
  for (const c of calls) console.log(`+${String(c.w - t0).padStart(5)}ms  h=${c.h}  rootBefore=${c.rootBefore}`);
  if (!calls.length) console.log('（一次都没调用 —— 收起方向漏发，root 会卡住）');

  console.log(`\n=== root/composerTop 变化（${total} 帧，${changes.length} 条）===`);
  for (const c of changes) console.log(`+${String(c.w - t0).padStart(5)}ms  rootH=${String(c.rh).padStart(4)}  composerTop=${c.ct}`);

  await new Promise((r) => setTimeout(r, 500));
  const after = JSON.parse((await client.call('Runtime.evaluate', { expression: STATE, returnByValue: true })).result.result.value);
  console.log(`\n按 BACK 后: innerH=${after.ih} rootH=${after.rh} inline="${after.inline}" composerTop=${after.ct}`);
  console.log(`root 是否恢复满高: ${after.rh >= 890 ? '是' : '否 ← 有问题'}`);

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
