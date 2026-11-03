// 三重验收：①备份仓远端可解出三文件且 SHA-256 全 MATCH ②知识库 DB 26 篇 ↔ kb/ 源 md 一一对应 ③文档无「33 条踩坑」与 25/26 篇矛盾
// 用法：node tools/verify-delivery.mjs
// 只读：不改任何东西。退出码 0 = 全绿，1 = 有红项。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = 'D:\\dsh-mobile-app';
const OPENSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const OWNER = 'Lisa4916';
const SECRET_REPO = 'dsh-mobile-app-secrets';
const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const DB_PATH = 'C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite';
const PASSPHRASE_FILE = 'D:\\dsh-mobile-app\\build-artifacts\\secrets-backup-out\\BACKUP-PASSPHRASE.txt';

const EXPECT = {
  'dsh-remote.jks': 'e7680aa0d5ab0c20ef044814f606c8d8c3c5b62c31bb665f40cd3d2751c71ea2',
  'keystore.b64': '0809b52e256c7e430fed9723ea940074517e912af40ba7fb88a3dfd2bf6f5f17',
  'KEYSTORE_PASSWORD.txt': '7ad6196977d17970527aff85a1ad6d817c1a8dd8d0e91bcb899fe2821d337609',
};

const results = [];
const ok = (id, msg) => { results.push({ id, pass: true, msg }); console.log(`  [PASS] ${id} ${msg}`); };
const bad = (id, msg) => { results.push({ id, pass: false, msg }); console.log(`  [FAIL] ${id} ${msg}`); };
const warn = (id, msg) => { results.push({ id, pass: true, warn: true, msg }); console.log(`  [WARN] ${id} ${msg}`); };

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function token() {
  // 注意：本进程可能带着 GIT_TERMINAL_PROMPT=0 / GCM_INTERACTIVE=never（给 clone 用的），
  // 那会让 `git credential fill` 读不到凭据库里的 PAT。取 token 时必须把这些摘掉。
  const env = { ...process.env };
  for (const k of ['GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'GIT_ASKPASS', 'SSH_ASKPASS']) delete env[k];
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env,
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) throw new Error('取不到 GitHub token');
  return line.slice('password='.length).trim();
}
async function api(p) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://api.github.com' + p, {
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-verify-delivery',
        },
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非JSON */ }
      return { status: res.status, json, text };
    } catch (e) {
      lastErr = e;
      // 网络层抖动（UND_ERR_SOCKET / ECONNRESET）：退避后重试
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── 一、备份仓：远端树 + clone + 解密 + SHA ──
console.log('\n== ① 签名材料备份：远端可恢复 ==');
let remoteTree = null;
try {
  const t = await api(`/repos/${OWNER}/${SECRET_REPO}/git/trees/main?recursive=1`);
  if (t.status === 200) {
    remoteTree = t.json.tree.filter((x) => x.type === 'blob');
    ok('A1', `远端 main 树可读，${remoteTree.length} 个 blob`);
  } else {
    bad('A1', `远端 main 树不可读 status=${t.status} ${t.text.slice(0, 120)}`);
  }
} catch (e) {
  bad('A1', 'API 请求失败：' + e.message);
}

if (remoteTree) {
  const paths = remoteTree.map((x) => x.path).sort();
  const want = ['README.md', 'enc/KEYSTORE_PASSWORD.txt.enc', 'enc/dsh-remote.jks.enc', 'enc/keystore.b64.enc'];
  const missing = want.filter((w) => !paths.includes(w));
  if (missing.length === 0) ok('A2', '远端四文件齐全：' + want.join(', '));
  else bad('A2', '远端缺文件：' + missing.join(', '));

  // 明文口令绝不入库
  if (fs.existsSync(PASSPHRASE_FILE)) {
    const pass = fs.readFileSync(PASSPHRASE_FILE, 'utf8').trim();
    const leaked = [];
    for (const f of remoteTree.filter((x) => x.path !== '.git')) {
      const blob = await api(`/repos/${OWNER}/${SECRET_REPO}/git/blobs/${f.sha}`);
      if (blob.status === 200 && blob.json && blob.json.content) {
        const raw = Buffer.from(blob.json.content, 'base64').toString('utf8');
        if (raw.includes(pass)) leaked.push(f.path);
      }
    }
    if (leaked.length === 0) ok('A3', '远端无一处包含口令字面量');
    else bad('A3', '口令出现在：' + leaked.join(', '));
  } else {
    bad('A3', '本机口令文件缺失，无法做泄漏比对：' + PASSPHRASE_FILE);
  }
}

// clone → 解密 → SHA 比对
if (remoteTree && fs.existsSync(PASSPHRASE_FILE)) {
  const tmp = path.join(os.tmpdir(), 'dsh-secrets-verify-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const pass = fs.readFileSync(PASSPHRASE_FILE, 'utf8').trim();
  let cloned = false;
  for (const url of [
    `https://x-access-token:${token()}@github.com/${OWNER}/${SECRET_REPO}.git`,
    `https://github.com/${OWNER}/${SECRET_REPO}.git`,
  ]) {
    try {
      execFileSync('git', ['-c', 'credential.helper=', 'clone', '--depth', '1', '--quiet', url, tmp], {
        stdio: 'pipe', timeout: 45000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
        },
      });
      cloned = true; break;
    } catch (e) {
      console.log('    clone 尝试失败：' + String(e.message).split('\n')[0]);
    }
  }
  if (!cloned) {
    warn('A4-clone', 'git clone 当前不可用（github.com:443 传输层被重置 / 代理未开）→ 本条降级为 WARN，改用 GitHub API blob 取同一份密文验证');
  }
  const encDir = cloned ? path.join(tmp, 'enc') : null;
  const fetchEnc = async (name) => {
    if (encDir) return fs.readFileSync(path.join(encDir, name));
    const f = remoteTree.find((x) => x.path === `enc/${name}`);
    if (!f) throw new Error('远端无 ' + name);
    const b = await api(`/repos/${OWNER}/${SECRET_REPO}/git/blobs/${f.sha}`);
    return Buffer.from(b.json.content, 'base64');
  };
  const outDir = path.join(tmp, '_dec');
  fs.mkdirSync(outDir, { recursive: true });
  let allMatch = true;
  for (const [plain, wantHash] of Object.entries(EXPECT)) {
    const encName = plain + '.enc';
    try {
      const encBytes = await fetchEnc(encName);
      const encPath = path.join(tmp, encName);
      fs.writeFileSync(encPath, encBytes);
      const outPath = path.join(outDir, plain);
      execFileSync(OPENSSL, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
        '-in', encPath, '-out', outPath, '-pass', `pass:${pass}`], { stdio: 'pipe' });
      const got = sha256(outPath);
      if (got === wantHash) console.log(`    ${plain}  ${fs.statSync(outPath).size}B  SHA MATCH`);
      else { allMatch = false; console.log(`    ${plain}  SHA MISMATCH got=${got}`); }
    } catch (e) {
      allMatch = false;
      console.log(`    ${plain}  解密失败：${String(e.message).split('\n')[0]}`);
    }
  }
  if (allMatch) ok('A4', `三个文件解密后 SHA-256 全部 MATCH（来源：${cloned ? 'git clone' : 'GitHub API blob'}）`);
  else bad('A4', '有文件解密失败或 SHA 不匹配');
  if (cloned) console.log('    （clone 路径可用，恢复流程第一段成立）');
}

