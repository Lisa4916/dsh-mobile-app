# WebView 握手自愈闸门：401 裸页判据、cookie 清理范围与退避重试

> 适用环境：WebView 外壳 App（dsh-mobile-app）+ 中间层 `proxy.mjs` 反向代理，真机实测（Android 14 / 15）。
> 最后验证：2026-11，正反两向都在真机抓到决定性证据。

## 现象

三类，看起来都像「坏了」，成因完全不同，先分对类再动手：

1. 装好之后一次自愈都不触发；
2. 故障时页面停在「DSH Pocket · 访问验证」要求输入 PIN；
3. 日志出现 `already healed once, waiting for user` 后页面永久卡死。

## 判据：三种页面状态，不是两种

早期版本把页面只分成「健康 / 坏了」两态，于是**把 PIN 页也当成了健康**（因为它不是 401 裸页），自愈永远不触发——这就是现象 2 的直接原因。

现在 `PageProbe.classify(title, body)` 返回三态字符串，判据顺序是硬约束（正文优先、标题兜底）：

| 顺序 | 判据 | 返回 |
|---|---|---|
| 1 | 正文含 `导出会话日志` | `"0"` 健康（主界面） |
| 2 | 正文含 `探索未至之境` | `"0"` 健康 |
| 3 | 标题含 `正在进入` | `"0"` 健康（握手过渡页，别动手） |
| 4 | 正文含 `无法完成登录握手` | `"1"` 握手坏 |
| 5 | 正文含 `dsh web authentication required` | `"1"` 握手坏 |
| 6 | 正文含 `受访问密码保护` | `"2"` 要 PIN |
| 7 | 正文含 `访问密码` | `"2"` 要 PIN |
| 8 | 标题含 `访问验证` | `"2"` 要 PIN |
| 9 | 正文空 且 标题含 `无法完成登录握手` | `"1"` 握手坏 |
| 10 | 其它 | `"0"` 健康（**拿不准一律不动手**） |

第 1、2 条必须在前面：主界面正文里也会出现「访问密码」这类字样（设置页文案），顺序错了会误清 cookie。第 3 条必须挡住「正在进入」——那是 meta-refresh 过渡页，动手等于打断一次正常的握手。

**标题残留但正文正常，要判健康。** 判据回归里专门有这条反例。

## 为什么 401 裸页是真正的成因（不是 503 限流页）

`proxy.mjs:606` 只要请求头里带 `dsh-auth-*` 就**永不**补 launch token。于是一条 authority 指向旧端口（DSH 重启后端口会变，实测 54282 → 17169）的僵尸 cookie 会让上游稳定返回 401 + `dsh web authentication required`。这条路径不注入 token → 限流计数不涨 → **永远等不到 503**。所以只看 503 / 限流计数的判据必然失效。

## cookie 清理范围：两种故障清的东西不一样（这是最容易搞反的一处）

> **旧结论（已推翻）**：自愈时「只清 `dsh-auth-*`，永远保留 `dsh_pocket_token`」。
> 这条在 401 场景是对的，但在 PIN 页场景**会让用户永久卡在验证页**。

真正的机制（读 `proxy.mjs:509-525` `maybeSeedAuthCookie` 得到，并用 curl 对照实验验证）：

```js
// 第一行就是它
if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;
```

**只要浏览器里还留着一个哪怕已失效的 `dsh_pocket_token`，代理就再也不肯下发新的。** 于是 `?token=<PIN>` 认证通过、页面进「正在进入」过渡页、但下一跳 `GET /` 没有有效 cookie → 回到访问验证页。用户看到的正是「又要我输 PIN，可我有 URL 里的 token」。

所以：

