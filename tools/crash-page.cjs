// 让真机 WebView 的**渲染进程**真的崩掉，用来验证 App 的 onRenderProcessGone 兜底。
//
// 为什么需要它：渲染进程被系统回收是这台机器上的常态（logcat 抓到过
// `ProcessSceneCleaner: SwipeUpClean: kill procName=…:sandboxed_process0:…`），
// 但 adb 杀不掉它 —— 非 root 对 sandboxed_process 做 `pkill -9` 只会得到
// `Operation not permitted`。唯一可靠的触发方式是 CDP 的 `Page.crash`。
//
// 用法：node crash-page.cjs <cdpPort>
//
// 判据（跑完自己看）：
//   · App 进程 pid **不变**（没被系统连带杀掉）→ 兜底生效
//   · logcat 出现 `DshRemote: render process gone (didCrash=true), rebuilding webview`
//   · 页面重新加载回主界面
// 如果 App 直接闪退，说明 WebViewClient 里没有覆盖 onRenderProcessGone。
const http = require('http');

const PORT = process.argv[2] || '9222';

function listTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

class WS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname + u.search;
    this.buf = Buffer.alloc(0);
    this.handlers = new Map();
    this.nextId = 1;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(String(Math.random())).toString('base64');
      this.sock = require('net').connect(this.port, this.host, () => {
        this.sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let up = false;
      this.sock.on('data', (c) => {
        if (!up) {
          this.buf = Buffer.concat([this.buf, c]);
          const i = this.buf.indexOf('\r\n\r\n');
          if (i >= 0) {
            up = true;
            this.buf = this.buf.subarray(i + 4);
            resolve();
            if (this.buf.length) this._drain();
          }
          return;
        }
        this.buf = Buffer.concat([this.buf, c]);
        this._drain();
      });
      this.sock.on('error', reject);
      this.sock.on('close', () => resolve());
    });
  }
  _drain() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const p = this.buf.subarray(off, off + len).toString('utf8');
      const op = b0 & 0x0f;
      this.buf = this.buf.subarray(off + len);
      if (op === 1) {
        let m;
        try {
          m = JSON.parse(p);
        } catch {
          continue;
        }
        const h = this.handlers.get(m.id);
        if (h) {
          this.handlers.delete(m.id);
          h(m);
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
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      this.sock.write(Buffer.concat([header, mask, payload]));
      setTimeout(() => {
        if (this.handlers.has(id)) {
          this.handlers.delete(id);
          resolve({ __timeout: true });
        }
      }, 8000);
    });
  }
}

(async () => {
  const targets = await listTargets();
  const page = targets.find((x) => x.type === 'page');
  if (!page) {
    console.error('没有 page target');
    process.exit(1);
  }
  console.log('目标页面:', page.url);
  const ws = new WS(page.webSocketDebuggerUrl);
  await ws.connect();
  console.log('发送 Page.crash …（渲染进程应当立刻消失，socket 会断开）');
  const r = await ws.cmd('Page.crash');
  console.log('返回:', JSON.stringify(r));
  try {
    ws.sock.end();
  } catch {
    /* 进程已死，正常 */
  }
  console.log('已触发。下一步用 adb 看 pid 是否不变 + logcat 是否有 render process gone。');
})();
