#!/usr/bin/env node
/**
 * 把本项目注册成 DSH 的一个工作区，这样新会话可以直接在下拉里选到 `D:\dsh-mobile-app`，
 * 不必每次手打「读 D:\dsh-mobile-app\AGENTS.md」。
 *
 * ## 为什么默认只 dry-run
 *
 * DSH 的**运行中进程**会把内存里的工作区状态写回
 * `~/.dsh/storages/workspace.json`。在 DSH 开着的时候改这个文件，
 * 你的改动随时会被下一次写盘覆盖 —— 看起来成功了，重启后又没了。
 *
 * 所以：
 * - 默认 `--dry`：只打印将要写入的记录，不动文件；
 * - `--apply`：真写，但**先检测 DSH 是否在跑**，在跑就拒绝并告诉你先退出。
 *
 * ## 记录结构（对应 @deepseek-ai/dsh-workspace 的 workspaceDomainSpec v2）
 *
 * ```json
 * { "unit": { "name": "workspace", "version": 2 },
 *   "global": { "initialized": true, "defaultWorkspaceId": "...", "workspaceIds": [ ... ],
 *               "archivedSessionIds": [], "pinnedSessionIds": [] },
 *   "tables": { "workspaces": { "<uuid>": { "path": "...", "title": "...",
 *                                          "sessionIds": [], "createdAt": "...", "updatedAt": "..." } } } }
 * ```
 *
 * 注意 `path` 必须与 `fs.realpath` 的结果**逐字符相等**（唯一性就是字符串相等），
 * 所以脚本先 realpath 再比对。已存在同一路径就**只读**、不改 title（与上游 create 语义一致）。
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pathArg = args.find((a) => !a.startsWith("--")) ?? "D:\\dsh-mobile-app";
const titleArg = (() => {
  const i = args.indexOf("--title");
  return i >= 0 ? args[i + 1] : "DSH 手机遥控";
})();

const storePath = join(homedir(), ".dsh", "storages", "workspace.json");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(storePath)) fail(`找不到 ${storePath}（DSH 还没初始化过工作区？先开一次 DSH）`);

const target = resolve(pathArg);
if (!existsSync(target)) fail(`目录不存在：${target}`);
const canonical = realpathSync(target);

const raw = readFileSync(storePath, "utf8");
let store;
try {
  store = JSON.parse(raw);
} catch (e) {
  fail(`${storePath} 不是合法 JSON：${e.message}`);
}
if (store.unit?.name !== "workspace") fail(`意外的 unit：${JSON.stringify(store.unit)}`);

const table = store.tables?.workspaces ?? {};
const existing = Object.entries(table).find(([, w]) => {
  // 存档里的 path 也是 realpath 之后的；比对前再 realpath 一次，防止大小写/短名差异。
  try {
    return realpathSync(w.path) === canonical;
  } catch {
    return w.path.toLowerCase() === canonical.toLowerCase();
  }
});

if (existing) {
  const [id, w] = existing;
  console.log(`✓ 已经注册过了，不需要再动`);
  console.log(`  id    = ${id}`);
  console.log(`  path  = ${w.path}`);
  console.log(`  title = ${w.title}`);
  console.log(`  登记在 workspaceIds 里：${store.global.workspaceIds.includes(id) ? "是" : "**否（异常）**"}`);
  process.exit(0);
}

const now = new Date().toISOString();
const id = randomUUID();
const record = {
  path: canonical,
  title: titleArg,
  sessionIds: [],
  createdAt: now,
  updatedAt: now,
};

console.log(apply ? "将要写入：" : "【dry-run】将要写入（加 --apply 才落盘）：");
console.log(
  JSON.stringify(
    {
      store: storePath,
      newWorkspaceId: id,
      record,
      globalWorkspaceIdsAfter: [id, ...store.global.workspaceIds],
    },
    null,
    2,
  ),
);

if (!apply) {
  console.log("\n提示：先退出 DSH 再带 --apply 跑，否则运行中的进程会把状态写回覆盖掉。");
  process.exit(0);
}

// DSH 在跑就别写 —— 写得进也留不住。
function dshRunning() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { encoding: "utf8" },
    );
    return Number(out.trim()) > 0;
  } catch {
    return false; // 判断不了就当没跑，别把用户堵死
  }
}
if (dshRunning()) {
  fail("DSH 正在运行，现在写会被它写回覆盖。先退出 DSH（含托盘），再带 --apply 重跑。");
}

store.tables ??= {};
store.tables.workspaces ??= {};
store.tables.workspaces[id] = record;
store.global ??= {};
store.global.workspaceIds = [id, ...(store.global.workspaceIds ?? [])];

const bak = `${storePath}.bak-wsreg-${Date.now()}`;
copyFileSync(storePath, bak);
writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");

console.log(`✓ 已写入 ${storePath}`);
console.log(`  备份 ${bak}`);
console.log(`  新工作区 id = ${id}（title「${titleArg}」）`);
console.log(`  下次启动 DSH，工作区下拉里就能选到 ${canonical}`);
