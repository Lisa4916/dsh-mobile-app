// 在局域网里把 dist/ 目录发布成一个「装 App / 收更新」的页面。
//
// 为什么要有这个：另一台手机不是开发机，没法跑 adb，也不该为了装个包去连电脑。
// 起一个只读静态服务器，另一台手机用浏览器打开 `http://<本机IP>:8123/` 就能下载安装；
// 以后每次重新 `publish-apk.cjs`，手机上刷新同一个地址就是新版本。
//
// 用法：
//   node tools/serve-apk.cjs            # 默认 0.0.0.0:8123
//   node tools/serve-apk.cjs 9000       # 指定端口
//
// 安全边界：只监听**局域网**用途，没有鉴权，也不要放到公网。
// 包里是 release APK（不含任何 PIN —— PIN 在每台手机自己的 SharedPreferences 里）。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.argv[2] || 8123);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** 找出本机的局域网 IPv4，打印给用户照着输。 */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 169.254.x 是链路本地，手机连不到；跳过免得误导
      if (a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

function latest() {
  const f = path.join(DIST, 'latest.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, headers) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  // 给更新检查用的极简接口：手机端（或以后 App 内自更新）读它比大小/比版本
  if (url === '/version.json' || url === '/latest.json') {
    const m = latest();
    if (!m) return send(res, 404, '{"error":"no build published yet"}', { 'Content-Type': MIME['.json'] });
    return send(res, 200, JSON.stringify(m, null, 2), { 'Content-Type': MIME['.json'] });
  }

  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const target = path.join(DIST, rel);

  // 目录穿越防护：解析后必须仍在 DIST 里
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(DIST) + path.sep) && resolved !== path.resolve(DIST)) {
    return send(res, 403, 'forbidden');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return send(res, 404, 'not found');
  }

  const stat = fs.statSync(resolved);
  const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';

  // APK 支持 Range —— 手机上断点续传/暂停再下时不至于从头来
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = s ? Number(s) : 0;
    const end = e ? Number(e) : stat.size - 1;
    if (start >= stat.size || end < start) {
      return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(resolved, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(resolved).pipe(res);
});

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('dist/ 里还没有产物。先跑：node tools/publish-apk.cjs\n');
}

server.listen(PORT, HOST, () => {
  const m = latest();
  const addrs = lanAddresses();
  console.log('DSH 手机遥控 · 更新分发');
  console.log('');
  if (m) console.log(`当前版本  ${m.versionName} (${m.versionCode})  ${(m.sizeBytes / 1048576).toFixed(2)} MB`);
  else console.log('当前版本  （尚未发布）');
  console.log('');
  console.log('另一台手机在**同一 Wi-Fi** 下用浏览器打开：');
  if (addrs.length === 0) {
    console.log('  ⚠ 没找到局域网 IPv4 地址，检查是否连着 Wi-Fi');
  } else {
    for (const a of addrs) console.log(`  http://${a.address}:${PORT}/     （${a.name}）`);
  }
  console.log('');
  console.log('更新流程：改完代码 → node tools/publish-apk.cjs → 手机刷新同一个地址');
  console.log('Ctrl+C 停止');
});
