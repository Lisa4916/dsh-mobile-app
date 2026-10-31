// 把「手机软件开发知识库」挂载到 DSH 相关项目目录
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const BASE_ID = 'e1b49da1-ad61-4586-9333-ee4ec202e315';
const TARGETS = ['D:\\DeepSeek Harness', 'D:\\dsh-mobile-app'];
const db = new DatabaseSync('C:/Users/yaoqi/.dsh/knowledge/knowledge.sqlite');
db.exec('PRAGMA journal_mode=WAL;');

const ts = () => new Date().toISOString();
const ins = db.prepare(`INSERT INTO knowledge_mounts(
  id,target_kind,target_id,knowledge_base_id,enabled,recall_enabled,write_mode,
  include_tags_json,exclude_tags_json,extraction_instructions,created_at,updated_at)
  VALUES(?,?,?,?,1,1,'audit','[]','[]','',?,?)
  ON CONFLICT(target_kind,target_id,knowledge_base_id) DO UPDATE SET
    enabled=1,recall_enabled=1,write_mode='audit',updated_at=excluded.updated_at`);

for (const t of TARGETS) {
  const ex = existsSync(t);
  ins.run(randomUUID(), 'project', t, BASE_ID, ts(), ts());
  console.log(`挂载 ${t}  目录存在=${ex}`);
}

console.log('\n== 当前全部挂载 ==');
for (const r of db.prepare('SELECT target_kind,target_id,knowledge_base_id,enabled,recall_enabled,write_mode FROM knowledge_mounts ORDER BY target_id').all()) {
  const b = db.prepare('SELECT name FROM knowledge_bases WHERE id=?').get(r.knowledge_base_id);
  console.log(`  [${r.target_kind}] ${r.target_id}  →  ${b?.name ?? '?'}  enabled=${r.enabled} recall=${r.recall_enabled} write=${r.write_mode}`);
}
db.close();
