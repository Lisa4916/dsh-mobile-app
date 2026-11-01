// 验证 HEAL_PROBE_JS 的判据：该出手时认出故障，不该出手时绝不误判。
//
// 在真实 WebView 里临时改写 title / body 来模拟各页面形态，每种形态跑一遍与
// MainActivity.kt 中**逐字相同**的探测脚本，最后完整还原。
//
// 用法：node tools/probe-heal-criteria.mjs
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 9222;

// 与 MainActivity.kt 的 companion object 里 HEAL_PROBE_JS 逐字一致。
const HEAL_PROBE_JS = `
  (function(){
    try {
      var t = (document.title || '');
      var b = (document.body ? document.body.innerText : '') || '';
      if (b.indexOf('导出会话日志') !== -1) return '0';
      if (b.indexOf('探索未至之境') !== -1) return '0';
      if (b.indexOf('访问密码') !== -1) return '0';
      if (t.indexOf('访问验证') !== -1) return '0';
      if (t.indexOf('正在进入') !== -1) return '0';
      if (b.indexOf('无法完成登录握手') !== -1) return '1';
      if (b.indexOf('dsh web authentication required') !== -1) return '1';
      if (b.length === 0 && t.indexOf('无法完成登录握手') !== -1) return '1';
      return '0';
    } catch (e) { return '0'; }
  })()
`;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname; this.port = u.port || 80; this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0); this.nextId = 1; this.waiters = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.host, port: this.port, path: this.path,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.sock = socket; socket.on('data', (d) => this.onData(d)); socket.on('error', () => {}); resolve();
      });
      req.on('error', reject); req.end();
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]; const b1 = this.buf[1];
      const opcode = b0 & 0x0f; const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f; let off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; const hi = this.buf.readUInt32BE(off); const lo = this.buf.readUInt32BE(off + 4); len = hi * 0x100000000 + lo; off += 8; }
      let maskKey = null;
      if (masked) { if (this.buf.length < off + 4) return; maskKey = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x1) {
        let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) { const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); w(msg); }
      }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8'); const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    const mask = crypto.randomBytes(4); const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve); this.send({ id, method, params });
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

const evalJs = async (ws, expr) => {
  const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.result?.value;
};

async function main() {
  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');

  const origTitle = await evalJs(ws, 'document.title');
  const origHtml = await evalJs(ws, 'document.body ? document.body.innerHTML : ""');
  console.log(`baseline title=${JSON.stringify(origTitle)}`);

  // 每个用例只改 body.innerText 或 title，跑探测，然后还原。
  const cases = [
    { name: '正常主界面（不应误判）', body: null, title: null, expect: '0' },
    {
      name: '真失败页：标题+正文都是无法完成登录握手',
      title: 'DSH Pocket · 无法完成登录握手',
      body: '🔁 无法完成登录握手\n浏览器没有保存 DSH 下发的会话 cookie',
      expect: '1',
    },
    {
      name: '上游 401 裸文案',
      title: 'dsh web',
      body: 'dsh web authentication required',
      expect: '1',
    },
    {
      name: '标题残留失败页、正文正常主界面（应不误判）',
      title: 'DSH Pocket · 无法完成登录握手',
      body: '导出会话日志\n探索未至之境\n默认工作区',
      expect: '0',
    },
    { name: 'PIN 登录页（不应误判）', title: 'DSH Pocket · 访问验证', body: '此局域网地址受访问密码保护', expect: '0' },
    { name: '握手过渡页（不应误判）', title: 'DSH Pocket · 正在进入 | opening…', body: '正在进入…', expect: '0' },
    { name: '普通错误页（不应误判）', title: '网络错误', body: '连接超时，请检查网络', expect: '0' },
  ];

  let failed = 0;
  for (const c of cases) {
    // 先还原到基线，再按用例改写
    await evalJs(ws, `document.title = ${JSON.stringify(origTitle || '')};`);
    await evalJs(ws, `if (document.body) document.body.innerHTML = ${JSON.stringify(origHtml || '')};`);
    if (c.title !== null) await evalJs(ws, `document.title = ${JSON.stringify(c.title)};`);
    if (c.body !== null) await evalJs(ws, `if (document.body) document.body.innerText = ${JSON.stringify(c.body)};`);

    const got = String(await evalJs(ws, HEAL_PROBE_JS)).trim();
    const ok = got === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  expect=${c.expect} got=${got}  ${c.name}`);
  }

  // 完整还原，别把实验痕迹留在真机上
  await evalJs(ws, `document.title = ${JSON.stringify(origTitle || '')};`);
  await evalJs(ws, `if (document.body) document.body.innerHTML = ${JSON.stringify(origHtml || '')};`);
  console.log('restored baseline');

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  ws.sock.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
