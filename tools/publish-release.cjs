// GitHub 上的「另一台手机自动收更新」通道。
//
// 为什么需要它：`serve-apk.cjs` 要求这台电脑开着、两台设备同一 Wi-Fi。
// 走 GitHub Release 之后，手机只需要一个固定网址，任何时候都能下载最新版：
//
//   https://github.com/<owner>/<repo>/releases/latest/download/dsh-remote-latest.apk
//
// 这个地址永远指向**最新一个 Release** 的同名 asset —— 存成书签，以后电脑这边
// `git push --tags`，手机上刷新就是新版。
//
// 用法：
//   node tools/publish-release.cjs                       # bump patch → 打 tag → 推送
//   node tools/publish-release.cjs --bump minor
//   node tools/publish-release.cjs --no-bump             # 用当前 version.properties 打 tag
//   node tools/publish-release.cjs --dry                 # 只打印将要做的事
//
// 前置（脚本会逐条检查，缺什么直接说缺什么）：
//   1. 仓库已配 origin，且指向 GitHub
//   2. git 工作区干净（发版必须是可复现的提交）
//   3. release/dsh-remote.jks 存在（签名用）
//   4. GitHub Actions secrets 已配好 —— 这个脚本查不到，只在 README 里交代
//
// 刻意做的事：
//   - **tag 名与 versionName 绑定**（v0.2.1 ↔ 0.2.1）。release.yml 会二次校验，
//     不一致直接失败，免得 Release 页写的版本和包里不一致。
//   - **不 push 代码，只 push tag**。发版应该对一个已经提交的状态打标，
//     顺手把未提交的改动混进去会让「这个 tag 到底是哪份代码」无法回答。
//   - **不替用户写 commit**。bump 后的 version.properties 需要单独提交，
//     脚本只提示怎么做，不擅自 commit。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const noBump = argv.includes('--no-bump');
const bumpIdx = argv.indexOf('--bump');
const bumpKind = bumpIdx >= 0 ? (argv[bumpIdx + 1] || 'patch') : 'patch';

function git(args, opts) {
  return execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

function fail(msg) {
  console.error('');
  console.error('停：' + msg);
  process.exit(1);
}

function readVersion() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, 'version.properties'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return { code: Number(out.versionCode), name: out.versionName };
}

function writeVersion(code, name) {
  const f = path.join(ROOT, 'version.properties');
  const next = fs
    .readFileSync(f, 'utf8')
    .replace(/^versionCode\s*=.*$/m, `versionCode=${code}`)
    .replace(/^versionName\s*=.*$/m, `versionName=${name}`);
  fs.writeFileSync(f, next, 'utf8');
}

/**
 * 算下一个版本号。`persist = false`（--dry）时**只算不写** ——
 * 第一版不管 dry 都写盘，试跑一次就把 version.properties 改了，
 * 于是 `git status` 变脏、下次真发版的 tag 也跟着错。
 */
function bump(kind, persist) {
  const v = readVersion();
  const parts = v.name.split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') { parts[0] += 1; parts[1] = 0; parts[2] = 0; }
  else if (kind === 'minor') { parts[1] += 1; parts[2] = 0; }
  else { parts[2] += 1; }
  const next = { code: v.code + 1, name: parts.join('.') };
  if (persist) writeVersion(next.code, next.name);
  return { from: v, to: next };
}

function main() {
  // ---- 前置检查 ----
  let remote = '';
  try {
    remote = git(['remote', 'get-url', 'origin']);
  } catch {
    fail('没有配置 origin 远端。先在 GitHub 建一个空仓库，然后：\n' +
         '  git remote add origin https://github.com/<你>/<仓库>.git\n' +
         '  git push -u origin master');
  }
  if (!/github\.com/i.test(remote)) {
    fail(`origin 指向的不是 GitHub（${remote}）。release.yml 只在 GitHub 上生效。`);
  }

  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    fail('工作区不干净。发版必须对一个确定的提交打 tag，先把改动提交掉：\n' +
         dirty.split('\n').map((l) => '  ' + l).join('\n'));
  }

  const jks = path.join(ROOT, 'release', 'dsh-remote.jks');
  if (!fs.existsSync(jks)) {
    fail('找不到 release/dsh-remote.jks。这是 Release 包的签名密钥，丢了就再也覆盖安装不上。\n' +
         '生成方法见 README「用 GitHub Release 发版」。');
  }

  // ---- bump ----
  const v = readVersion();
  if (!noBump) {
    const { from, to } = bump(bumpKind, !dry);
    console.log(`版本 ${from.name}(${from.code}) → ${to.name}(${to.code})${dry ? '（--dry，未写盘）' : ''}`);
    console.log('');
    if (dry) {
      console.log('真实执行时会改 version.properties，并要求你先提交它再打 tag。');
      return;
    }
    console.log('version.properties 已改，需要先提交它再打 tag：');
    console.log('  git add version.properties');
    console.log(`  git commit -m "chore(release): 版本升到 ${to.name}"`);
    console.log('');
    fail('请先提交版本号变更，然后重跑本脚本并加 --no-bump。\n' +
         '（脚本不替你 commit，是为了让「这个 tag 对应哪次提交」永远清楚。）');
  }

  const tag = 'v' + v.name;

  let exists = false;
  try {
    git(['rev-parse', '--verify', `refs/tags/${tag}`]);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) fail(`tag ${tag} 已存在。要先删掉重打：\n  git tag -d ${tag}\n  git push origin :refs/tags/${tag}`);

  const head = git(['log', '-1', '--format=%h %s']);

  console.log('将要做的事：');
  console.log(`  打 tag   ${tag}（versionCode ${v.code}）`);
  console.log(`  当前提交 ${head}`);
  console.log(`  推送到   ${remote}`);
  console.log('');
  console.log('推送后 GitHub Actions 的 release.yml 会：');
  console.log('  1. 校验 tag 与 version.properties 一致');
  console.log('  2. 用 secrets 里的密钥签 release 包');
  console.log('  3. 建 Release 并挂上 APK');
  console.log('');

  if (dry) {
    console.log('（--dry，未执行）');
    return;
  }

  git(['tag', '-a', tag, '-m', `DSH 手机遥控 ${v.name}`]);
  git(['push', 'origin', `refs/tags/${tag}`]);

  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  const slug = m ? `${m[1]}/${m[2]}` : '<owner>/<repo>';

  console.log('已推送 tag。');
  console.log('');
  console.log('看构建进度：');
  console.log(`  ${remote.replace(/\.git$/, '')}/actions`);
  console.log('');
  console.log('构建完成后，手机上用的固定地址（存成书签）：');
  console.log(`  https://github.com/${slug}/releases/latest/download/dsh-remote-latest.apk`);
}

main();
