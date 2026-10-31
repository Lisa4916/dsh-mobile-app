// 把 D:\dsh-mobile-app\kb\*.md 灌入「手机软件开发知识库」，完全走插件自己的渲染与哈希函数
// 运行： node kb-ingest.mjs [--dry]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MOD = 'file:///C:/Users/yaoqi/.dsh/profiles/desktop/node_modules/@lemoncat7/dsh-knowledge/lib';
const { renderKnowledgeMarkdown, markdownHash, parseKnowledgeMarkdown } = await import(`${MOD}/documents/markdown.js`);
const { buildPassageStructure } = await import(`${MOD}/retrieval-passages.js`);
const { contentHash, normalizeTags } = await import(`${MOD}/domain.js`);

const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const DB = 'C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite';
const DOCROOT = 'C:/Users/yaoqi/.dsh/knowledge/documents';
const KBDIR = 'D:/dsh-mobile-app/kb';
const DRY = process.argv.includes('--dry');

const shortId = v => v.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8) || 'base';
const BASEDIR = join(DOCROOT, `base-${shortId(BASE_ID)}`);

const slugify = value => value.normalize('NFKC').trim()
  .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-').replace(/\s+/gu, '-')
  .replace(/^-+|-+$/gu, '').slice(0, 72) || 'knowledge';

const nowIso = () => new Date().toISOString();

// 每篇的元数据：type / tags / group / confidence
const META = {
  '01-build-env.md':      { type: 'procedure', tags: ['android', 'gradle', 'agp', 'jdk', '构建', '环境'], group: '构建', confidence: 0.85 },
  '02-webview-shell.md':  { type: 'procedure', tags: ['android', 'webview', 'kotlin', '外壳', 'jsbridge'], group: '外壳', confidence: 0.85 },
  '03-keyboard-insets.md':{ type: 'lesson',    tags: ['android', 'windowinsets', 'webview', '键盘', '动画', '实测'], group: '键盘', confidence: 0.9 },
  '04-adb-cdp-debug.md':  { type: 'procedure', tags: ['adb', 'cdp', '调试', 'android', '真机'], group: '调试', confidence: 0.85 },
  '05-testability.md':    { type: 'decision',  tags: ['android', 'junit', '测试', '可测性', 'kotlin'], group: '测试', confidence: 0.85 },
};

