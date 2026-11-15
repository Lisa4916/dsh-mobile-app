// 自测：gradle.bat 的探测逻辑。
//
// 为什么要有这条测试：原先 publish-apk.cjs 把路径写死在 `%TEMP%\gradle-short\...`，
// 而 `%TEMP%` 会被系统清理 —— 2026-11 实测目录已消失，构建直接报「路径不存在」，
// 与「没装 Gradle」是同一副面孔（kb/03-build-env.md 现象 3）。写死一次就够了，
// 所以把探测抽成纯函数并钉住它的三条行为：
//   1. 按候选顺序取第一个存在的；
//   2. 一个都不存在时，抛错信息里要列出全部候选（不许静默用错的版本）；
//   3. 候选列表里 `%TEMP%` 那条永远排在 D:\AndroidDev 之后（%TEMP% 不可靠）。
//
// 跑法：node --test tools/__tests__/
const test = require('node:test');
const assert = require('node:assert');

const { gradleCandidates, resolveGradle } = require('../lib/gradle-path.cjs');

test('候选顺序：D:\\AndroidDev 优先于 %TEMP%，%TEMP% 优先于兜底', () => {
  const c = gradleCandidates({ TEMP: 'C:\\Temp' });
  assert.strictEqual(c[0], 'D:\\AndroidDev\\gradle-8.9\\bin\\gradle.bat');
  assert.ok(c[1].startsWith('C:\\Temp'), `第二候选应落在 TEMP 下，实际 ${c[1]}`);
  assert.ok(c[1].endsWith('gradle-8.9\\bin\\gradle.bat'));
});

test('TEMP 未设置时不留出畸形路径', () => {
  const c = gradleCandidates({});
  assert.ok(c.every((p) => p && !p.includes('undefined')), `候选里出现畸形路径：${c.join(' | ')}`);
});

test('取第一个存在的候选', () => {
  const hit = 'D:\\AndroidDev\\gradle-8.9\\bin\\gradle.bat';
  const got = resolveGradle({ TEMP: 'C:\\Temp' }, (p) => p === hit);
  assert.strictEqual(got, hit);
});

test('前一个不存在就退到下一个', () => {
  const got = resolveGradle({ TEMP: 'C:\\Temp' }, (p) => p.includes('C:\\Temp'));
  assert.ok(got.includes('C:\\Temp'), `应退到 TEMP 候选，实际 ${got}`);
});

test('全都不存在时抛错，且错误里列出每一个候选', () => {
  const cands = gradleCandidates({ TEMP: 'C:\\Temp' });
  assert.throws(
    () => resolveGradle({ TEMP: 'C:\\Temp' }, () => false),
    (err) => {
      assert.match(err.message, /gradle/i);
      for (const c of cands) {
        assert.ok(err.message.includes(c), `错误信息漏了候选 ${c}`);
      }
      return true;
    },
  );
});
