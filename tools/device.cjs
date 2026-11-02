// 解析要操作的设备序列号。**不要硬编码** —— 本项目换过机器
// （Redmi 8PCE7LJB99VG7TRO → motorola ZY22GHMK5F，可能还有第三台），
// 写死的后果是脚本报 `device 'xxx' not found`，而人往往把它当成
// 「App 坏了」或「点击没反应」，做出错误结论。
//
// 优先级：
//   1. 显式参数（`<serial>` 位置参数）
//   2. 环境变量 DEV_SERIAL
//   3. 当前唯一一台 `adb devices` 里状态为 device 的机器
//
// 有且只有一台时直接用它；零台或多台且没显式指定 → 报错退出，
// **绝不猜**。猜错的代价比报错大得多。
const { execFileSync } = require('child_process');

const ADB = 'D:\\AndroidDev\\sdk\\platform-tools\\adb.exe';

/**
 * @param {string|undefined} explicit 位置参数里给的序列号
 * @returns {string}
 */
function resolveSerial(explicit) {
  const fromArgv = (explicit || '').trim();
  if (fromArgv) return fromArgv;

  const fromEnv = (process.env.DEV_SERIAL || '').trim();
  if (fromEnv) return fromEnv;

  const raw = execFileSync(ADB, ['devices'], { encoding: 'utf8', timeout: 15000 });
  const online = raw
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0]);

  if (online.length === 1) return online[0];
  if (online.length === 0) {
    throw new Error('没有在线设备（adb devices 为空）。接上手机或开无线调试后再试。');
  }
  throw new Error(
    `有 ${online.length} 台在线设备，无法确定用哪台：${online.join(', ')}。` +
      '请用参数或 DEV_SERIAL 指定。'
  );
}

module.exports = { ADB, resolveSerial };
