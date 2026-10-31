// 验证「页面侧改 #root 高度」能否 1:1 带动 composer 上移，并测 rAF 帧间隔。
//
// 前面的 padding-bottom 实验只带动了一半位移（322px padding 只让 composerTop 上移 161px），
// 因为 #root 高度没变。这里改 #root 的高度，看是否 1:1。
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

const PORT = 9222;

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

const STEP = `(function(){
  var root = document.getElementById('root');
  var el = document.querySelector('[contenteditable="true"]');
  var r0 = root.getBoundingClientRect();
  var before = el.getBoundingClientRect().top;
  var out = { rootH_before: Math.round(r0.height), composerTop_before: Math.round(before), innerH: window.innerHeight };
  // 试 1：直接设 height 为 innerH-200
  root.style.height = (window.innerHeight - 200) + 'px';
  out.composerTop_at200 = Math.round(el.getBoundingClientRect().top);
  out.rootH_at200 = Math.round(root.getBoundingClientRect().height);
  // 试 2：height 为 innerH-322
  root.style.height = (window.innerHeight - 322) + 'px';
  out.composerTop_at322 = Math.round(el.getBoundingClientRect().top);
  // 复原
  root.style.height = '';
  out.composerTop_restored = Math.round(el.getBoundingClientRect().top);
  return JSON.stringify(out);
})()`;

// rAF 动画测帧间隔：把 #root height 从 innerH 拉到 innerH-322，300ms
const ANIM = `(function(){
  window.__hSamples = [];
  var root = document.getElementById('root');
  var el = document.querySelector('[contenteditable="true"]');
  var H = window.innerHeight, TARGET = H - 322, DUR = 300, start = 0;
  root.style.height = H + 'px';
  function ease(t){ return 1 - Math.pow(1 - t, 5); }
  function step(now){
    if (!start) start = now;
    var t = Math.min(1, (now - start) / DUR);
    var h = H - (H - TARGET) * ease(t);
    root.style.height = h.toFixed(1) + 'px';
    window.__hSamples.push({ t: Math.round(now - start), rootH: Math.round(h), composerTop: Math.round(el.getBoundingClientRect().top) });
    if (t < 1) requestAnimationFrame(step);
    else { window.__hDone = true; }
  }
  requestAnimationFrame(step);
  return 'started';
})()`;

const RESET = `(function(){ var r=document.getElementById('root'); r.style.height=''; return 'reset'; })()`;
const COLLECT = `(function(){ return JSON.stringify(window.__hSamples || []); })()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  const r = JSON.parse((await client.call('Runtime.evaluate', { expression: STEP, returnByValue: true })).result.result.value);
  console.log('=== 静态位移验证 ===');
  console.log(`基准: innerH=${r.innerH} rootH=${r.rootH_before} composerTop=${r.composerTop_before}`);
  console.log(`height=innerH-200 → rootH=${r.rootH_at200} composerTop=${r.composerTop_at200}  (Δ=${r.composerTop_at200 - r.composerTop_before})`);
  console.log(`height=innerH-322 → composerTop=${r.composerTop_at322}  (Δ=${r.composerTop_at322 - r.composerTop_before})`);
  console.log(`复原 → composerTop=${r.composerTop_restored}`);

  await client.call('Runtime.evaluate', { expression: ANIM, returnByValue: true });
  await new Promise((res) => setTimeout(res, 1000));
  const samples = JSON.parse((await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value);
  await client.call('Runtime.evaluate', { expression: RESET, returnByValue: true });

  console.log(`\n=== rAF 动画 #root 高度（${samples.length} 帧）===`);
  let prev = null;
  for (const x of samples) {
    console.log(`t=${String(x.t).padStart(4)} rootH=${String(x.rootH).padStart(4)} composerTop=${String(x.composerTop).padStart(4)}  Δt=${prev ? String(x.t - prev.t).padStart(3) : '  -'}  Δtop=${prev ? x.composerTop - prev.composerTop : 0}`);
    prev = x;
  }
  if (samples.length > 1) {
    const gaps = samples.slice(1).map((x, i) => x.t - samples[i].t);
    const sorted = [...gaps].sort((a, b) => a - b);
    console.log(`\n帧间隔 中位数=${sorted[Math.floor(sorted.length / 2)]}ms 最小=${sorted[0]}ms 最大=${sorted[sorted.length - 1]}ms`);
    const tops = samples.map((x) => x.composerTop);
    let monotonic = true;
    for (let i = 1; i < tops.length; i++) if (tops[i] > tops[i - 1]) monotonic = false;
    console.log(`composerTop 单调上移: ${monotonic ? '是' : '否（有回弹）'}`);
  }

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
