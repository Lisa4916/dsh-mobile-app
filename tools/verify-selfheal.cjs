// 同一进程内验证「访问验证页自愈」：
//   1) 把 dsh_pocket_token 改成失效值（模拟 Harness 重启后 sessionKey 变化）
//   2) 让 WebView reload 到根路径 —— 坏 cookie 必然把页面打成「DSH Pocket · 访问验证」
//   3) 观察 App 的 HEAL_PROBE_JS 是否能识别 '2' 并自动清 cookie 重连回主界面
//
// 为什么必须在同一进程内做：CDP 的 Network.setCookie 只保证写进 WebView 活的
// cookie store。杀进程后 WebView 会从磁盘的 Cookies 库恢复，那里面还是旧的好值，
// 于是「重启 App」这个动作反而把故障抹掉了，验不出来。
//
// 用法：node verify-selfheal.cjs [step]
//   step 不填 = 完整流程；step=stale 只弄脏；step=watch 只观察
const http = require('http');

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej);
  });
}

class WS {
  constructor(url) { this.url = url; this.events = []; }
  connect() {
    return new Promise((res, rej) => {
      const u = new URL(this.url);
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      });
      req.on('upgrade', (r, socket) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
        res();
      });
      req.on('error', rej); req.end();
    });
  }
  _drain() {
    while (true) {
      if (this.buf.length < 2) return;
      const b2 = this.buf[1]; let len = b2 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      try {
        const s = JSON.parse(payload.toString('utf8'));
        if (s.id && s.id === this._waitId) {
          const cb = this._waitCb; this._waitId = null; this._waitCb = null; cb(s);
        } else if (s.method) {
          this.events.push(s);
        }
      } catch (e) { /* 忽略非 JSON 帧 */ }
    }
  }
  send(obj) {
    const p = Buffer.from(JSON.stringify(obj));
    const mask = Buffer.from([0, 0, 0, 0]); let head;
    if (p.length < 126) { head = Buffer.from([0x81, 0x80 | p.length]); }
    else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
    this.socket.write(Buffer.concat([head, mask, p]));
  }
  cmd(id, method, params) {
    return new Promise((res) => {
      this._waitId = id; this._waitCb = res;
      this.send({ id, method, params });
      setTimeout(() => { if (this._waitId === id) { this._waitId = null; res({ error: 'timeout' }); } }, 10000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const step = process.argv[2] || 'all';
  const list = JSON.parse(await get('http://127.0.0.1:9222/json'));
  const t = list.find((x) => x.type === 'page');
  if (!t) { console.error('没有 page target'); process.exit(1); }
  const ws = new WS(t.webSocketDebuggerUrl);
  await ws.connect();
  let i = 1;

  await ws.cmd(i++, 'Network.enable', {});
  await ws.cmd(i++, 'Page.enable', {});
  await ws.cmd(i++, 'Runtime.enable', {});

  async function snapshot(tag) {
    const ck = await ws.cmd(i++, 'Network.getCookies', { urls: [t.url] });
    const arr = (ck.result && ck.result.cookies) || [];
    const tok = arr.find((c) => c.name === 'dsh_pocket_token');
    const ev = await ws.cmd(i++, 'Runtime.evaluate', {
      expression: "JSON.stringify({t:document.title, b:(document.body?document.body.innerText:'').slice(0,60)})",
      returnByValue: true,
    });
    let page = {};
    try { page = JSON.parse(ev.result.result.value || '{}'); } catch (e) { page = { t: '?', b: '?' }; }
    console.log(`[${tag}]`);
    console.log(`   title = ${page.t}`);
    console.log(`   body  = ${JSON.stringify((page.b || '').replace(/\s+/g, ' ').trim())}`);
    console.log(`   token = ${tok ? tok.value.slice(0, 16) + '…' : '(无)'}`);
    return { tok, page };
  }

  const before = await snapshot('BEFORE');

  if (step === 'all' || step === 'stale') {
    if (!before.tok) { console.error('没有 dsh_pocket_token，先正常进一次主界面'); process.exit(1); }
    const r = await ws.cmd(i++, 'Network.setCookie', {
      name: 'dsh_pocket_token',
      value: 'deadbeef'.repeat(8),
      domain: before.tok.domain,
      path: before.tok.path || '/',
      httpOnly: true,
      secure: before.tok.secure,
      expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    });
    console.log('弄脏 dsh_pocket_token ->', JSON.stringify(r.result || r.error));
    if (step === 'stale') process.exit(0);
  }

  console.log('\n--- 触发导航到根路径（坏 cookie 生效）---');
  await ws.cmd(i++, 'Page.navigate', { url: 'http://192.168.50.58:3081/' });

  // 观察 25 秒：先看它是否落到「访问验证」，再由 App 的自愈把页面拉回主界面
  const marks = [];
  for (let s = 0; s < 25; s++) {
    await sleep(1000);
    const ev = await ws.cmd(i++, 'Runtime.evaluate', {
      expression: "(document.title||'') + ' | ' + ((document.body?document.body.innerText:'')||'').replace(/\\s+/g,' ').slice(0,40)",
      returnByValue: true,
    });
    const v = (ev.result && ev.result.result && ev.result.result.value) || '(求值失败)';
    if (marks.length === 0 || marks[marks.length - 1].v !== v) {
      marks.push({ t: s, v });
      console.log(`  +${s}s  ${v}`);
    }
  }

  console.log('\n--- RESULT ---');
  const after = await snapshot('AFTER');
  const back = after.page.b && (after.page.b.indexOf('探索未至之境') !== -1 || after.page.b.indexOf('导出会话日志') !== -1);
  console.log(back ? '✅ 自动恢复到主界面' : '❌ 未自动恢复');
  console.log('token 现在 =', after.tok ? after.tok.value.slice(0, 16) + '…' : '(无)');
  process.exit(0);
})();