| 页面状态 | 动作 | 理由 |
|---|---|---|
| 握手坏（`"1"`） | 只清 `dsh-auth-*`，**保留** `dsh_pocket_token` | PIN 会话仍然有效，全清会把用户踢回登录 |
| 要 PIN（`"2"`）且 URL 的 query 里**确实有** `?token=` | 清 `dsh_pocket_token`，再用原 URL 带 token 重导航 | 不清就永远拿不到新 cookie；有 token 就能自动重建，用户无感 |
| 要 PIN（`"2"`）但 URL 里**没有** `token` | **什么都不清**，提示用户重新扫码/粘贴完整地址 | 清了就锁死——没有 token 就再也进不去 |

最后一行是铁律：**只有确认 URL 带 `?token=` 时才允许清 `dsh_pocket_token`。** 代码里 `RecoveryPlanner.hasPinToken(url)` 负责这个判断，键名必须完全等于 `token` 且值非空（fragment 里的 token、`mytoken` 这类都不算）。

重导航时必须同时补上 `dsh-pocket-retry=1`：它顺带清掉握手计数，避免重连撞上 503「无法完成登录握手」。而且它**必须插在 `#` 之前**——直接拼在 URL 末尾会落进 fragment，服务端收不到。

## 节流与退避

- 探测节流：只在「刚动过手之后」设 1200ms 静默期（旧版是 5 秒硬节流，会把「页面已恢复」那次 `onPageFinished` 吃掉，闸门误以为还在同一轮故障里）。
- 动作预算：同一故障周期最多 3 次，退避 5s → 10s → 封顶 30s。
- **`0L` 哨兵值是个坑**：用 `lastProbeAt = 0L` 表示「从未探测」时，时钟现值小于 5000 会让首次探测被判成节流内，首次自愈永不触发。改用显式 `probed` 布尔。
- ASK_USER 这个「只提示不动手」的分支**也要计入动作预算**，否则每次 `onPageFinished` 都弹一次 Toast。

## 状态归属：闸门只管计数，决策与执行要分开

`HandshakeHealGate`（纯 JVM，可单测）只回答三个问题：能不能探测、能不能动手、这次算不算健康。
`RecoveryExecutor`（同样纯 JVM）把「探测结果 → 动作」编排起来，副作用通过 `RecoveryEnvironment` 接口注入（清上游 cookie / 清 pocket cookie / 导航 / 提示 / 日志）。
`MainActivity` 只提供 UI 实现。这样整条自愈链路都能在 JVM 单测里跑，不必上真机试错——**判错就删用户 cookie，这件事不能只靠真机试**。

## 验收证据（真机，双向）

| 验证 | 结果 |
|---|---|
| 正面：弄脏 `dsh_pocket_token` → 导航 | 请求序列出现 `/?token=<PIN>&dsh-pocket-retry=1` 那一跳，cookie 被重新下发，进主界面 |
| 反面：端点 URL 去掉 `?token=` 后再弄脏 | 15 秒内**不**出现自愈重连、停在访问验证页、脏 cookie **未被清掉**（证明铁律生效） |
| 判据回归 | `PageProbeTest` 20 例全绿 |
| 编排回归 | `RecoveryExecutorTest` 12 例 + `CookieNamesTest` 10 例 + `HandshakeHealGateTest` 10 例全绿 |

**反面用例比正面用例更重要**：正面只能证明「能修好」，反面才能证明「不会把用户锁死」。

## 三个验证陷阱

1. **E2E 脚本判据偏软**：把 `OTHER` / `EMPTY` 中间态也算「见到故障」，只看脚本输出会误判自愈已发生。要么独立用 CDP 抓请求序列，要么读 logcat 交叉验证。
2. **pid 变化不等于崩溃**：16262 → 16803 是 MIUI 的 `am_kill ... SwipeUpClean` 系统清理，不要当成自愈引发崩溃去查。
3. **重启 App 会掩盖故障**：CDP 的 `Network.setCookie` 只写进 WebView **活的** cookie store，杀进程后 WebView 从磁盘 Cookies 库恢复旧的好值。所以「弄脏 → force-stop → 启动」观察不到任何东西，验证必须在同一进程内完成导航。
