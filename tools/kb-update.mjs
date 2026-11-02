// 更新/新增「手机软件开发知识库」里的文档，走插件自己的 LocalKnowledgeProvider
//
// 为什么不直接 UPDATE 数据库：provider.updateEntry() 只写 knowledge_entries / knowledge_fts /
// knowledge_versions，**不重写磁盘 .md、不重建 passage 索引**；直接改库会让 DB 与磁盘不一致，
// 下次插件启动 syncAllDocuments() 时按 DB 重写磁盘，或者检索命中旧 passage。
// LocalKnowledgeProvider.update() 才是官方路径：它会事务内改 entries，再 syncKnowledgeEntryQueued()
// 重写 projection markdown（knowledge_documents + 磁盘），并让 passage 索引按 body_hash 重建。
//
// 源文件格式：kb/updates/*.md，front-matter 给出目标与元数据
//   ---
//   id: d7618755            # 省略 = 新建；给出 = 更新该 id（前缀匹配，取唯一命中）
//   title: ...
//   type: lesson            # preference | fact | decision | procedure | lesson
//   tags: a,b,c
//   confidence: 0.9
//   group: 外壳
//   ---
//   <正文，不含一级标题>
//
// 运行： node tools/kb-update.mjs [--dry]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MOD = 'file:///C:/Users/yaoqi/.dsh/profiles/desktop/node_modules/@lemoncat7/dsh-knowledge/lib';
const { LocalKnowledgeProvider } = await import(`${MOD}/local-provider.js`);
const { parseKnowledgeMarkdown, renderKnowledgeMarkdown } = await import(`${MOD}/documents/markdown.js`);

const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const DB = 'C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite';
const UPDIR = 'D:/dsh-mobile-app/kb/updates';
const DRY = process.argv.includes('--dry');
const TYPES = new Set(['preference', 'fact', 'decision', 'procedure', 'lesson']);

function parseFile(file) {
  const raw = readFileSync(join(UPDIR, file), 'utf8').replace(/\r\n/gu, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  if (!m) throw new Error(`${file}: 缺少 front-matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`${file}: front-matter 行无法解析: ${line}`);
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim();
  if (!meta.title) throw new Error(`${file}: 缺少 title`);
  if (!TYPES.has(meta.type)) throw new Error(`${file}: type 非法 "${meta.type}"`);
  const confidence = Number(meta.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`${file}: confidence 非法`);
  if (!body) throw new Error(`${file}: 正文为空`);
  return {
    file,
    targetId: meta.id || null,
    draft: {
      knowledgeBaseId: BASE_ID,
      title: meta.title,
      body,
      type: meta.type,
      tags: (meta.tags || '').split(',').map(s => s.trim()).filter(Boolean),
      scope: { kind: 'global' },
      confidence,
      group: meta.group || '',
      source: { evidence: 'verified' },
    },
  };
}

// --only <regex>：只处理文件名匹配的源文件。已有 8 篇入库过，全量重跑会把它们再各升一版，
// 所以追加新文档时必须限定范围。
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > 0 ? new RegExp(process.argv[onlyIdx + 1], 'u') : null;

const all = existsSync(UPDIR) ? readdirSync(UPDIR).filter(f => f.endsWith('.md') && existsSync(join(UPDIR, f))).sort() : [];
const files = ONLY ? all.filter(f => ONLY.test(f)) : all;
if (!files.length) { console.log('kb/updates 下没有匹配的 .md，无事可做'); process.exit(0); }
const jobs = files.map(parseFile);

// 先离线核对：目标 id 必须唯一，正文必须能被插件自己的 markdown 解析器接受
const ro = new DatabaseSync(DB, { readOnly: true });
for (const j of jobs) {
  if (j.targetId) {
    const hits = ro.prepare('SELECT id,title,version FROM knowledge_entries WHERE knowledge_base_id=? AND id LIKE ?')
      .all(BASE_ID, `${j.targetId}%`);
    if (hits.length !== 1) throw new Error(`${j.file}: id 前缀 "${j.targetId}" 命中 ${hits.length} 条，必须唯一`);
    j.current = hits[0];
  }
  // 判据：能被插件自己的 render→parse 往返，且正文一字不差。
  // 注意 parse 要求「完整文档」（front-matter + 一级标题），不能只喂 "#title\n\nbody"。
  const rendered = renderKnowledgeMarkdown({
    metadata: {
      id: j.current ? j.current.id : '00000000-0000-0000-0000-000000000000',
      type: j.draft.type,
      tags: j.draft.tags,
      scope: j.draft.scope,
      confidence: j.draft.confidence,
      status: 'active',
      documentState: 'open',
      ...(j.draft.group ? { group: j.draft.group } : {}),
    },
    title: j.draft.title,
    body: j.draft.body,
  });
  const back = parseKnowledgeMarkdown(rendered);
  if (back.title.trim() !== j.draft.title.trim()) throw new Error(`${j.file}: 标题往返不一致`);
  if (back.body.trim() !== j.draft.body.trim()) throw new Error(`${j.file}: 正文往返不一致`);
}
ro.close();

for (const j of jobs) {
  const verb = j.targetId ? '更新' : '新建';
  const cur = j.current ? `现状 v${j.current.version} «${j.current.title}»` : '';
  console.log(`${verb}  ${j.file}  «${j.draft.title}»  ${j.draft.body.length}字 group=${j.draft.group} ${cur}`);
}
if (DRY) { console.log('dry-run，未写库'); process.exit(0); }

const provider = new LocalKnowledgeProvider(DB);
const report = [];
try {
  for (const j of jobs) {
    const entry = j.targetId
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
console.log(`完成：${report.length} 篇`);
