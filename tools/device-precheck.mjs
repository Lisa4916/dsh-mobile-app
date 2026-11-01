// 装 APK 到任何新设备后的第一件事：一次性把「会绊住你的事实」全部量出来。
//
// 为什么要有这个脚本：android 开发的弯路大多不是逻辑难，而是**环境事实不可见**。
// 这些问题本次会话全都真实踩过，每一条都花掉好几轮：
//
//   1. 系统 WebView 版本远低于预期（Android 14 出厂只有 117）→ 前端缺 Promise.withResolvers
//      → 页面能画出来但永远卡在加载。症状看着像网络问题，查 logcat 才发现是 JS 崩溃。
//   2. 设备开了应用分身/工作资料 → adb install -r 会装进所有用户 → 启动时弹
//      「选择要使用的应用程序」，三个同名入口，App 起不来。
//   3. 无线调试的配对端口是临时的、配对码随弹窗刷新而失效 → 用错端口/旧码必失败。
//   4. 从设备侧 ping 不通不等于网络不通（Android 默认禁 ping），要改用 curl 探 HTTP。
//
// 用法：
//   node tools/device-precheck.mjs                  # 用唯一在线设备
//   node tools/device-precheck.mjs --serial XXXX     # 指定设备
//   node tools/device-precheck.mjs --serial XXXX --pkg com.dsh.remote
//   node tools/device-precheck.mjs --serial XXXX --url http://192.168.50.58:3081/
//
// 前提：adb 在 PATH，或设置 ADB 环境变量指向绝对路径。
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const ADB = process.env.ADB || 'adb';
const PKG = opt('pkg', 'com.dsh.remote');
const TARGET_URL = opt('url', '');

function adb(args, { allowFail = true } = {}) {
  try {
    return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (!allowFail) throw e;
    return (e.stdout || '').trim() || `<failed: ${(e.stderr || e.message || '').trim().split('\n')[0]}>`;
  }
}

function pickSerial() {
  const explicit = opt('serial', '');
  if (explicit) return explicit;
  const out = adb(['devices']);
  const lines = out.split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('*'));
  const ready = lines.filter((l) => l.includes('device') && !l.includes('offline') && !l.includes('unauthorized'));
  if (ready.length === 0) {
    console.error('没有可用设备。先 adb pair/connect，或插好 USB 并授权调试。');
    process.exit(2);
  }
  if (ready.length > 1) {
    console.error(`在线设备有 ${ready.length} 台，请用 --serial= 指定：`);
    ready.forEach((l) => console.error('  ' + l.split(/\s+/)[0]));
    process.exit(2);
  }
  return ready[0].split(/\s+/)[0];
}

const serial = pickSerial();
const S = ['-s', serial];
const sh = (cmd) => adb([...S, 'shell', cmd]);

const sections = [];
const section = (title, rows) => sections.push({ title, rows });
const ok = (v) => (v ? 'OK' : '!!');

// ---------------------------------------------------------------- 1. 设备与系统
const model = sh('getprop ro.product.model');
const brand = sh('getprop ro.product.brand');
const rel = sh('getprop ro.build.version.release');
const sdk = sh('getprop ro.build.version.sdk');
const abi = sh('getprop ro.product.cpu.abi');
const userBuild = sh('getprop ro.build.type');
section('设备与系统', [
  ['serial', serial],
  ['model', `${brand} ${model}`],
  ['Android', `${rel} (SDK ${sdk})`],
  ['abi', abi],
  ['build type', userBuild],
]);

