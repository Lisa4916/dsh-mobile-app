// 更新「手机软件开发知识库」里的文档，走插件自己的 LocalKnowledgeProvider
//
// 为什么不直接 UPDATE 数据库：provider.updateEntry() 只写 knowledge_entries / knowledge_fts /
// knowledge_versions，**不重写磁盘 .md、不重建 passage 索引**；直接改库会让 DB 与磁盘不一致，
// 下次插件启动 syncAllDocuments() 时按 DB 重写磁盘，或者检索命中旧 passage。
// LocalKnowledgeProvider.update() 才是官方路径：它会事务内改 entries，再 syncKnowledgeEntryQueued()
// 重写 projection markdown（knowledge_documents + 磁盘），并让 passage 索引按 body_hash 重建。
//
// ── 源在哪（v0.6.0 起）──────────────────────────────────────────────
// 源就是 kb/*.md 自己，不再有 kb/updates/ 暂存区。原因：暂存区与正式目录有两份同名文档，
// 谁新谁旧全靠人记（历史上真的分叉过：04-adb-cdp 在两处各一版，内容差 60 行）。
//
// 用法：
//   node tools/kb-update.mjs --dry          列出每篇会发生什么，不写库
//   node tools/kb-update.mjs                把 kb/*.md 的正文同步进库
//   node tools/kb-update.mjs --only 14-     只处理文件名匹配的文件
//
// 匹配方式与写入策略：
//   1. 文件有 front-matter → 用它（id 前缀可指定目标；不给 id 就按 title 找）
//   2. 文件无 front-matter → 用一级标题在库里精确找同名条目：
//        找到   → 只同步正文（元数据沿用库里现成的，避免把 type/tags 改坏）
//        没找到 → 报错，提示你补 front-matter（新建必须写明元数据，不能猜）
//   3. 正文与库里一字不差 → 跳过（不会把版本号白涨一次）
//
// front-matter（可选，新建时必需）：
//   ---
//   id: d7618755            # 前缀匹配，取唯一命中
//   title: ...
//   type: lesson            # preference | fact | decision | procedure | lesson
//   tags: a,b,c
//   confidence: 0.9
//   group: 外壳
//   ---
//   <正文，不含一级标题>
//
// 运行： node tools/kb-update.mjs [--dry] [--only <regex>]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MOD = 'file:///C:/Users/yaoqi/.dsh/profiles/desktop/node_modules/@lemoncat7/dsh-knowledge/lib';
const { LocalKnowledgeProvider } = await import(`${MOD}/local-provider.js`);
const { parseKnowledgeMarkdown, renderKnowledgeMarkdown } = await import(`${MOD}/documents/markdown.js`);

const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const DB = 'C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite';
const KBDIR = 'D:/dsh-mobile-app/kb';
const DRY = process.argv.includes('--dry');
const TYPES = new Set(['preference', 'fact', 'decision', 'procedure', 'lesson']);

function readMd(file) {
  const raw = readFileSync(join(KBDIR, file), 'utf8').replace(/\r\n/gu, '\n');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  let meta = {};
  let rest = raw;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf(':');
      if (i < 0) throw new Error(`${file}: front-matter 行无法解析: ${line}`);
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    rest = fm[2];
  }
  const h1 = rest.match(/^#\s+(.+)$/mu);
  const title = (meta.title || (h1 ? h1[1] : '')).trim();
  if (!title) throw new Error(`${file}: 既没有 front-matter 的 title，也没有一级标题`);
  // 正文 = 去掉 front-matter 与一级标题后的内容
  const body = h1
    ? rest.slice(rest.indexOf('\n', h1.index) + 1).trim()
    : rest.trim();
  if (!body) throw new Error(`${file}: 正文为空`);
  return { file, hasFm: Boolean(fm), meta, title, body };
}

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > 0 ? new RegExp(process.argv[onlyIdx + 1], 'u') : null;

const all = readdirSync(KBDIR).filter(f => f.endsWith('.md')).sort();
const files = ONLY ? all.filter(f => ONLY.test(f)) : all;
if (!files.length) { console.log(`kb/ 下没有匹配的 .md（--only ${ONLY}）`); process.exit(0); }

const ro = new DatabaseSync(DB, { readOnly: true });
const byId = (prefix) => {
  const hits = ro.prepare('SELECT id,title,version,type,tags_json,confidence,document_group,body FROM knowledge_entries WHERE knowledge_base_id=? AND id LIKE ?')
    .all(BASE_ID, `${prefix}%`);
  if (hits.length !== 1) throw new Error(`id 前缀 "${prefix}" 命中 ${hits.length} 条，必须唯一`);
  return hits[0];
};
const byTitle = (t) =>
  ro.prepare('SELECT id,title,version,type,tags_json,confidence,document_group,body FROM knowledge_entries WHERE knowledge_base_id=? AND trim(title)=?')
    .get(BASE_ID, t.trim()) || null;

