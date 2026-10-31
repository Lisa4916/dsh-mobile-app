// 通过 CDP 验证键盘避让：测量键盘弹出前后的视口高度与输入框位置
// 用纯 Node 实现最小 WebSocket 客户端，避免额外依赖
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

const PORT = 9222;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

// 极简 WebSocket 客户端（只处理文本帧，够用于 CDP）
function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let handshook = false;
    let buf = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 1;

    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, 0x80 | len]);
      } else if (len < 65536) {
        header = Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff]);
      } else {
        header = Buffer.alloc(8);
        header[0] = 0x81; header[1] = 0x80 | 127;
        header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 4);
      }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    }

    function onFrame(frame) {
      try {
        const msg = JSON.parse(frame.toString('utf8'));
        if (msg.id && pending.has(msg.id)) {
          const { res } = pending.get(msg.id);
          pending.delete(msg.id);
          res(msg);
        }
      } catch {}
    }

    function parseFrames() {
      while (buf.length >= 2) {
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const frame = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        onFrame(frame);
      }
    }

    sock.on('data', (chunk) => {
      if (!handshook) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        buf = buf.subarray(idx + 4);
        handshook = true;
        resolve({
          call(method, params) {
            const id = nextId++;
            return new Promise((res) => {
              pending.set(id, { res });
              send({ id, method, params });
            });
          },
          close() { try { sock.destroy(); } catch {} },
        });
        parseFrames();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      parseFrames();
    });

    sock.on('error', reject);
  });
}

async function evaluate(client, expr) {
  const r = await client.call('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });
  if (r.result?.exceptionDetails) {
    return { error: r.result.exceptionDetails.text ?? 'exception' };
  }
  return { value: r.result?.result?.value };
}

const MEASURE = `JSON.stringify({
  innerHeight: window.innerHeight,
  innerWidth: window.innerWidth,
  vvHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
  vvOffsetTop: window.visualViewport ? Math.round(window.visualViewport.offsetTop) : null,
  docH: document.documentElement.clientHeight,
  scrollY: Math.round(window.scrollY)
})`;

(async () => {
  const targets = await getJson('/json');
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO PAGE TARGET'); process.exit(1); }
  console.log('target:', page.title);
  console.log('url:', page.url);

  const client = await wsConnect(page.webSocketDebuggerUrl.replace('127.0.0.1:9222', `127.0.0.1:${PORT}`));
  await client.call('Runtime.enable', {});

  const before = await evaluate(client, MEASURE);
  console.log('\n[键盘收起]', before.value);

  // 找到页面里的输入框并聚焦（DSH 的 composer 是 contenteditable 或 textarea）
  const focusRes = await evaluate(client, `(function(){
    const sel = ['textarea','[contenteditable="true"]','[contenteditable=""]','input[type=text]'];
    for (const s of sel) {
      const els = [...document.querySelectorAll(s)].filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 40 && r.height > 10;
      });
      if (els.length) {
        const el = els[els.length - 1];
        el.focus();
        const r = el.getBoundingClientRect();
        return JSON.stringify({ tag: el.tagName, selector: s, rect: {top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height)} });
      }
    }
    return 'NOT_FOUND';
  })()`);
  console.log('[聚焦输入框]', focusRes.value);

  await new Promise((r) => setTimeout(r, 2000));

  const after = await evaluate(client, MEASURE);
  console.log('[键盘弹出后]', after.value);

  // 再量输入框自身位置，看是否被顶上来
  const elPos = await evaluate(client, `(function(){
    const sel = ['textarea','[contenteditable="true"]','[contenteditable=""]','input[type=text]'];
    for (const s of sel) {
      const els = [...document.querySelectorAll(s)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
      if (els.length) {
        const r = els[els.length-1].getBoundingClientRect();
        return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom) });
      }
    }
    return 'NOT_FOUND';
  })()`);
  console.log('[输入框位置]', elPos.value);

  const b = JSON.parse(before.value || '{}');
  const a = JSON.parse(after.value || '{}');
  console.log('\n=== 判定 ===');
  console.log('高度变化 innerHeight:', b.innerHeight, '->', a.innerHeight, '(差', (b.innerHeight||0) - (a.innerHeight||0), 'px)');
  console.log('高度变化 vvHeight   :', b.vvHeight, '->', a.vvHeight, '(差', (b.vvHeight||0) - (a.vvHeight||0), 'px)');

  client.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
