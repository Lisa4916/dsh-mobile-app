// 重建 CDP 转发：App 每次重装/重启，webview_devtools_remote 的 socket 名都会变。
// 用法：node cdp-forward.cjs
const { execFileSync } = require('node:child_process');
const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';
const SERIAL = '8PCE7LJB99VG7TRO';

function adb(args) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
}

const raw = adb(['shell', 'cat', '/proc/net/unix']);
const line = raw.split(/\r?\n/).find((l) => l.includes('@webview_devtools_remote_') && !l.includes('browser_'));
if (!line) {
  console.error('没找到 webview_devtools_remote（App 未启动或未开调试）');
  process.exit(1);
}
const m = /@(webview_devtools_remote_\d+)/.exec(line);
const name = m[1];
try { adb(['forward', '--remove-all']); } catch {}
const out = adb(['forward', `tcp:9222`, `localabstract:${name}`]);
console.log(`forward tcp:9222 → ${name} (${out})`);
