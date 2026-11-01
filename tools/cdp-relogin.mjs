// 在手机 WebView 里清掉 WebView 的 cookie 并重新走 dsh-pocket 握手。
// 背景：dsh web 端口变了（54282 → 17169）后，旧的 dsh-auth-* cookie 里 authority 还是旧端口，
// 上游一律 401；dsh-pocket 判定 handshake 失败后进入限流，回 503 "无法完成登录握手"。
// 清 cookie 再带 dsh-pocket-retry=1 重新握手即可恢复。
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 9222;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
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
      const req = http.request({
        host: this.host, port: this.port, path: this.path,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (res, socket) => {
        this.sock = socket;
        socket.on('data', (d) => this.onData(d));
        socket.on('error', () => {});
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
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2, maskKey = null;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(2) * 0x100000000 + this.buf.readUInt32BE(6); off = 10; }
      if (b1 & 0x80) { if (this.buf.length < off + 4) return; maskKey = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      this.buf = this.buf.subarray(off + len);
      if ((this.buf[0] & 0x0f) === 0x8) return;
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      if (msg.id && this.waiters.has(msg.id)) { const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); w(msg); }
    }
  }
  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
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
      setTimeout(() => { if (this.waiters.has(id)) { this.waiters.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const entry = process.argv[2];
  if (!entry) throw new Error('usage: node cdp-relogin.mjs <dsh-pocket-url>');

  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');
  await ws.call('Network.enable');
  await ws.call('Page.enable');

  console.log('① 清空 WebView cookie');
  await ws.call('Network.clearBrowserCookies');

  console.log('② 导航到带 retry 的握手地址: ' + entry);
  await ws.call('Page.navigate', { url: entry });
  await sleep(3500);

  console.log('③ 读结果');
  const r = await ws.call('Runtime.evaluate', {
    expression: "JSON.stringify({url:location.href,title:document.title,body:document.body.innerText.slice(0,400)})",
    returnByValue: true,
  });
  console.log(r.result?.result?.value);

  const c = await ws.call('Network.getCookies', {});
  const list = (c.result?.cookies || []).map((x) => ({ name: x.name, n: x.value.length }));
  console.log('cookies: ' + JSON.stringify(list));

  const auth = (c.result?.cookies || []).find((x) => x.name.startsWith('dsh-auth-'));
  if (auth) {
    const p = auth.value.split('.')[1];
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    console.log('auth payload: ' + json);
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
