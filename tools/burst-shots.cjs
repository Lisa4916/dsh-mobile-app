// 连拍截屏，测「键盘顶边」与「输入框底边」的间距。
//
// 判据：如果键盘与页面同步，那么动画全过程中两者间距应保持恒定；
// 若页面先缩/后缩，间距会先变大再变小（或反之），那就是肉眼看到的「不同步」。
//
// screencap 太慢（1.5s/帧），抓不到 300ms 动画，所以这里走 CDP 的
// Page.captureScreenshot —— 它直接在渲染管线里取帧，几十毫秒一张。
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORT = 9222;
const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';
const OUT = process.argv[2] || 'D:\\dsh-mobile-app\\build-artifacts\\burst';
const TAPX = Number(process.argv[3] || 525);
const TAPY = Number(process.argv[4] || 1300);
const FRAMES = Number(process.argv[5] || 24);

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
        resolve({
          call(method, params) { const id = nextId++; return new Promise((res) => { pending.set(id, res); send({ id, method, params }); }); },
          close() { try { sock.destroy(); } catch {} },
        });
        parseFrames(); return;
      }
      buf = Buffer.concat([buf, chunk]); parseFrames();
    });
    sock.on('error', reject);
  });
}

function adb(a) { return execFileSync(ADB, a, { encoding: 'utf8', timeout: 30000 }).trim(); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE'); process.exit(1); }

  const client = await wsConnect(page.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${PORT}`));
  await client.call('Page.enable', {});
  await client.call('Runtime.enable', {});

  // 先把手势和动画都放慢 10 倍，30fps 抓得动
  for (const k of ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']) {
    adb(['shell', 'settings', 'put', 'global', k, '10']);
  }

  const tap = adb(['shell', `input tap ${TAPX} ${TAPY}`]); // 异步：不等它返回
  void tap;

  const t0 = Date.now();
  for (let i = 0; i < FRAMES; i++) {
    const r = await client.call('Page.captureScreenshot', { format: 'png' });
    const b64 = r.result && r.result.data;
    if (b64) {
      const file = path.join(OUT, `b${String(i).padStart(2, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    }
    const state = await client.call('Runtime.evaluate', {
      expression: `JSON.stringify({h: window.innerHeight, t: document.querySelector('[contenteditable="true"]') ? Math.round(document.querySelector('[contenteditable="true"]').getBoundingClientRect().bottom) : null})`,
      returnByValue: true,
    });
    const v = JSON.parse(state.result.result.value);
    console.log(`frame ${String(i).padStart(2)}  +${String(Date.now() - t0).padStart(4)}ms  innerH=${v.h}  composerBottom=${v.t}`);
  }

  for (const k of ['animator_duration_scale', 'transition_animation_scale', 'window_animation_scale']) {
    adb(['shell', 'settings', 'put', 'global', k, '1']);
  }
  console.log('已复原动画缩放三项为 1');
  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
