// 通过 monkey 精确注入一次点击，绕开 MIUI 对 `input tap` 的注入拒绝。
//
// 为什么需要它：MIUI（本机 Redmi 23054RA19C / Android 15）会拦掉 `adb shell input tap`，
// logcat 里是 `InputManager: Input event injection from pid N failed`，
// 事件根本没送到 App —— 于是任何「点了没反应」的结论都是假阴性。
// `monkey -f <脚本>` 的注入被允许，同样的坐标就能点中。
//
// 判据只看 `Events injected` 是否非 0。monkey 末尾那行
// `Dropped: keys=0 pointers=1 ...` 在点击**正常生效**时也会出现 pointers=1，
// 所以它不代表失败，别拿它做判断。
//
// 用法（在 PowerShell 里）：
//   node .\tools\tap.cjs <x> <y> [serial]
// 例：
//   node .\tools\tap.cjs 540 613 8PCE7LJB99VG7TRO
const { execFileSync } = require('child_process');

const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';

const x = process.argv[2];
const y = process.argv[3];
const serial = process.argv[4];

if (!x || !y) {
  console.error('用法: node tap.cjs <x> <y> [serial]');
  process.exit(1);
}

const script = [
  'type= raw events',
  'count= 2',
  'speed= 1.0',
  'start data >>',
  `DispatchPointer(0,0,0,${x},${y},0,0,0,0,0,0,0)`,
  `DispatchPointer(0,0,1,${x},${y},0,0,0,0,0,0,0)`,
].join('\n');

const base = serial ? ['-s', serial] : [];
const run = (args, input) =>
  execFileSync(ADB, args, {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });

// 脚本内容里含换行，用 base64 送进去，避免引号与换行在 shell 里被吃掉。
const b64 = Buffer.from(script + '\n', 'utf8').toString('base64');
run([...base, 'shell', `echo ${b64} | base64 -d > /data/local/tmp/tap.txt`]);

const out = run([...base, 'shell', 'monkey', '-p', 'com.dsh.remote', '-f', '/data/local/tmp/tap.txt', '-v', '6']);

const injected = Number((out.match(/Events injected: (\d+)/) || [])[1] || 0);
console.log(`点击 (${x}, ${y})：Events injected = ${injected}`);
if (injected === 0) {
  console.log('⚠ 注入数为 0，这次点击没生效。');
  process.exit(2);
}
