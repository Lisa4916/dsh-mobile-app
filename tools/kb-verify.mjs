// 入库后核对：DB 五表 + 磁盘文件 + structure_json 合法性 + FTS 召回试探
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MOD = 'file:///C:/Users/yaoqi/.dsh/profiles/desktop/node_modules/@lemoncat7/dsh-knowledge/lib';
const { parseKnowledgeMarkdown } = await import(`${MOD}/documents/markdown.js`);
const { validStructure } = await (async () => {
  const m = await import(`${MOD}/retrieval-index.js`);
  return { validStructure: m.validStructure ?? (() => 'n/a') };
})();

const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const BASEDIR = 'C:/Users/yaoqi/.dsh/knowledge/documents/base-e1b49da1';
const db = new DatabaseSync('C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite', { readOnly: true });

console.log('== knowledge_entries ==');
for (const r of db.prepare('SELECT id,title,type,tags_json,scope_kind,scope_id,confidence,status,version,document_group FROM knowledge_entries WHERE knowledge_base_id=? ORDER BY title').all(BASE_ID)) {
  console.log(`  ${r.type.padEnd(9)} conf=${r.confidence} v${r.version} grp=${r.document_group} scope=${r.scope_kind}/${r.scope_id ?? '-'} tags=${r.tags_json}`);
  console.log(`    ${r.title}`);
}

console.log('== knowledge_documents ==');
for (const r of db.prepare('SELECT rel_path,title,entry_count,length(content) AS clen,substr(content_hash,1,12) AS h FROM knowledge_documents WHERE knowledge_base_id=? ORDER BY rel_path').all(BASE_ID)) {
  console.log(`  ${r.rel_path}  entry_count=${r.entry_count} contentLen=${r.clen} hash=${r.h}`);
}

console.log('== passage_index ==');
for (const r of db.prepare(`SELECT p.entry_id,p.state,p.index_version,length(p.structure_json) AS slen,e.title
  FROM knowledge_passage_index p JOIN knowledge_entries e ON e.id=p.entry_id WHERE e.knowledge_base_id=?`).all(BASE_ID)) {
  const s = JSON.parse(db.prepare('SELECT structure_json FROM knowledge_passage_index WHERE entry_id=?').get(r.entry_id).structure_json);
  let ok = 'n/a';
  try { ok = validStructure(s) ? 'valid' : 'INVALID'; } catch (e) { ok = 'throw:' + e.message; }
  console.log(`  ${r.state} v${r.index_version} blocks=${s.blocks.length} sections=${s.sections.length} totalChars=${s.totalChars} json=${r.slen}B validStructure=${ok}`);
  console.log(`    ${r.title}`);
}

console.log('== versions ==');
console.log('  ' + db.prepare('SELECT count(*) AS n FROM knowledge_versions WHERE knowledge_id IN (SELECT id FROM knowledge_entries WHERE knowledge_base_id=?)').get(BASE_ID).n + ' 条');

console.log('== 磁盘 ==');
const baseDirOk = (() => { try { return statSync(BASEDIR).isDirectory(); } catch { return false; } })();
console.log('  ' + BASEDIR + ' 存在=' + baseDirOk);
for (const f of readdirSync(BASEDIR)) {
  const p = join(BASEDIR, f);
  const raw = readFileSync(p, 'utf8');
  let info = '';
  try {
    const parsed = parseKnowledgeMarkdown(raw);
    info = `解析OK type=${parsed.metadata.type} tags=[${parsed.metadata.tags.join(',')}] state=${parsed.metadata.documentState} body=${parsed.body.length}字`;
  } catch (e) { info = '解析失败: ' + e.message; }
  console.log(`  ${f}  ${statSync(p).size}B  ${info}`);
}

console.log('== FTS 召回试探 ==');
for (const q of ['键盘 不同步', 'webview 外壳', 'adb cdp', '草壳不存在词xyzzy']) {
  const rows = db.prepare(`SELECT e.title, bm25(knowledge_fts) AS score
    FROM knowledge_fts JOIN knowledge_entries e ON e.id=knowledge_fts.knowledge_id
    WHERE knowledge_fts MATCH ? AND e.status='active' ORDER BY score LIMIT 3`).all(q);
  console.log(`  「${q}」→ ${rows.length} 命中` + (rows.length ? '：' + rows.map(r => r.title.slice(0, 26)).join(' | ') : ''));
}
db.close();
