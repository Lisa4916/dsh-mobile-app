// gradle.bat 的位置探测 —— 抽成纯函数，好被单测钉住。
//
// 背景：`publish-apk.cjs` 原先写死
// `C:\Users\<user>\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat`。
// `%TEMP%` 会被系统清理 —— 2026-11 实测该目录已消失，构建报「路径不存在」，
// 而它和「没装 Gradle」是同一副面孔（`kb/03-build-env.md` 现象 3），极易被误判成
// 代码问题或版本冲突。所以这里按顺序探测，并在全都不存在时**列出全部候选**，
// 而不是静默退回到某个可能版本不对的 Gradle。
//
// 硬约束：候选里**只能有 8.9**。本机缓存里的 gradle-9.4.1 与 AGP 8.7.3 不兼容
// （`kb/03-build-env.md` 现象 2），探测逻辑不许「找不到 8.9 就随便拿一个」。
const fs = require('fs');
const os = require('os');
const path = require('path');

const GRADLE_VERSION = 'gradle-8.9';
const GRADLE_BIN = path.join(GRADLE_VERSION, 'bin', 'gradle.bat');

/**
 * 候选路径，按优先级从高到低。
 * `%TEMP%` 排第二而不是第一：它不可靠（会被系统清理），但历史上曾放在那里，
 * 别人机器上可能还留着，所以保留为次选而不是删掉。
 */
function gradleCandidates(env = process.env) {
  const temp = (env.TEMP || env.TMP || '').trim() || os.tmpdir();
  return [
    `D:\\AndroidDev\\${GRADLE_BIN}`,
    path.join(temp, 'gradle-short', GRADLE_BIN),
    `C:\\Gradle\\${GRADLE_BIN}`,
  ];
}

/**
 * 返回第一个存在的候选；一个都不存在就抛错，错误里带上全部候选路径。
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string) => boolean} exists 注入点，测试用
 */
function resolveGradle(env = process.env, exists = fs.existsSync) {
  const cands = gradleCandidates(env);
  const hit = cands.find((p) => exists(p));
  if (hit) return hit;
  throw new Error(
    `找不到 ${GRADLE_VERSION} 的 gradle.bat。候选路径都不存在：\n` +
      cands.map((p) => `  - ${p}`).join('\n') +
      `\n请把 ${GRADLE_VERSION} 解压到其中任一路径。注意：不要用 gradle-9.x 顶替，` +
      `它与 AGP 8.7.3 不兼容（kb/03-build-env.md 现象 2）。`,
  );
}

module.exports = { GRADLE_VERSION, gradleCandidates, resolveGradle };
