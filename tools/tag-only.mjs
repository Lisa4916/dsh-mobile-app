// 一次性：只打 tag（远端 master 已经推到 0.4.0 之后）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\dsh-mobile-app';
const OWNER = 'Lisa4916';
const REPO = 'dsh-mobile-app';
const API = 'https://api.github.com';

const token = (() => {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  return out.split('\n').find((l) => l.startsWith('password=')).slice('password='.length).trim();
})();

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-remote-tag',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const ver = fs.readFileSync(path.join(ROOT, 'version.properties'), 'utf8');
// 必须锚定行首：注释里也写了 -Pdsh.versionName=0.2.1
const name = /^versionName=([\d.]+)\s*$/m.exec(ver)[1];
const tagName = 'v' + name;

const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/master`);
const sha = ref.json.object.sha;
console.log('远端 master =', sha.slice(0, 7), '目标 tag =', tagName);

const tag = await api('POST', `/repos/${OWNER}/${REPO}/git/tags`, {
  tag: tagName, message: 'DSH 手机遥控 ' + name, object: sha, type: 'commit',
});
if (tag.status !== 201) throw new Error(`tag -> ${tag.status} ${tag.text}`);
const mk = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/tags/${tagName}`, sha: tag.json.sha });
console.log('创建 tag =', mk.status, mk.json && mk.json.ref ? mk.json.ref : mk.text);
