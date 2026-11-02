// 兜底：github.com:443 的 git 传输不通、但 api.github.com 正常时，用 Git Data API 把本地 HEAD 推到远端
// 用法：node tools/push-via-api.mjs [base] [--no-tag]
//   base 默认 origin/master；用它比对出「本地多出来的提交改了哪些文件」
//   注意：本脚本只搬「改动文件」，所以 base 必须真的是远端当前 HEAD
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\dsh-mobile-app';
const OWNER = 'Lisa4916';
const REPO = 'dsh-mobile-app';
const API = 'https://api.github.com';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 取「git 里那一份」内容，不是工作区那一份。
// 工作区文件在 Windows 上是 CRLF（core.autocrlf=true），而 git 对象里是 LF；
// 直接读工作区会把 CRLF 推上去，远端树和本地树就会对不上。
function gitBlob(revPath) {
  return execFileSync('git', ['cat-file', 'blob', revPath], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) throw new Error('取不到 GitHub token');
  return line.slice('password='.length).trim();
}

const TOKEN = token();

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-remote-push',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

function changedFiles(base) {
  const out = git(['diff', '--name-only', `${base}..HEAD`]);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

// 全量同步时用：HEAD 里所有被跟踪的文件，带 git 的 mode
// **mode 必须照抄**：`gradlew` 是 100755，统一写 100644 会让远端树与本地树对不上，
// 而 CI 里 `./gradlew` 正好需要那个可执行位。
function trackedFiles() {
  const out = git(['ls-tree', '-r', 'HEAD']);
  return out
    ? out.split('\n').map((line) => {
        const m = /^(\d+)\s+\w+\s+[0-9a-f]+\t(.+)$/.exec(line.trim());
        return m ? { path: m[2], mode: m[1] } : null;
      }).filter(Boolean)
    : [];
}

function modeOf(file) {
  if (typeof file === 'object') return file.mode;
  const line = git(['ls-tree', 'HEAD', '--', file]);
  const m = /^(\d+)\s/.exec(line);
  return m ? m[1] : '100644';
}

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith('--')) || 'origin/master';
const NO_TAG = args.includes('--no-tag');
const ALL = args.includes('--all');   // 全量重推所有被跟踪文件（修 CRLF 污染过的远端树）

(async () => {
  const headSha = git(['rev-parse', 'HEAD']);
  const msg = git(['log', '-1', '--pretty=%s']);
  console.log('本地 HEAD =', headSha.slice(0, 7), '|', msg);

  const files = ALL ? trackedFiles() : changedFiles(BASE);
  console.log(ALL ? `全量模式：${files.length} 个文件` : `对比基准 ${BASE}：${files.length} 个文件`);
  if (!files.length) { console.log('没有差异，退出'); return; }

  const remote = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/master`);
  const baseCommitSha = remote.json.object.sha;
  console.log('远端 HEAD =', baseCommitSha.slice(0, 7));

  const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);
  // 全量模式不要 base_tree：否则远端独有的旧文件会残留
  const treeBody = ALL ? { tree: [] } : { base_tree: baseCommit.json.tree.sha, tree: [] };

  const tree = [];
  for (const f of files) {
    const rel = typeof f === 'object' ? f.path : f;
    const mode = modeOf(f);
    const content = gitBlob(`HEAD:${rel}`);         // ← 用 git 对象里的字节，避开 CRLF
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    if (blob.status !== 201) throw new Error(`blob ${rel} -> ${blob.status} ${blob.text}`);
    tree.push({ path: rel.replace(/\\/g, '/'), mode, type: 'blob', sha: blob.json.sha });
  }
  console.log(`  ${tree.length} 个 blob 已上传`);

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { ...treeBody, tree });
  if (newTree.status !== 201) throw new Error(`tree -> ${newTree.status} ${newTree.text}`);
  const localTree = git(['rev-parse', 'HEAD^{tree}']);
  console.log('新 tree =', newTree.json.sha, localTree === newTree.json.sha ? '（与本地树一致 ✅）' : `（本地树 ${localTree}，不一致 ⚠）`);

  const newCommit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: git(['log', '-1', '--pretty=%B']),
    tree: newTree.json.sha,
    parents: [baseCommitSha],
  });
  if (newCommit.status !== 201) throw new Error(`commit -> ${newCommit.status} ${newCommit.text}`);
  console.log('新远端提交 =', newCommit.json.sha.slice(0, 7));

  const upd = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/master`, {
    sha: newCommit.json.sha,
    force: false,
  });
  console.log('更新 master ->', upd.status, upd.json && upd.json.object ? upd.json.object.sha.slice(0, 7) : upd.text);

  // 打 tag（annotated）
  const ver = fs.readFileSync(path.join(ROOT, 'version.properties'), 'utf8');
  // 必须锚定行首：注释里也有一句 `-Pdsh.versionName=0.2.1`，不锚定会抓到它
  const name = /^versionName=([\d.]+)\s*$/m.exec(ver)[1];
  const tagName = 'v' + name;
  const tag = await api('POST', `/repos/${OWNER}/${REPO}/git/tags`, {
    tag: tagName,
    message: 'DSH 手机遥控 ' + name,
    object: newCommit.json.sha,
    type: 'commit',
  });
  if (tag.status !== 201) throw new Error(`tag -> ${tag.status} ${tag.text}`);
  const ref = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${tagName}`, sha: tag.json.sha });
  console.log('tag', tagName, '->', ref.status);
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });
