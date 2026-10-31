// 查 DSH 页面自己怎么处理键盘：有没有 CSS transition / transform / visualViewport 监听。
//
// 背景：原生侧已做到 innerHeight 逐帧跟随键盘（实测 composerTop - innerH/2 恒为 36.5~37，
// 页面布局本身是平滑的）。若用户仍看到「速度不同步」，那只能是页面自己在键盘期间
// 又跑了一套动画（CSS transition），两套动画叠加 → 看起来一口一口地追。
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

const PORT = 9222;

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
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
      const mask = crypto.randomBytes(4);
      let header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) header = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      else { header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 4); }
      const masked = Buffer.alloc(len);
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

const PROBE = `(function(){
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) return 'NO_COMPOSER';
  const out = [];
  let node = el, depth = 0;
  while (node && node !== document.documentElement && depth < 12) {
    const cs = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    out.push({
      depth: depth,
      tag: node.tagName,
      cls: (node.className && String(node.className).slice(0, 90)) || '',
      position: cs.position,
      transition: cs.transitionProperty === 'all' && cs.transitionDuration === '0s' ? '(none)' : (cs.transitionProperty + ' / ' + cs.transitionDuration + ' / ' + cs.transitionTimingFunction),
      animation: cs.animationName === 'none' ? '(none)' : (cs.animationName + ' ' + cs.animationDuration),
      transform: cs.transform,
      willChange: cs.willChange,
      top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
      flexGrow: cs.flexGrow, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom,
    });
    node = node.parentElement; depth++;
  }
  const vvHandlers = !!window.visualViewport;
  return JSON.stringify({
    vv: vvHandlers ? {height: Math.round(window.visualViewport.height), offsetTop: Math.round(window.visualViewport.offsetTop), scale: window.visualViewport.scale} : null,
    hasNativeKeyboardHook: typeof window.__dshNativeKeyboard === 'function',
    chain: out,
  });
})()`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});
  const v = (await client.call('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.result.value;
  const d = JSON.parse(v);
  console.log('visualViewport:', JSON.stringify(d.vv));
  console.log('原生 hook 已注入:', d.hasNativeKeyboardHook);
  console.log('\n=== composer 祖先链（0 = composer 本身）===');
  for (const c of d.chain) {
    console.log(`[${c.depth}] ${c.tag} pos=${c.position} ${c.top}~${c.bottom} h=${c.height} flexGrow=${c.flexGrow} padB=${c.paddingBottom} marB=${c.marginBottom}`);
    if (c.transition !== '(none)' && c.transition !== 'all 0s ease 0s') console.log(`     transition: ${c.transition}`);
    if (c.animation !== '(none)') console.log(`     animation : ${c.animation}`);
    if (c.transform !== 'none') console.log(`     transform : ${c.transform}`);
    if (c.willChange !== 'auto') console.log(`     willChange: ${c.willChange}`);
    if (c.cls) console.log(`     class     : ${c.cls}`);
  }
  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
