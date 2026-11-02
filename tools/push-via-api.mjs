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

function changedFiles() {
  // 本地比远端多出来的提交里改的文件
  const out = git(['diff', '--name-only', 'e3e7552..HEAD']);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

(async () => {
  const headSha = git(['rev-parse', 'HEAD']);
  const msg = git(['log', '-1', '--pretty=%s']);
  console.log('本地 HEAD =', headSha.slice(0, 7), '|', msg);

  const files = changedFiles();
  console.log('需要推送的文件：', files.length);
  if (!files.length) { console.log('没有差异，退出'); return; }

  const remote = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/master`);
  const baseCommitSha = remote.json.object.sha;
  console.log('远端 HEAD =', baseCommitSha.slice(0, 7));

  const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.json.tree.sha;

  const tree = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    const content = fs.readFileSync(abs);
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    if (blob.status !== 201) throw new Error(`blob ${f} -> ${blob.status} ${blob.text}`);
    tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.json.sha });
    console.log('  blob ok', f, content.length, 'B');
  }

  const newTree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTreeSha, tree });
  if (newTree.status !== 201) throw new Error(`tree -> ${newTree.status} ${newTree.text}`);

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