const jobs = [];
for (const file of files) {
  const src = readMd(file);
  let cur = null;
  if (src.meta.id) cur = byId(src.meta.id);
  else cur = byTitle(src.title);

  if (!cur) {
    // 新建：元数据必须齐全，不猜
    if (!src.hasFm) throw new Error(`${file}: 库里没有同名条目，新建必须写 front-matter（type/tags/confidence/group）`);
    if (!TYPES.has(src.meta.type)) throw new Error(`${file}: type 非法 "${src.meta.type}"`);
    const confidence = Number(src.meta.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${file}: confidence 非法`);
    jobs.push({
      file, action: 'create', current: null,
      draft: {
        knowledgeBaseId: BASE_ID, title: src.title, body: src.body, type: src.meta.type,
        tags: (src.meta.tags || '').split(',').map(s => s.trim()).filter(Boolean),
        scope: { kind: 'global' }, confidence, group: src.meta.group || '',
        source: { evidence: 'verified' },
      },
    });
    continue;
  }

  // 已有：正文没变就跳过，别把版本号白涨一次
  if (cur.body.trim() === src.body.trim()) {
    jobs.push({ file, action: 'skip', current: cur, reason: '正文无变化' });
    continue;
  }
  jobs.push({
    file, action: 'update', current: cur,
    draft: {
      knowledgeBaseId: BASE_ID,
      title: src.meta.title || cur.title,
      body: src.body,
      // 元数据沿用库里的，除非 front-matter 明确覆盖
      type: src.meta.type || cur.type,
      tags: src.meta.tags ? src.meta.tags.split(',').map(s => s.trim()).filter(Boolean) : JSON.parse(cur.tags_json),
      scope: { kind: 'global' },
      confidence: src.meta.confidence ? Number(src.meta.confidence) : cur.confidence,
      group: src.meta.group || cur.document_group || '',
      source: { evidence: 'verified' },
    },
  });
}

// 离线核对：render→parse 往返必须一字不差（插件自己的解析器说了算）
for (const j of jobs) {
  if (j.action === 'skip') continue;
  const rendered = renderKnowledgeMarkdown({
    metadata: {
      id: j.current ? j.current.id : '00000000-0000-0000-0000-000000000000',
      type: j.draft.type, tags: j.draft.tags, scope: j.draft.scope,
      confidence: j.draft.confidence, status: 'active', documentState: 'open',
      ...(j.draft.group ? { group: j.draft.group } : {}),
    },
    title: j.draft.title, body: j.draft.body,
  });
  const back = parseKnowledgeMarkdown(rendered);
  if (back.title.trim() !== j.draft.title.trim()) throw new Error(`${j.file}: 标题往返不一致`);
  if (back.body.trim() !== j.draft.body.trim()) throw new Error(`${j.file}: 正文往返不一致`);
}
ro.close();

for (const j of jobs) {
  if (j.action === 'skip') { console.log(`跳过    ${j.file}  «${j.current.title}»  ${j.reason}`); continue; }
  const verb = j.action === 'create' ? '新建' : '更新';
  const cur = j.current ? `现状 v${j.current.version} «${j.current.title}»` : '';
  console.log(`${verb}  ${j.file}  «${j.draft.title}»  ${j.draft.body.length}字 group=${j.draft.group} ${cur}`);
}
const todo = jobs.filter(j => j.action !== 'skip');
if (!todo.length) { console.log('\n没有需要写入的篇目'); process.exit(0); }
if (DRY) { console.log('\ndry-run，未写库'); process.exit(0); }

const provider = new LocalKnowledgeProvider(DB);
const report = [];
try {
  for (const j of todo) {
    const entry = j.action === 'update'
      ? await provider.update(j.current.id, j.draft, undefined, j.current.version)
      : await provider.create(j.draft);
    report.push({ file: j.file, id: entry.id, version: entry.version, title: entry.title });
    console.log(`  ✓ ${entry.id.slice(0, 8)} v${entry.version} «${entry.title}»`);
  }
} finally {
  await provider.close();
}

console.log('\n== 落盘核对 ==');
const chk = new DatabaseSync(DB, { readOnly: true });
for (const r of report) {
  const e = chk.prepare('SELECT length(body) AS n, document_group, status FROM knowledge_entries WHERE id=?').get(r.id);
  const d = chk.prepare('SELECT rel_path, length(content) AS c FROM knowledge_documents WHERE id=?').get(r.id);
  const v = chk.prepare('SELECT count(*) AS n FROM knowledge_versions WHERE knowledge_id=?').get(r.id).n;
  const p = chk.prepare('SELECT state, index_version FROM knowledge_passage_index WHERE entry_id=?').get(r.id);
  console.log(`  ${r.id.slice(0, 8)} v${r.version} body=${e.n}组=${e.document_group} doc=${d ? d.rel_path : '缺失'}(${d ? d.c : 0}B) versions=${v} passage=${p ? p.state + '/v' + p.index_version : '缺失'}`);
  if (!d) throw new Error(`${r.id}: knowledge_documents 缺投影行`);
}
chk.close();
console.log(`完成：写入 ${report.length} 篇`);
