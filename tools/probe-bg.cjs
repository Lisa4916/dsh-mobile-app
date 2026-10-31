// 读 DSH 页面的实际背景色，用来把原生侧的留白填成同色
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

const EXPR = `JSON.stringify({
  bodyBg: getComputedStyle(document.body).backgroundColor,
  htmlBg: getComputedStyle(document.documentElement).backgroundColor,
  bodyClass: document.body.className,
  htmlDataTheme: document.documentElement.getAttribute('data-theme') || document.documentElement.className,
  colorScheme: getComputedStyle(document.documentElement).colorScheme,
  composerBg: (function(){
    const sel=['textarea','[contenteditable="true"]'];
    for(const s of sel){
      const els=[...document.querySelectorAll(s)].filter(e=>{const r=e.getBoundingClientRect();return r.width>40&&r.height>10;});
      if(els.length){
        let el=els[els.length-1], out=[];
        for(let i=0;i<5&&el;i++){ out.push(getComputedStyle(el).backgroundColor); el=el.parentElement; }
        return out;
      }
    }
    return null;
  })()
})`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }
  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});
  const r = await client.call('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  console.log(r.result.result.value);
  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
