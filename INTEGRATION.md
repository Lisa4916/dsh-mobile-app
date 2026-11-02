# INTEGRATION.md — 与 dsh-pocket 的耦合面

> 这份文件的存在理由：本 App **不是**一个独立应用，它是 `dsh-pocket` 的配套外壳。
> App 里有多处逻辑直接依赖 dsh-pocket 的**内部实现细节**（cookie 名、query 参数名、
> 页面上的中文字面量）。这些都不是公开 API，dsh-pocket 升级时可能**静默失效**——
> 不会编译报错、不会崩，只是某个自愈功能悄悄不工作了。
>
> 每次升级 dsh-pocket 后，请按本文末尾的「升级检查清单」逐条验一遍。

**当前对照版本：`dsh-pocket 2.12.0`**
包路径：`C:\Users\yaoqi\.dsh\profiles\desktop\node_modules\dsh-pocket`
（macOS/Linux 对应 `~/.dsh/profiles/desktop/node_modules/dsh-pocket`）

---

## 1. 网络链路

```
手机 App (com.dsh.remote)
  │  WebView 打开一个地址
  ▼
dsh-pocket 反代        ← 默认 3081（局域网）；公网隧道另给 https://<random>.trycloudflare.com
  │  认证 + cookie + 注入 launch token
  ▼
dsh web（Harness 主进程）  ← 端口每次启动都变（实测 54282 → 17169）
```

App 只跟 dsh-pocket 说话，**从不直接访问 dsh web**。dsh web 端口变了 App 不需要知道。

---

## 2. 耦合点清单

下表每一行都是「App 侧硬编码的字面量 ↔ dsh-pocket 侧的真实实现」。
「dsh-pocket 侧位置」列给的是 2.12.0 的行号，升级后行号会漂移，靠 `grep` 重新定位。

### 2.1 Cookie：`dsh_pocket_token`（局域网 PIN 会话）

| | |
|---|---|
| App 侧 | `MainActivity.kt` 的 `POCKET_COOKIE = "dsh_pocket_token"`，用于 `clearPocketCookie()` |
| dsh-pocket 侧 | `lib/proxy.mjs` 中 `const TOKEN_COOKIE = 'dsh_pocket_token'`；`maybeSeedAuthCookie()` |
| 语义 | 值 = `sha256(PIN + ":" + sessionKey)`，`Max-Age` 30 天，`HttpOnly` |
| **关键坑** | `sessionKey` 是 `randomBytes(16)` 生成的**进程级随机值，不落盘**（`lib/index.js`）。所以 cookie 的真实寿命 = dsh web 进程从启动到关闭，**不是** 30 天。dsh web 一重启，手机上的旧 cookie 必然失配 |
| **致命细节** | `maybeSeedAuthCookie()` 第一行是 `if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;` —— **只要请求里还带着一个哪怕早已失效的 `dsh_pocket_token`，代理就拒绝下发新的**。于是 `GET /?token=PIN` 认证通过 → 过渡页 → 下一跳 `GET /` 带坏 cookie → 认证失败 → 「访问验证」页 |

这条是「用户明明 URL 里有 token，却还是被要求输 PIN」的根因，
也是 `RecoveryPlanner.CLEAR_POCKET_COOKIE` 这个动作存在的唯一理由。

**铁律**：**只有在 URL 里确实还带着 `?token=` 时，才允许清 `dsh_pocket_token`。**
否则用户会被永久锁在「访问验证」页外面——那里只有密码框，没有别的入口。

### 2.2 Cookie：`dsh-auth-*`（上游 dsh web 会话）

| | |
|---|---|
| App 侧 | `MainActivity.kt` 的 `AUTH_COOKIE_PREFIX = "dsh-auth-"`，用于 `clearAuthCookies()` |
| dsh-pocket 侧 | `lib/proxy.mjs` 的 `DSH_AUTH_COOKIE = 'dsh-auth-'`；`upstreamPathWithLaunchToken()` |
| 语义 | 由 dsh web 签发，`authority` 字段里写着自己签发给哪个端口 |
| 故障形态 | dsh web 重启换端口后，WebView 里存着**旧端口**签发的 `dsh-auth-*`。代理看到 `cookieHeader.includes('dsh-auth-')` 就**不再补 launch token**，上游于是回 401，页面只剩一行 `dsh web authentication required` |

**铁律**：清 `dsh-auth-*` 时必须保留 `dsh_pocket_token`，反之亦然。
`CookieManager.removeAllCookies()` 会把用户一起踢回验证页（真机实测复现过）。

### 2.3 Query 参数：`?token=<PIN>`

| | |
|---|---|
| App 侧 | 地址里本来就带；`RecoveryPlanner.hasPinToken()` 负责判断「还在不在」 |
| dsh-pocket 侧 | `lib/proxy.mjs` 的 `authCheck()`：先比 cookie，cookie 不中再比 URL 里的 `?token=`（与明文 PIN 直接 `timingSafeEqual`） |
| 命中后行为 | 认证通过 → 下发 cookie → 303/meta refresh 到 `/`，**URL 上的 token 被消费掉**（进主界面后 URL 里就没有 `?token=` 了） |

所以 `hasPinToken()` 必须能从 URL 里认出 token 还在不在，
但它**不能**用 `android.net.Uri` 实现——JVM 单测里 `Uri` 是空实现（stub），
会静默返回 null 让测试变成假绿。现在是自己按 `&` 拆键值对。

### 2.4 Query 参数：`dsh-pocket-retry=1`

