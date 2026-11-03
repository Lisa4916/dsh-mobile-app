// 把 D:\dsh-mobile-app\kb\*.md 灌入「手机软件开发知识库」，完全走插件自己的渲染与哈希函数
// 运行： node kb-ingest.mjs [--dry]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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
// 这张表必须与 kb/ 顶层 26 个文件一一对应（键就是文件名）。改过名或加过篇就要跟着改，
// 否则下面 for (const file of Object.keys(META)) 会直接 ENOENT。
// 事实来源是 DB 里的 knowledge_entries：这里是从库里导出来的快照。
// 导出命令见 AGENTS §8；要重新导出就先跑 build-artifacts/gen-meta.mjs 那类小脚本。
const META = {
  '01-android-version-cadence.md':                 { type: 'fact', tags: ['android', 'api level', 'google play', 'targetsdk', '版本兼容'], group: '构建', confidence: 0.95 },
  '02-r8-and-release.md':                          { type: 'procedure', tags: ['minify', 'proguard', 'r8', 'release', '发布', '签名'], group: '构建', confidence: 0.93 },
  '03-build-env.md':                               { type: 'procedure', tags: ['adb', 'agp', 'android', 'gradle', 'jdk', 'kotlin', 'webview', 'windowinsets', 'windows', '临时目录', '工具链', '构建', '构建环境', '环境', '调试'], group: '构建', confidence: 0.85 },
  '04-android16-edge-to-edge-predictive-back.md':  { type: 'procedure', tags: ['android 16', 'edge-to-edge', 'predictive back', 'targetsdk 36', 'webview', 'windowinsets'], group: '外壳', confidence: 0.95 },
  '05-webview-shell.md':                           { type: 'procedure', tags: ['adb', 'android', 'cookie', 'document-start', 'dsh-pocket', 'gradle', 'javascript', 'jsbridge', 'kotlin', 'onbackpresseddispatcher', 'spa', 'webview', 'windowinsets', '启动锁', '外壳', '微注入', '登录态', '调试', '返回导航'], group: '外壳', confidence: 0.85 },
  '06-webview-security-baseline.md':               { type: 'procedure', tags: ['javascriptinterface', 'shouldoverrideurlloading', 'webview', '安全', '安全基线'], group: '外壳', confidence: 0.95 },
  '07-handshake-gate.md':                          { type: 'lesson', tags: ['android', 'cookie', 'webview', 'webview外壳', '实测', '自愈', '退避', '重建'], group: '外壳', confidence: 0.95 },
  '08-login-state.md':                             { type: 'lesson', tags: ['android', 'cookie', 'webview', 'webview外壳', '实测', '端口', '自愈'], group: '外壳', confidence: 0.92 },
  '09-startup-sidebar-flash.md':                   { type: 'lesson', tags: ['cdp', 'css', 'transition', 'webview', '启动', '实测', '闪烁'], group: '外壳', confidence: 0.93 },
  '10-render-process-gone.md':                     { type: 'procedure', tags: ['onrenderprocessgone', 'webview', '内存', '稳定性', '闪退'], group: '外壳', confidence: 0.95 },
  '11-home-return.md':                             { type: 'lesson', tags: ['android', 'dom', 'webview', 'webview外壳', '侧栏', '实测', '踩坑', '返回导航'], group: '外壳', confidence: 0.95 },
  '12-back-layering.md':                           { type: 'procedure', tags: ['dom判据', 'spa', 'webview', '一次只退一层', '层级', '返回键'], group: '外壳', confidence: 0.95 },
  '13-keyboard-permission.md':                     { type: 'lesson', tags: ['adb', 'android', 'elementfrompoint', 'gradle', 'kotlin', 'pointer', 'touch', 'webview', 'windowinsets', '调试', '输入法', '键盘'], group: '键盘', confidence: 0.92 },
  '14-keyboard-insets.md':                         { type: 'lesson', tags: ['adb', 'android', 'document-start', 'focus', 'gradle', 'ime', 'kotlin', 'webview', 'windowinsets', '动画', '实测', '调试', '键盘'], group: '键盘', confidence: 0.9 },
  '15-adb-cdp.md':                                 { type: 'procedure', tags: ['adb', 'android', 'cdp', 'monkey', 'webview', '真机', '调试'], group: '调试', confidence: 0.92 },
  '16-wireless-adb.md':                            { type: 'procedure', tags: ['adb', 'android', 'android11', 'gradle', 'kotlin', 'webview', 'windowinsets', '无线调试', '真机安装', '调试', '防火墙'], group: '调试', confidence: 0.82 },
  '17-click-injection.md':                         { type: 'lesson', tags: ['adb', 'android', 'miui', 'monkey', 'webview', '实测', '点击', '自动化', '踩坑'], group: '调试', confidence: 0.95 },
  '18-regression.md':                              { type: 'procedure', tags: ['android', 'webview外壳', '判据', '回归', '基线', '测试'], group: '测试', confidence: 0.9 },
  '19-testability.md':                             { type: 'decision', tags: ['adb', 'android', 'gradle', 'junit', 'junit4', 'kotlin', 'webview', 'windowinsets', '单元测试', '单测', '可测性', '断言', '测试', '测试基线', '调试'], group: '测试', confidence: 0.86 },
  '20-performance-verification.md':                { type: 'procedure', tags: ['baseline profile', 'jank', 'macrobenchmark', '启动优化', '性能'], group: '测试', confidence: 0.88 },
  '21-test-layering.md':                           { type: 'decision', tags: ['ci', 'gradle managed devices', 'instrumented', 'robolectric', '测试'], group: '测试', confidence: 0.92 },
  '22-page-probe.md':                              { type: 'decision', tags: ['android', 'junit', 'webview', '判据', '可测性', '测试', '设计'], group: '测试', confidence: 0.92 },
  '23-integration-contract.md':                    { type: 'decision', tags: ['android', 'webview', '决策', '升级', '契约', '文档', '架构', '耦合'], group: '架构', confidence: 0.9 },
  '24-local-secret-storage.md':                    { type: 'decision', tags: ['allowbackup', 'dataextractionrules', 'token', '存储', '安全', '隐私'], group: '架构', confidence: 0.9 },
  '25-architecture-layering.md':                   { type: 'decision', tags: ['modularization', 'mvvm', 'viewmodel', '单测', '架构'], group: '架构', confidence: 0.9 },
  '26-agent-skills-eval.md':                       { type: 'fact', tags: ['adb', 'agent-skills', 'android', 'cdp', 'compose', 'gradle', 'kotlin', 'mcp', 'webview', 'windowinsets', '导航', '技能包', '测试分层', '调试', '选型'], group: '参考资料', confidence: 0.85 },
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

// 先把 META 和磁盘对齐：漏写一篇就会在下面 readSource 里 ENOENT，
// 多写一个不存在的名字同样报错。宁可在这里明确失败，也不要静默少灌几篇。
const onDisk = readdirSync(KBDIR).filter(f => f.endsWith('.md')).sort();
const metaKeys = Object.keys(META).sort();
const missingMeta = onDisk.filter(f => !META[f]);
const ghostMeta = metaKeys.filter(f => !onDisk.includes(f));
if (missingMeta.length || ghostMeta.length) {
  throw new Error(
    `META 与 kb/*.md 不一致\n` +
    `  磁盘有但 META 没写：${missingMeta.join(', ') || '(无)'}\n` +
    `  META 有但磁盘没有：${ghostMeta.join(', ') || '(无)'}\n` +
    `  改了文件名或加了篇，就要同步改本文件的 META 表（参照 DB 的 knowledge_entries 导出）。`);
}

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