function readSource(file) {
  const raw = readFileSync(join(KBDIR, file), 'utf8').replace(/\r\n/gu, '\n');
  const m = raw.match(/^#\s+(.+)$/mu);
  if (!m) throw new Error(`${file}: 缺少一级标题`);
  const title = m[1].trim();
  const body = raw.slice(raw.indexOf('\n', m.index) + 1).trim();
  if (!body) throw new Error(`${file}: 正文为空`);
  return { title, body };
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode=WAL;');

const jobs = [];
for (const file of Object.keys(META)) {
  const { title, body } = readSource(file);
  const meta = META[file];
  const id = randomUUID();
  const draft = {
    knowledgeBaseId: BASE_ID, title, body,
    type: meta.type, tags: meta.tags, group: meta.group,
    scope: { kind: 'global' }, confidence: meta.confidence,
    source: { evidence: 'verified' },
  };
  const tags = normalizeTags(meta.tags);
  const entry = {
    id, knowledgeBaseId: BASE_ID, group: meta.group, title, body,
    type: meta.type, tags, scope: { kind: 'global' },
    confidence: meta.confidence, status: 'active', documentState: 'open',
    version: 1, source: { evidence: 'verified' },
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  const markdown = renderKnowledgeMarkdown({
    metadata: {
      id, type: entry.type, tags, group: entry.group, scope: entry.scope,
      confidence: entry.confidence, status: entry.status, documentState: entry.documentState,
    },
    title, body,
  });
  // 自校验：渲染出来的 markdown 必须能被插件自己解析回同样的 title/body
  const parsed = parseKnowledgeMarkdown(markdown);
  if (parsed.title !== title || parsed.body !== body) {
    throw new Error(`${file}: 渲染/解析往返不一致 title=${parsed.title === title} bodyLen ${parsed.body.length} vs ${body.length}`);
  }
  const relPath = `${slugify(title)}.md`;
  const docContent = `# ${title.replace(/[\r\n]+/gu, ' ').replace(/^#+\s*/u, '').trim()}\n\n${body.trim()}\n`;
  const structure = buildPassageStructure(body);
  jobs.push({
    file, entry, draft, markdown, parsed, relPath, docContent, structure,
    entryHash: contentHash(draft),
    docHash: markdownHash(markdown),
    bodyHash: createHash('sha256').update(body).digest('hex'),
  });
}

console.log(`准备写入 ${jobs.length} 篇 → base-${shortId(BASE_ID)}`);
for (const j of jobs) {
  const blk = j.structure.blocks.length, sec = j.structure.sections.length;
  console.log(`  ${j.file}  «${j.entry.title}»  body=${j.entry.body.length}字 blocks=${blk} sections=${sec} conf=${j.entry.confidence}`);
  const bad = j.structure.blocks.filter(b => b.end > j.entry.body.length || b.startLine < 1);
  if (bad.length) throw new Error(`${j.file}: structure 越界 ${bad.length} 块`);
}

if (DRY) { console.log('dry-run，未写库'); process.exit(0); }

if (!existsSync(BASEDIR)) mkdirSync(BASEDIR, { recursive: true });

const insEntry = db.prepare(`INSERT INTO knowledge_entries(
  id,knowledge_base_id,title,body,type,tags_json,scope_kind,scope_id,confidence,status,version,
  content_hash,source_json,created_at,updated_at,document_state,finalized_at,finalization_note,document_group)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insDoc = db.prepare(`INSERT INTO knowledge_documents(
  id,knowledge_base_id,rel_path,title,content,entry_count,content_hash,
  document_state,finalized_at,finalization_note,created_at,updated_at,document_group)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET rel_path=excluded.rel_path,title=excluded.title,content=excluded.content,
    content_hash=excluded.content_hash,document_group=excluded.document_group,updated_at=excluded.updated_at`);
const insFts = db.prepare('INSERT INTO knowledge_fts(knowledge_id,title,body,tags) VALUES(?,?,?,?)');
// knowledge_passage_insert 触发器在插入 entry 时已自动建了 pending 行，这里必须 upsert 覆盖
const insPass = db.prepare(`INSERT INTO knowledge_passage_index(
  entry_id,entry_version,index_version,body_hash,structure_json,state,attempts,retry_at,error_code,indexed_at)
  VALUES(?,?,?,?,?,'ready',0,0,NULL,?)
  ON CONFLICT(entry_id) DO UPDATE SET entry_version=excluded.entry_version,
    index_version=excluded.index_version,body_hash=excluded.body_hash,
    structure_json=excluded.structure_json,state='ready',attempts=0,retry_at=0,
    error_code=NULL,indexed_at=excluded.indexed_at`);
const insVer = db.prepare(`INSERT INTO knowledge_versions(id,knowledge_id,version,snapshot_json,change_kind,created_at)
  VALUES(?,?,?,?,'create',?)`);

db.exec('BEGIN IMMEDIATE');
try {
  for (const j of jobs) {
    const e = j.entry;
    const ts = nowIso();
    insEntry.run(e.id, e.knowledgeBaseId, e.title, e.body, e.type, JSON.stringify(e.tags),
      e.scope.kind, null, e.confidence, e.status, e.version, j.entryHash,
      JSON.stringify(e.source), ts, ts, e.documentState, null, null, e.group);
    insDoc.run(e.id, e.knowledgeBaseId, j.relPath, e.title, j.docContent, 1, j.docHash,
      e.documentState, null, null, ts, ts, e.group);
    insFts.run(e.id, e.title, e.body, e.tags.join(' '));
    insPass.run(e.id, e.version, 1, j.bodyHash, JSON.stringify(j.structure), Date.now());
    insVer.run(randomUUID(), e.id, e.version, JSON.stringify({
      knowledgeBaseId: e.knowledgeBaseId, title: e.title, body: e.body, type: e.type,
      tags: e.tags, group: e.group, scope: e.scope, confidence: e.confidence,
      source: e.source, status: e.status, documentState: e.documentState,
    }), ts);
    writeFileSync(join(BASEDIR, j.relPath), j.markdown, 'utf8');
  }
  db.exec('COMMIT');
  console.log('DB 事务已提交，5 个 md 已落盘');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const cnt = db.prepare('SELECT count(*) AS n FROM knowledge_entries WHERE knowledge_base_id=?').get(BASE_ID);
const dcnt = db.prepare('SELECT count(*) AS n FROM knowledge_documents WHERE knowledge_base_id=?').get(BASE_ID);
const fcnt = db.prepare('SELECT count(*) AS n FROM knowledge_fts WHERE knowledge_id IN (SELECT id FROM knowledge_entries WHERE knowledge_base_id=?)').get(BASE_ID);
console.log(`核对：entries=${cnt.n} documents=${dcnt.n} fts=${fcnt.n}`);
db.close();