// ---------------------------------------------------------------- 2. WebView 基线（关键）
// 注意：`dumpsys webviewupdate` 里有两处相似的行——
//   Current WebView package (name, version): (com.google.android.webview, 117.0.5938.60)
//   Preferred WebView package (name, version): (...)
// 坑点：行内**本身就是字面的 "(name, version)"**，若直接用一个宽泛的正则，
// 会先匹配到那个占位符，结果解析出 provider="name"、version="version"（实测踩过）。
// 所以只取**最后一个**括号组，并且要求里面含数字版本号。
const wvDump = sh('dumpsys webviewupdate');
const curLine = (wvDump.split(/\r?\n/).find((l) => l.includes('Current WebView package')) || '');
const parenGroups = [...curLine.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
const realGroup = parenGroups.reverse().find((g) => /\d+\.\d+/.test(g)) || '';
const [wvPkgRaw, wvVerRaw] = realGroup.split(',').map((s) => (s || '').trim());
const wvPkg = wvPkgRaw || '(unknown)';
const wvVer = wvVerRaw || '(unknown)';
const wvMajor = Number((wvVer.match(/^(\d+)/) || [])[1] || 0);

// Chrome/WebView 版本 → 关键 API 起始版本。只有落在这几个坎上才有意义。
const API_GATES = [
  { api: 'Promise.withResolvers', chrome: 119 },
  { api: 'Array.fromAsync', chrome: 121 },
  { api: 'RegExp.escape', chrome: 136 },
];
const risky = API_GATES.filter((g) => wvMajor && wvMajor < g.chrome);
section('WebView 基线（最容易被忽略的一条）', [
  ['provider', wvPkg],
  ['version', wvVer],
  ['major', wvMajor || '(unknown)'],
  ['低于基线的 API', risky.length
    ? risky.map((g) => `${g.api}(需 ${g.chrome}+)`).join(', ')
    : '无（或版本未识别）'],
  ['建议', wvMajor && wvMajor < 119
    ? '必须做 document-start polyfill；否则前端可能在初始化就抛异常 → 页面能画出来但卡在加载'
    : '暂无 polyfill 必要，但仍建议保留空转守卫'],
]);

// ---------------------------------------------------------------- 3. 多用户 / 应用分身（启动冲突根因）
// grep 的引号在 adb shell 里容易被吃掉，这里统一「整段输出回 JS 再判」。
const usersOut = sh('pm list users');
const users = [...usersOut.matchAll(/UserInfo\{(\d+):([^:]+)/g)].map((m) => ({ id: Number(m[1]), name: m[2] }));
const installedIn = [];
for (const u of users) {
  const r = sh(`pm list packages --user ${u.id}`);
  if (r.split('\n').some((l) => l.trim() === `package:${PKG}`)) installedIn.push(u.id);
}
section(`应用分身 / 多用户（目标包 ${PKG}）`, [
  ['用户数', `${users.length}  ${users.map((u) => `${u.id}:${u.name}`).join('  ')}`],
  ['目标包已装用户', installedIn.length ? installedIn.join(', ') : '(未安装)'],
  ['风险', installedIn.length > 1
    ? '!! 装在多个用户下 → 点图标会弹「选择要使用的应用程序」。用 adb install --user 0 只装机主，并先卸载其余'
    : '无（只在一个用户下）'],
]);

// ---------------------------------------------------------------- 4. 无线调试（配对端口是临时的）
const mdns = adb(['mdns', 'services']);
const pairingLines = mdns.split('\n').filter((l) => l.includes('_adb-tls-pairing'));
const connectLines = mdns.split('\n').filter((l) => l.includes('_adb-tls-connect'));
section('无线调试（若走 Wi-Fi）', [
  ['mdns pairing', pairingLines.length ? pairingLines.map((l) => l.split(/\s+/).pop()).join(', ') : '(无)' ],
  ['mdns connect', connectLines.length ? connectLines.map((l) => l.split(/\s+/).pop()).join(', ') : '(无)'],
  ['提示', '配对端口是弹窗打开时临时生的，配对码随刷新失效。先 adb pair（用 pairing 端口），再 adb connect（用 connect 端口或 5555）'],
]);

// ---------------------------------------------------------------- 5. 屏幕与密度（坐标换算必用）
const size = sh('wm size');
const density = sh('wm density');
section('屏幕与密度（算 input tap 坐标必用）', [
  ['wm size', size.replace(/\n/g, ' | ')],
  ['wm density', density.replace(/\n/g, ' | ')],
  ['换算提醒', 'CSS 坐标 × devicePixelRatio = 物理像素坐标，input tap 用的是后者。'
    + ' WebView 里取 dpr：window.devicePixelRatio'],
]);

// ---------------------------------------------------------------- 6. 包安装状态与签名
const pkgDump = sh(`dumpsys package ${PKG}`);
const verLine = pkgDump.split('\n').find((l) => l.includes('versionName=')) || '';
section(`安装状态（${PKG}）`, [
  ['版本', verLine.trim() || '(未安装 / 未取到)'],
]);

// ---------------------------------------------------------------- 7. 目标站点可达性（用 curl 不用 ping）
if (TARGET_URL) {
  const curlQuote = `'${TARGET_URL.replace(/'/g, `'\\''`)}'`;
  const code = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${curlQuote} 2>/dev/null || echo NO_CURL`);
  section('目标站点可达性（从设备侧）', [
    ['URL', TARGET_URL],
    ['HTTP 状态', code],
    ['提醒', 'Android 默认禁 ICMP，ping 不通不代表网络不通；要用 curl 探 HTTP。'
      + ' 若返回 401 且是反向代理场景，注意请求是否携带了会话 cookie'],
  ]);
} else {
  section('目标站点可达性（从设备侧）', [
    ['状态', '(跳过，未提供 --url)'],
    ['提示', '加 --url=http://<电脑IP>:<端口>/ 可以探一次 HTTP，比 ping 可靠'],
  ]);
}

// ---------------------------------------------------------------- 8. 近期 console 异常（页面卡加载的定案证据）
const consoleErr = adb([...S, 'logcat', '-d', '-s', 'chromium:I']);
const consoleLines = consoleErr.split('\n').filter((l) => l.includes('INFO:CONSOLE')).slice(-6);
// 只留报错正文，砍掉后面那一长串 plugins/?? 的 URL（能占满一屏，淹没重点）
const trimConsole = (l) => {
  const m = l.match(/"([^"]+)"/);
  return m ? m[1].slice(0, 120) : l.slice(0, 120);
};
const apiErrors = consoleLines.filter((l) => /is not a function|is not defined|Uncaught/.test(l));
section('近期 WebView console（定案「卡在加载」用）', [
  ['最近条目', consoleLines.length ? '\n    ' + consoleLines.map(trimConsole).join('\n    ') : '(无)'],
  ['API 缺失类报错', apiErrors.length ? '!! ' + apiErrors.map(trimConsole).join(' / ') : '无'],
  ['提醒', '看到 "xxx is not a function" 基本都是运行时 API 缺失，不是网络问题'],
]);

// ---------------------------------------------------------------- 输出
const W = 64;
console.log('\n' + '='.repeat(W));
console.log(`设备预检：${serial}`);
console.log('='.repeat(W));
for (const s of sections) {
  console.log(`\n## ${s.title}`);
  for (const [k, v] of s.rows) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
}
console.log('\n' + '-'.repeat(W));
const mustFix = [];
if (wvMajor && wvMajor < 119) mustFix.push('WebView 低于 119 → 需要 document-start polyfill（见知识库「WebView 运行时基线」）');
if (installedIn.length > 1) mustFix.push('包装在多个用户下 → 改用 adb install --user 0，否则启动会弹选择框');
if (!mustFix.length) {
  console.log('未发现阻塞项。可以继续装机验证。');
} else {
  console.log('按顺序处理这些阻塞项：');
  mustFix.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
}
console.log('-'.repeat(W) + '\n');
