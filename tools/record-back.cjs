// 连拍：触发一次返回，用 CDP 每秒多次截图 + DOM 采样，抓「闪屏 / 侧栏闪动」的中间态。
//
// 用法： node record-back.cjs <cdpPort> [采样次数] [间隔ms]
//
// 为什么用 CDP 而不是 adb screencap：adb 单张要 300–600ms，抓不到 1 秒内的过程；
// CDP Page.captureScreenshot 可以 60–120ms 一张，才看得清侧栏滑出又收回。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9222';
const N = Number(process.argv[3] || 24);
const GAP = Number(process.argv[4] || 90);
const OUT = process.argv[5] || 'D:\\dsh-mobile-app\\build-artifacts\\back-frames';

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.handlers = new Map(); this.nextId = 1; this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(String(Math.random())).toString('base64');
      this.sock = require('net').connect(this.port, this.host, () => {
        this.sock.write(`GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let up = false;
      this.sock.on('data', (c) => {
        if (!up) {
          this.buf = Buffer.concat([this.buf, c]);
          const i = this.buf.indexOf('\r\n\r\n');
          if (i >= 0) { up = true; this.buf = this.buf.subarray(i + 4); resolve(); if (this.buf.length) this._drain(); }
          return;
        }
        this.buf = Buffer.concat([this.buf, c]); this._drain();
      });
      this.sock.on('error', reject);
    });
  }
  _drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const p = this.buf.subarray(off, off + len).toString('utf8');
      const op = b0 & 0x0f;
      this.buf = this.buf.subarray(off + len);
      if (op === 1) {
        let m; try { m = JSON.parse(p); } catch { continue; }
        const h = this.handlers.get(m.id);
        if (h) { this.handlers.delete(m.id); h(m); }
        else if (m.method) {
          this.events.push(m);
          if (this.onEvent) this.onEvent(m);
        }
      }
    }
  }
  cmd(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, resolve);
      const payload = Buffer.from(JSON.stringify({ id, method, params: params || {} }), 'utf8');
      const mask = Buffer.alloc(4);
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      this.sock.write(Buffer.concat([header, mask, payload]));
      setTimeout(() => { if (this.handlers.has(id)) { this.handlers.delete(id); resolve({ __timeout: true }); } }, 12000);
    });
  }
}

// 每帧采一份「视觉状态」：侧栏位置、遮罩、页面内容首行
const STATE_JS = `
(function(){
  var root = document.querySelector('.wtg9ga_root');
  var g = root ? root.getBoundingClientRect() : null;
  var b = (document.body ? document.body.innerText : '') || '';
  // 侧栏遮罩层（展开时才出现）
  var scrim = null;
  var all = document.querySelectorAll('div');
  for (var i=0;i<all.length;i++){
    var el = all[i], c = (el.className||'').toString();
    if (c.indexOf('scrim') !== -1 || c.indexOf('overlay') !== -1 || c.indexOf('backdrop') !== -1) {
      var r = el.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) { scrim = { cls: c.slice(0,40), l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width) }; break; }
    }
  }
  return JSON.stringify({
    sideL: g ? Math.round(g.left) : null,
    sideCls: root ? root.className.replace('wtg9ga_root','').trim() : null,
    scrim: scrim,
    hero: b.indexOf('探索未至之境') !== -1,
    tabs: b.indexOf('对话') !== -1 && b.indexOf('轨迹') !== -1,
    head: b.slice(0, 40).replace(/\\n/g, '/'),
    going: !!window.__dshGoingHome
  });
})();
`;

(async () => {
  const t = await listTargets();
  const page = t.find((x) => x.type === 'page');
  if (!page) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  await ws.cmd('Page.enable');
  await ws.cmd('Network.enable');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const docs = [];
  ws.onEvent = (m) => {
    if (m.method === 'Network.requestWillBeSent' && m.params.type === 'Document') docs.push(m.params.request.url);
  };

  const state = async () => {
    const r = await ws.cmd('Runtime.evaluate', { expression: STATE_JS, returnByValue: true });
    if (!r.result || r.__timeout || !r.result.result) return null;
    try { return JSON.parse(r.result.result.value); } catch { return null; }
  };
  const shot = async (name) => {
    const r = await ws.cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    if (r.result && r.result.data) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
      return true;
    }
    return false;
  };

  console.log('触发前:', JSON.stringify(await state()));
  await shot('frame-000.jpg');

  // 沿用手势（左边缘内滑），走系统真实分发路径
  const { execFileSync } = require('child_process');
  const { ADB, resolveSerial } = require('./device.cjs');
  const DEV = resolveSerial(process.env.DEV_SERIAL);
  // 手势脚本现场生成，不依赖设备上预先存在的文件。
  // 之前是写死读 /data/local/tmp/swipe.txt，换设备后文件不在，报的却是
  // `monkey` 失败 —— 看着像手势不生效，实际是没东西可跑。
  const swipeScript = [
    'type= raw events',
    'count= 2',
    'speed= 1.0',
    'start data >>',
    'DispatchPointer(0,0,0,3,900,0,1,1,1,1,0,0)',
    'DispatchPointer(0,0,0,120,900,0,1,1,1,1,0,0)',
    'DispatchPointer(0,0,1,120,900,0,1,1,1,1,0,0)',
    '',
  ].join('\n');
  const b64 = Buffer.from(swipeScript, 'utf8').toString('base64');
  execFileSync(ADB, ['-s', DEV, 'shell', `echo ${b64} | base64 -d > /data/local/tmp/swipe.txt`]);
  execFileSync(ADB, ['-s', DEV, 'shell', 'monkey', '-p', 'com.dsh.remote',
    '-f', '/data/local/tmp/swipe.txt', '-v', '6']);

  for (let i = 1; i <= N; i++) {
    await new Promise((r) => setTimeout(r, GAP));
    const s = await state();
    const okShot = await shot(`frame-${String(i).padStart(3, '0')}.jpg`);
    const label = s
      ? `sideL=${s.sideL} side=${s.sideCls} scrim=${s.scrim ? 'Y' : 'N'} hero=${s.hero} tabs=${s.tabs} going=${s.going} head=${s.head}`
      : '(取不到)';
    console.log(`  [${String(i).padStart(2)}] shot=${okShot ? 'Y' : 'N'} ${label}`);
  }

  console.log('\nDocument 请求:', docs.length === 0 ? '无（页面未重载）' : docs);
  ws.sock.end();
})().catch((e) => { console.error(e); process.exit(1); });