| | |
|---|---|
| App 侧 | `RecoveryPlanner.withRetry()` 负责**幂等**追加 |
| dsh-pocket 侧 | `lib/proxy.mjs` 用它清掉该客户端 IP 的握手重试计数 |
| 为什么必须带 | 握手重试计数器按客户端 IP 记，**上限 3 次 / 60 秒**。自愈如果反复重导航而不清计数，会撞上 `503「DSH Pocket · 无法完成登录握手」`——自愈反而把用户挡在门外 |

**坑**：`withRetry()` 必须把参数插在 `#` 之前。直接拼在字符串末尾时，
`?dsh-pocket-retry=1` 会落进 fragment，服务端收不到，计数清不掉。

### 2.5 页面文案（`HEAL_PROBE_JS` 的判据）

App 靠 WebView 里的正文/标题文字判断「现在是什么页面」，这是**最脆的一层**——
dsh-pocket 改一句文案，自愈就会静默失效（不会崩，只是不再触发）。

| 返回值 | 含义 | App 依赖的字面量 | 来源 |
|---|---|---|---|
| `'0'` | 正常主界面 | `导出会话日志`、`探索未至之境` | dsh web 前端（不是 dsh-pocket） |
| `'0'` | 握手过渡页，**不能当故障** | 标题含 `正在进入` | dsh-pocket `handshakePageHtml()` |
| `'1'` | 上游 401 握手损坏 | 正文含 `无法完成登录握手` 或 `dsh web authentication required` | dsh-pocket + dsh web |
| `'2'` | PIN 登录页 | 正文含 `受访问密码保护` / `访问密码`，标题含 `访问验证` | dsh-pocket 登录页 |

判据设计上**正文优先、标题兜底**（标题回调比正文晚一拍）。
`'0'` 的匹配必须放在 `'1'`/`'2'` 之前：主界面正文里也可能出现「访问」之类的词。

### 2.6 端口与地址

| | |
|---|---|
| 局域网 | dsh-pocket 默认反代 3081（可在设置里改） |
| 公网 | quick tunnel 生成 `https://<三词随机>.trycloudflare.com`，**每次开启都变** |
| 地址不落盘 | `~/.dsh/dsh-pocket/tunnel-auto.json` 只记 `{"at":<时间戳>}`，**不记 URL**；该目录下所有文件都不含 `trycloudflare` 字符串 → 隧道关掉后旧地址找不回来 |

App 侧对应处理：`Endpoint.urlIsVolatile` 对 `.trycloudflare.com` 返回 true，
连接列表里显示橙色提示「快速隧道地址每次重开都会变，变了要重新扫码」。

---

## 3. App 侧**不**依赖的东西（写清楚免得被误改）

- dsh web 的端口号：App 从不直连，端口变了无感。
- dsh-pocket 的 RPC 通道（`/dsh-pocket` 上的 `pocket.status` / `tunnel.start` 等）：App 不调。
- dsh-pocket 的 `settings.json` 结构：App 不读。
- PIN 本身：App 不保存、不校验，只把它当 URL 的一部分。

> 待办（未做）：隧道地址变化目前仍需用户手动重新扫码。
> 若将来要做「自动读回隧道地址」，应走 dsh-pocket 的 `pocket.status` RPC，
> **不要**去猜 `tunnel-auto.json`（里面没有 URL）。

---

## 4. 升级 dsh-pocket 后的检查清单

按顺序做，每条都能在真机上验，不需要读源码：

1. **局域网直连**：手机连同一 Wi-Fi，扫「手机访问」页的二维码 → 应进主界面。
2. **PIN 页自愈**（对应 2.1）：
   - 在电脑上重启 DSH（让 `sessionKey` 换新）；
   - 手机上用带 `?token=` 的旧地址打开；
   - 预期：页面闪一下「访问验证」后自动进主界面。
   - 若停在验证页不动 → 检查 `POCKET_COOKIE` 是否还叫 `dsh_pocket_token`。
3. **握手自愈**（对应 2.2）：在电脑上重启 dsh web 换端口（不要杀 dsh-pocket），
   手机端下拉/重进 → 预期自动恢复，不出现 `dsh web authentication required`。
4. **限流不自伤**（对应 2.4）：连续快速触发自愈 3 次以上，
   预期不出现 `503 无法完成登录握手`。
5. **过渡页不误判**（对应 2.5）：首次进入时若出现「正在进入」页，
   预期 App **不**清 cookie（只是等）。
6. **公网**：设置页「开启公网访问」→ 关 Wi-Fi 走 4G → 能进主界面。

任一条失败 → 先 `grep` 对应字面量：

```powershell
# 在 dsh-pocket 包里找当前文案与常量名
$p = "C:\Users\yaoqi\.dsh\profiles\desktop\node_modules\dsh-pocket"
Select-String -Path "$p\lib\*.mjs","$p\lib\*.js" -Pattern 'TOKEN_COOKIE|dsh-auth-|dsh-pocket-retry|访问验证|正在进入|无法完成登录握手'
```

---

## 5. 已知的遗留风险

| 风险 | 现状 | 缓解 |
|---|---|---|
| 文案判据全在 JS 字符串里，改一句话就静默失效 | 未解决 | `RecoveryPlannerTest` 只钉住了「输入 → 决策」，钉不住「dsh-pocket 到底返回什么」。真实判据只能靠本文第 4 节人工验 |
| `dsh_pocket_token` 寿命 = dsh web 进程寿命 | dsh-pocket 的设计（issue #33），不是 bug | App 侧靠自愈补偿；真正治本要 dsh-pocket 把 `sessionKey` 落盘 |
| quick tunnel 地址每次变 | dsh-pocket 现状 | App 列表标 `PUBLIC` + 易变提示；未做自动读回 |
| 无 `androidTest`，上述链路全靠 `tools/*.cjs` 手跑 | 未解决 | 见 PROGRESS.md「下一步」第 6 项 |
