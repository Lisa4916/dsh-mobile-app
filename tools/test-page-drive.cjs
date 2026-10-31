// 决定性实验：页面自己逐帧改 CSS，能否得到逐帧（~16ms）的布局响应？
//
// 为什么必须做这个实验：
// 同一时钟测量已证明「原生逐帧改 bottomMargin」→「WebView innerHeight」这条链
// 只给出约 108ms 一跳的批处理响应，整段耗时 897ms（原生侧只有 456ms）。
// 若页面侧自己改 CSS 能得到逐帧响应，正确修法就是：WebView 保持全屏不动，
// 键盘避让改由页面自己动画。
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

// 结构探测：找出 body 的直接子元素与它们的 flex/尺寸，确定「在哪里放避让」最安全
const STRUCT = `(function(){
  function d(n){ const cs=getComputedStyle(n); const r=n.getBoundingClientRect();
    return { tag:n.tagName, id:n.id||'', cls:(n.className&&String(n.className).slice(0,70))||'',
      display:cs.display, flexDir:cs.flexDirection, h:Math.round(r.height), top:Math.round(r.top), bottom:Math.round(r.bottom),
      overflow:cs.overflow, position:cs.position }; }
  const out = { html: d(document.documentElement), body: d(document.body), children: [] };
  for (const c of document.body.children) out.children.push(d(c));
  const el = document.querySelector('[contenteditable="true"]');
  const r = el ? el.getBoundingClientRect() : null;
  out.composer = r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
  out.innerH = window.innerHeight;
  return JSON.stringify(out);
})()`;

// 页面自驱实验：用 rAF 在 300ms 内把 html 的 padding-bottom 从 0 拉到 322px，
// 同时每帧记录 composerTop，看它是否跟着逐帧移动。
const EXPERIMENT = `(function(){
  window.__cssSamples = [];
  var html = document.documentElement;
  var el = document.querySelector('[contenteditable="true"]');
  var start = 0, DUR = 300, TARGET = 322;
  html.style.paddingBottom = '0px';
  html.style.boxSizing = 'border-box';
  html.style.height = '100%';
  function ease(t){ return 1 - Math.pow(1 - t, 5); }
  function step(now){
    if (!start) start = now;
    var t = Math.min(1, (now - start) / DUR);
    var v = ease(t) * TARGET;
    html.style.paddingBottom = v.toFixed(1) + 'px';
    window.__cssSamples.push({ t: Math.round(now - start), pad: Math.round(v), composerTop: el ? Math.round(el.getBoundingClientRect().top) : null });
    if (t < 1) requestAnimationFrame(step);
    else { html.style.paddingBottom = ''; html.style.boxSizing = ''; html.style.height = ''; window.__cssDone = true; }
  }
  requestAnimationFrame(step);
  return 'started';
})()`;

const COLLECT = `(function(){ return JSON.stringify(window.__cssSamples || []); })()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  const s = JSON.parse((await client.call('Runtime.evaluate', { expression: STRUCT, returnByValue: true })).result.result.value);
  console.log('=== 结构 ===');
  console.log(`html: display=${s.html.display} h=${s.html.h} pos=${s.html.position}`);
  console.log(`body: display=${s.body.display} flexDir=${s.body.flexDir} h=${s.body.h} overflow=${s.body.overflow}`);
  console.log(`innerH=${s.innerH} composer=${JSON.stringify(s.composer)}`);
  console.log('body 子元素:');
  for (const c of s.children) {
    console.log(`  ${c.tag}${c.id ? '#' + c.id : ''} .${c.cls} display=${c.display} flexDir=${c.flexDir} ${c.top}~${c.bottom} h=${c.h} pos=${c.position} overflow=${c.overflow}`);
  }

  await client.call('Runtime.evaluate', { expression: EXPERIMENT, returnByValue: true });
  await new Promise((r) => setTimeout(r, 1200));
  const raw = (await client.call('Runtime.evaluate', { expression: COLLECT, returnByValue: true })).result.result.value;
  const samples = JSON.parse(raw);

  console.log(`\n=== 页面自驱 CSS 动画采样（${samples.length} 帧）===`);
  let prev = null;
  for (const x of samples) {
    const dt = prev ? x.t - prev.t : 0;
    const dTop = prev ? x.composerTop - prev.composerTop : 0;
    console.log(`t=${String(x.t).padStart(4)}ms pad=${String(x.pad).padStart(3)} composerTop=${x.composerTop}  Δt=${String(dt).padStart(3)} Δtop=${dTop}`);
    prev = x;
  }
  if (samples.length > 1) {
    const gaps = samples.slice(1).map((x, i) => x.t - samples[i].t);
    gaps.sort((a, b) => a - b);
    console.log(`\n帧间隔 中位数=${gaps[Math.floor(gaps.length / 2)]}ms  最小=${gaps[0]}ms  最大=${gaps[gaps.length - 1]}ms`);
  }

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