// ── 二、知识库 DB ↔ kb/ 一一对应 ──
console.log('\n== ② 知识库：DB 26 篇 ↔ kb/ 源 md ==');
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const docs = db.prepare('SELECT rel_path,title FROM knowledge_documents WHERE knowledge_base_id=? ORDER BY rel_path').all(BASE_ID);
const entries = db.prepare('SELECT count(*) AS n FROM knowledge_entries WHERE knowledge_base_id=?').get(BASE_ID).n;
const passages = db.prepare(`SELECT p.state FROM knowledge_passage_index p
  JOIN knowledge_entries e ON e.id=p.entry_id WHERE e.knowledge_base_id=?`).all(BASE_ID);
db.close();
console.log(`  DB: entries=${entries} documents=${docs.length} passage=${passages.length} ready=${passages.filter((p) => p.state === 'ready').length}`);
if (entries === 26 && docs.length === 26 && passages.length === 26 && passages.every((p) => p.state === 'ready')) {
  ok('B1', 'DB 五表 26/26/26 且全部 ready');
} else {
  bad('B1', `DB 计数异常 entries=${entries} docs=${docs.length} passage=${passages.length}`);
}

// kb/ 里所有 md（含 updates/ 与 archive/ 之外）
function walk(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'archive') continue; // 归档不算「现行源」
      out.push(...walk(path.join(dir, e.name), rel));
    } else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}
const kbFiles = walk(path.join(ROOT, 'kb')).sort();
console.log(`  kb/ 现行 md ${kbFiles.length} 个`);

