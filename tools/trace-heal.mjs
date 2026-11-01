// 握手自愈的受控复现与取证。
//
// 用法：
//   node tools/trace-heal.mjs <staleCookieValue> [--total=8000] [--step=250]
//
// 做的事（全部在一次 CDP 连接内完成，避免每次调用重建 WS 带来的时序失真）：
//   1. 记录注入前的 cookie 快照（含 dsh-auth-* 的 authority）
//   2. Network.setCookie 把 dsh-auth-* 换成失效值（authority 指向不存在的端口）
//   3. Page.reload —— 这一步触发 WebViewClient.onPageFinished → healHandshakeIfNeeded
//   4. 每 step 毫秒探测一次：location.href / 标题 / 正文特征 / 当前 auth cookie 的 authority
//
// 判据：若时间线里先出现 AUTHREQ/HANDBLOCK，随后 auth cookie 的 authority 变回有效端口、
// 页面变成 OK，则自愈链路成立。若 authority 一直是失效值，说明自愈没跑。
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

class MiniWS {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = u.port || 80;
    this.path = u.pathname + u.search;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.waiters = new Map();
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
      if (opcode === 0x8) { this.sock.end(); return; }
      if (opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) {
          const w = this.waiters.get(msg.id);
          this.waiters.delete(msg.id);
          w(msg);
        }
      }
    }
  }

  send(obj) {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) {
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

// 从 dsh-auth-* cookie 的 payload 里读出 authority，用来区分「失效签名」与「有效签名」。
// 注意：同一名字可能同时存在 domain-cookie 与 host-only-cookie 两条，
// 这里把**每一条**都列出来——只看第一条会得出错误结论（实测踩过）。
function authAuthorities(cookies) {
  const hits = (cookies || []).filter((x) => x.name.startsWith('dsh-auth-'));
  if (hits.length === 0) return ['(no auth cookie)'];
  return hits.map((c) => {
    const parts = c.value.split('.');
    let authority = '(bad)';
    if (parts.length >= 2) {
      try {
        const b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        authority = JSON.parse(Buffer.from(b, 'base64').toString('utf8')).authority || '(none)';
      } catch { authority = '(undecodable)'; }
    }
    return `${authority}[${c.domain}|${c.path}|hostOnly=${c.hostOnly ?? '?'}]`;
  });
}

const PROBE = `(function(){
  try {
    var t = (document.title || '');
    var b = (document.body ? document.body.innerText : '') || '';
    if (t.indexOf('无法完成登录握手') !== -1) return 'HANDBLOCK';
    if (b.indexOf('dsh web authentication required') !== -1) return 'AUTHREQ';
    if (t.indexOf('DSH Pocket') !== -1 && b.indexOf('握手') !== -1) return 'POCKET';
    if (b.length === 0) return 'EMPTY';
    return 'OK';
  } catch (e) { return 'ERR'; }
})()`;

async function main() {
  const args = process.argv.slice(2);
  const stale = args.find((a) => !a.startsWith('--'));
  const opt = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : dflt;
  };
  const total = opt('total', 8000);
  const step = opt('step', 250);

  const targets = await httpJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  console.log('target: ' + page.url);

  const ws = new MiniWS(page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await ws.connect();
  await ws.call('Runtime.enable');
  await ws.call('Network.enable');
  await ws.call('Page.enable');

  const snap = async () => {
    const c = await ws.call('Network.getCookies', {});
    const state = await ws.call('Runtime.evaluate', {
      expression: PROBE, returnByValue: true,
    });
    const href = await ws.call('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    });
    const authName = (c.result?.cookies || []).find((x) => x.name.startsWith('dsh-auth-'))?.name;
    return {
      state: state.result?.result?.value,
      authorities: authAuthorities(c.result?.cookies),
      authName,
      href: href.result?.result?.value,
    };
  };

  const before = await snap();
  console.log('before : ' + JSON.stringify(before));

  if (!stale) {
    console.log('(no stale cookie value given — 只观察，不注入)');
  } else {
    // 关键：必须按 domain+path 精确删掉原 cookie 再注入同名同域的值。
    // 用 url 形式注入会和 domain 形式的原 cookie 并存，请求时原值仍然被带上，
    // 服务器照旧认它 —— 实验就白做了（实测验证过这一点）。
    const DOMAIN = '192.168.50.58';
    await ws.call('Network.deleteCookies', {
      name: before.authName, domain: DOMAIN, path: '/',
    });
    const r = await ws.call('Network.setCookie', {
      name: before.authName,
      value: stale,
      domain: DOMAIN,
      path: '/',
      httpOnly: true, secure: false, sameSite: 'Strict',
    });
    console.log('setCookie success=' + (r.result?.success ?? 'n/a'));

    // 注入校验：读回的 authority 必须就是失效值，否则实验前提不成立。
    const check = await snap();
    console.log('injected: ' + JSON.stringify({ authorities: check.authorities, state: check.state }));
    if (!check.authorities.some((a) => a.startsWith('127.0.0.1:1'))) {
      console.log('!! 注入未生效（期望出现 authority=127.0.0.1:1），实验中止');
      ws.sock.end();
      process.exit(2);
    }

    await ws.call('Page.reload', { ignoreCache: true });
    console.log('reload issued, tracing...');
  }

  const t0 = Date.now();
  let lastKey = '';
  while (Date.now() - t0 < total) {
    await new Promise((r) => setTimeout(r, step));
    let s;
    try { s = await snap(); } catch (e) { console.log(`  +${Date.now() - t0}ms  (nav in flight: ${e.message})`); continue; }
    const key = `${s.state}|${s.authorities.join(',')}`;
    if (key !== lastKey) {
      lastKey = key;
      console.log(`  +${String(Date.now() - t0).padStart(5)}ms  ${s.state.padEnd(9)} auth=[${s.authorities.join(' ')}]  href=${s.href}`);
    }
  }

  ws.sock.end();
  process.exit(0);
}

main().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
