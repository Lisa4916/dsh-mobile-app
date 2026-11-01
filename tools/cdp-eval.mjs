// 通过 CDP 在当前 WebView 里执行 JS / 导航，用于真机页面态诊断。
// 用法：
//   node tools/cdp-eval.cjs eval "<js 表达式>"
//   node tools/cdp-eval.cjs nav "<url>"
//   node tools/cdp-eval.cjs cookies
// 前提：已跑 node tools/cdp-forward.cjs（重建 adb forward tcp:9222）。
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 9222;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

// 极简 WebSocket 客户端（只处理本项目需要的文本帧）
class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname + u.search;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    this.nextId = 1;
    this.waiters = new Map();
    this.opened = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: this.host,
        port: this.port,
        path: this.path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.sock = socket;
        this.opened = true;
        socket.on('data', (d) => this.onData(d));
        socket.on('close', () => { this.opened = false; });
        socket.on('error', () => { this.opened = false; });
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const hi = this.buf.readUInt32BE(off);
        const lo = this.buf.readUInt32BE(off + 4);
        len = hi * 0x100000000 + lo; off += 8;
      }
      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.sock.end(); this.opened = false; return; }
      if (opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) {
          const w = this.waiters.get(msg.id);
          this.waiters.delete(msg.id);
          w(msg);
        }
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    }
  }

  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, resolve);
      this.send({ id, method, params });
      setTimeout(() => {
        if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 15000);
    });
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('target: ' + page.url);

  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');

  if (cmd === 'eval') {
    const r = await ws.call('Runtime.evaluate', {
      expression: arg,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
  } else if (cmd === 'nav') {
    await ws.call('Page.enable');
    const r = await ws.call('Page.navigate', { url: arg });
    console.log(JSON.stringify(r.result, null, 2));
  } else if (cmd === 'reload') {
    await ws.call('Page.enable');
    await ws.call('Page.reload', {});
    console.log('reloaded');
  } else if (cmd === 'setcookie') {
    await ws.call('Network.enable');
    const [name, value, url] = process.argv.slice(4);
    const r = await ws.call('Network.setCookie', {
      name, value, url: url || 'http://192.168.50.58:3081/',
      httpOnly: true, secure: false, sameSite: 'Strict',
    });
    console.log('setcookie: ' + JSON.stringify(r.result));
  } else if (cmd === 'cookies') {
    const r = await ws.call('Network.getCookies', {});
    console.log(JSON.stringify(r.result?.cookies, null, 2));
  } else {
    console.log('usage: cdp-eval.cjs eval|nav|cookies <arg>');
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