// 每篇 DB 文档必须能通过 title 找到 kb/ 里的源
const norm = (s) => s.replace(/[\s\u3000]/g, '').replace(/[：:，,、「」（）()／/·\-—–_"'“”‘’?!？!。.]/g, '').toLowerCase();
const kbBodies = kbFiles.map((rel) => {
  const raw = fs.readFileSync(path.join(ROOT, 'kb', rel), 'utf8');
  // 两种写法都要认：YAML frontmatter 的 title:，或正文首个 H1
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fmTitle = fm ? (/^title:\s*(.+)$/m.exec(fm[1]) || [])[1] : null;
  const h1 = (/^#\s+(.+)$/m.exec(raw) || [])[1] || '';
  const title = (fmTitle || h1).trim().replace(/^["']|["']$/g, '');
  return { rel, title, normH1: norm(title) };
});
// 精确匹配（norm 相等），不允许 includes —— 那会把「返回导航」误配到「启动时侧栏」
const dbOnly = [];
const kbUnused = [...kbBodies];
for (const d of docs) {
  const nd = norm(d.title);
  const i = kbUnused.findIndex((k) => k.normH1 === nd);
  if (i >= 0) kbUnused.splice(i, 1);
  else dbOnly.push(d.title);
}
if (dbOnly.length === 0) ok('B2', `DB 26 篇精确对应 kb/ 同题源 md（0 个 DB-only）`);
else { bad('B2', `DB-only ${dbOnly.length} 篇：\n      ` + dbOnly.join('\n      ')); }
if (kbUnused.length === 0) ok('B2b', `kb/ 无孤立源（每个源 md 都能对上 DB 标题）`);
else bad('B2b', `kb/ 有 ${kbUnused.length} 个源对不上 DB：` + kbUnused.map((k) => k.rel).join(', '));

// 目标结构：kb/ 顶层恰好 26 个 NN-*.md，编号 1–26 连续无重复；kb/updates/ 不再存在（已扁平化）
const kbTop = fs.readdirSync(path.join(ROOT, 'kb')).filter((f) => f.endsWith('.md'));
const nums = kbTop.map((f) => (/^(\d+)-/.exec(f) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
const gaps = [];
for (let i = 1; i <= 26; i++) if (!nums.includes(i)) gaps.push(i);
if (nums.length === 26 && dup.length === 0 && gaps.length === 0) {
  ok('B3', 'kb/ 顶层 26 个源，编号 01–26 连续无重复');
} else {
  bad('B3', `kb/ 顶层 ${kbTop.length} 个 md，编号 ${nums.length} 个：重复=[${dup}] 缺号=[${gaps.slice(0, 12)}${gaps.length > 12 ? '…' : ''}]`);
}
if (!fs.existsSync(path.join(ROOT, 'kb', 'updates'))) ok('B3b', 'kb/updates/ 已扁平化（不存在）');
else bad('B3b', `kb/updates/ 仍存在 ${fs.readdirSync(path.join(ROOT, 'kb', 'updates')).length} 个文件`);

// ── 三、文档口径无矛盾 ──
console.log('\n== ③ 文档口径 ==');
const docsToScan = ['AGENTS.md', 'PROJECT-CHARTER.md', 'README.md'];
for (const rel of docsToScan) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { bad('C-' + rel, '文件不存在'); continue; }
  const txt = fs.readFileSync(p, 'utf8');
  const hits = [];
  // 「33 条踩坑」这类把总数当口径的写法
  for (const re of [/33\s*条踩坑/g, /踩坑(?:清单)?\s*33\s*条/g, /\b33\s*条坑\b/g]) {
    let m;
    const rx = new RegExp(re.source, 'g');
    while ((m = rx.exec(txt))) hits.push({ kind: '把总数当口径', text: m[0], idx: m.index });
  }
  // 篇数矛盾：出现「25 篇」即与 DB 的 26 篇冲突
  for (const re of [/(\d{2})\s*篇(?:知识|文档)?/g]) {
    let m;
    while ((m = re.exec(txt))) {
      const n = Number(m[1]);
      if (n === 25) hits.push({ kind: '篇数与 DB(26) 冲突', text: m[0], idx: m.index });
    }
  }
  if (hits.length === 0) ok('C-' + rel, '无「33 条踩坑」、无 25 篇口径');
  else {
    bad('C-' + rel, hits.map((h) => `${h.kind}「${h.text}」@char${h.idx}`).join('; '));
  }
}
// 踩坑小节号口径是否已写入
const agentsTxt = fs.existsSync(path.join(ROOT, 'AGENTS.md')) ? fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8') : '';
if (/以小节号为准/.test(agentsTxt)) ok('C4', 'AGENTS.md 已声明「以小节号为准」');
else bad('C4', 'AGENTS.md 未声明「以小节号为准」');

// README 发版章是否有备份/恢复小节
const readmeTxt = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
if (/dsh-mobile-app-secrets/.test(readmeTxt) && /openssl enc -d/.test(readmeTxt)) ok('C5', 'README 已含备份仓地址与解密命令');
else bad('C5', 'README 缺备份仓地址或解密命令');

// ── 汇总 ──
const fail = results.filter((r) => !r.pass);
console.log(`\n== 汇总：${results.length - fail.length}/${results.length} 通过 ==`);
if (fail.length) {
  console.log('红项：');
  for (const f of fail) console.log(`  - ${f.id} ${f.msg}`);
  process.exit(1);
} else {
  console.log('三重验收全绿 ✅');
}
