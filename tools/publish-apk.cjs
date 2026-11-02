// 把最新构建产物发布成「另一部手机能自己装」的东西。
//
// 目标不是「拷个 APK 过去」，而是**让另一台手机以后也能收到更新**。
// 所以这里做三件事：
//   1. release APK（R8 过一遍）+ 稳定文件名（带版本号，方便肉眼区分）
//   2. `latest.json` 清单（版本号 / 大小 / SHA-256 / 构建时间）—— 更新检查的判据
//   3. `dist/index.html` 一个自包含的下载页 —— 另一台手机浏览器打开即可下载安装
//
// 用法：
//   node tools/publish-apk.cjs                # 构建 + 发布到 dist/
//   node tools/publish-apk.cjs --no-build     # 复用已有产物，只重新打包
//   node tools/publish-apk.cjs --bump patch   # 先把 version.properties 的 patch 号 +1
//
// 为什么默认走 release 而不是 debug：
//   debug 包带 `android:debuggable="true"`，运行慢、体积大 3.7 倍（7.3MB vs 2.0MB），
//   而且 WebView 调试开关是打开的。给第二台日常用的手机，装 release。
//   两个包用的是**同一张 debug 证书**（见 app/build.gradle.kts 的 releaseLocal），
//   所以互相覆盖安装不会冲突，可以随时在两种包之间来回切。
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const GRADLE = 'C:\\Users\\yaoqi\\AppData\\Local\\Temp\\gradle-short\\gradle-8.9\\bin\\gradle.bat';
const APK_SRC = path.join(ROOT, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const bumpIdx = argv.indexOf('--bump');
const bumpKind = bumpIdx >= 0 ? (argv[bumpIdx + 1] || 'patch') : null;

function sh(cmd, args, opts) {
  // gradle.bat 是批处理文件，Node 直接 spawn 会 ENOENT —— 必须交给 shell。
  // 用 shell:true 时整条命令要拼成一个字符串（参数里的空格/反斜杠得自己加引号）。
  const line = [cmd].concat(args).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return execFileSync(line, { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000, shell: true, ...opts });
}

function readVersion() {
  const f = path.join(ROOT, 'version.properties');
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return { code: Number(out.versionCode), name: out.versionName };
}

function writeVersion(code, name) {
  const f = path.join(ROOT, 'version.properties');
  const old = fs.readFileSync(f, 'utf8');
  const next = old
    .replace(/^versionCode\s*=.*$/m, `versionCode=${code}`)
    .replace(/^versionName\s*=.*$/m, `versionName=${name}`);
  fs.writeFileSync(f, next, 'utf8');
}

/** 发版前 bump：patch / minor / major。versionCode 永远单调 +1。 */
function bump(kind) {
  const v = readVersion();
  const parts = v.name.split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0; }
  else if (kind === 'minor') { parts[1] += 1; parts[2] = 0; }
  else { parts[2] += 1; }
  const next = { code: v.code + 1, name: parts.join('.') };
  writeVersion(next.code, next.name);
  console.log(`版本 ${v.name}(${v.code}) → ${next.name}(${next.code})`);
  return next;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (bumpKind) bump(bumpKind);
  const v = readVersion();

  if (!noBuild) {
    console.log('构建 release …');
    sh(GRADLE, [
      '-p', ROOT,
      ':app:assembleRelease',
      '-PversionCode=' + v.code, // 冗余但无害：version.properties 已经是事实来源
    ]);
  }

  if (!fs.existsSync(APK_SRC)) {
    throw new Error(`找不到产物 ${APK_SRC}。先跑一次 :app:assembleRelease。`);
  }

  fs.mkdirSync(DIST, { recursive: true });

  // 稳定文件名：dsh-remote-<versionName>-<versionCode>.apk
  // 另一台手机装完看一眼「设置 → 应用」就知道装的是哪一版，不用猜。
  const apkName = `dsh-remote-${v.name}-${v.code}.apk`;
  const apkOut = path.join(DIST, apkName);
  fs.copyFileSync(APK_SRC, apkOut);
  // 同时保留一个固定名，方便做「永远下最新」的链接
  fs.copyFileSync(APK_SRC, path.join(DIST, 'dsh-remote-latest.apk'));

  const size = fs.statSync(apkOut).size;
  const digest = sha256(apkOut);
  const manifest = {
    versionCode: v.code,
    versionName: v.name,
    fileName: apkName,
    sizeBytes: size,
    sha256: digest,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DIST, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 自包含下载页：不引外部 CSS/JS，手机离线也能打开（只要 APK 在同目录）
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 手机遥控 ${v.name}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:28px 20px 48px;background:#151517;color:#e9eaee;
       font:16px/1.6 -apple-system,"Noto Sans CJK SC",sans-serif}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#8a90a0;font-size:13px;margin-bottom:24px}
  a.btn{display:block;text-align:center;text-decoration:none;background:#4f6ef7;color:#fff;
        padding:16px;border-radius:12px;font-size:17px;font-weight:600}
  a.btn:active{background:#3a55cc}
  table{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px}
  td{padding:9px 0;border-bottom:1px solid #26262b;vertical-align:top}
  td:first-child{color:#8a90a0;width:34%;white-space:nowrap}
  td:last-child{font-family:ui-monospace,Menlo,monospace;word-break:break-all}
  .note{color:#8a90a0;font-size:12.5px;margin-top:22px;line-height:1.7}
  code{background:#24242a;padding:1px 5px;border-radius:4px}
</style>
<h1>DSH 手机遥控</h1>
<div class="sub">版本 ${v.name} · build ${v.code} · ${(size / 1048576).toFixed(2)} MB</div>
<a class="btn" href="${apkName}">下载并安装</a>
<table>
  <tr><td>版本</td><td>${v.name} (${v.code})</td></tr>
  <tr><td>文件</td><td>${apkName}</td></tr>
  <tr><td>SHA-256</td><td>${digest}</td></tr>
  <tr><td>构建时间</td><td>${manifest.builtAt}</td></tr>
</table>
<div class="note">
  装不上时看这里：<br>
  · 提示「已安装了其他版本」→ 两台手机的包来自不同签名，需要先卸载旧版；<br>
  · 提示「未知来源」→ 在浏览器里允许一次「安装未知应用」；<br>
  · 覆盖安装**不会**丢已保存的连接，卸载才会。
</div>
</html>
`;
  fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');

  console.log('');
  console.log(`产物   ${apkOut}`);
  console.log(`大小   ${size} B (${(size / 1048576).toFixed(2)} MB)`);
  console.log(`SHA256 ${digest}`);
  console.log(`清单   ${path.join(DIST, 'latest.json')}`);
  console.log(`下载页 ${path.join(DIST, 'index.html')}`);
}

main();
