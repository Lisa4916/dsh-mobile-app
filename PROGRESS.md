# PROGRESS — dsh-mobile-app 开发日志

> 任务、环境变量、纪律、踩坑清单，全部在 [`AGENTS.md`](D:\dsh-mobile-app\AGENTS.md)。
> 本文件只记「做了什么、验证证据是什么、下一步接哪里」。

---

## 状态总览

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 工程骨架 + 构建工具链 | ✅ | `assembleDebug` 通过 |
| 2 | 连接列表 / 扫码 / 手输地址 | ✅ | 真机可用 |
| 3 | 全屏 WebView 加载 dsh-pocket | ✅ | 真机显示电脑上同一段对话 |
| 4 | 键盘避让改为页面 rAF 自驱 | ✅ | 帧间隔 8ms，全程 195ms |
| 5 | 启动自动连接 + 落在主界面 | ✅ | CDP 实测 `title=DeepSeek Harness` |
| 6 | 移除顶部返回键 | ✅ | 交给系统返回键 |
| 7 | 公网远程连接（隧道） | 🟡 阻塞已解，待真机 | 见下 |
| 7a | 连接列表区分「局域网 / 公网 / 本机」落点 | ✅ | `tests=24 failures=0`（EndpointTest） |
| 7b | 「访问验证」页自愈：清失效 `dsh_pocket_token` 后带 token 重连 | ✅ | 全量 `tests=59 failures=0` |
| 8 | 手机软件开发知识库（5 篇种子文档入库 + 挂载） | ✅ | entries/documents/fts = 5/5/5 |

**测试基线：全量 `tests=59 failures=0 errors=0 skipped=0`**
（`BackNavigationDeciderTest` 11 + `EndpointTest` 24 + `HandshakeHealGateTest` 10 + `RecoveryPlannerTest` 14）
**APK：`app-debug.apk` 7,469,704 B（全量构建；增量构建会差约 40 KB，属 dex/资源打包顺序差异，不是回归）**（versionName 0.1.0，versionCode 1）

---

## 第 1 步：工程骨架 ✅

`D:\dsh-mobile-app`，包名 `com.dsh.remote`，AGP 8.7.3 / Kotlin 2.0.21 / Gradle 8.9 / JDK 17，
compileSdk 35 / minSdk 24 / targetSdk 35。

`Endpoint.kt` 一度用 `android.net.Uri`，JVM 单测里 `Uri.parse` 抛 `Stub!`（3 条测试失败），
改成 `java.net.URI` + 手写规范化后 `Endpoint` 变纯 JDK 可测。这是本项目的第一个结构性决策。

## 第 2 步：连接列表 / 扫码 / 手输 ✅

`ScanActivity`：CameraX `Preview` + `ImageAnalysis`，`MultiFormatReader` 解码，`PlanarYUVLuminanceSource` 取 Y 平面，
只接受能过 `Endpoint.parseUri` 的 http(s) 结果。
`MainActivity`：连接列表（增删、按 `lastUsedAt` 排序）+ 手输框 + 扫码按钮 + **「填入本机示例」按钮**。

那个示例按钮不是方便功能，是**必需功能**：`adb shell input text` 在中文输入法下会把 `http` 吞成 `p://`，
分字符注入也失败。地址必须由代码写。

## 第 3 步：WebView 打通 ✅

真机截图显示的是电脑上正在进行的同一段对话，含流式输出、工具卡片、子智能体状态。
`uiautomator dump` 显示 WebView 铺满 1080×2460。

期间踩的坑：三次截图全黑分别是屏幕睡眠、通知栏抢焦点、渲染时序，**截图不能当判据**。

## 第 4 步：键盘避让（本项目最费劲的一处）✅

**症状**：点输入框，键盘滑上来，界面跟着缩，速度对不上，中间露出底色（用户原话「一闪的留白」）。

过程是三层递进，每层都推翻上一层的判断：

1. **第一版**：给人根 `FrameLayout` 加 `bottomMargin`。错 —— 只是把画布上推，WebView 自身高度没变，`window.innerHeight` 还是 895，DSH 的 fixed 元素按老高度布局，照样被盖。
2. **第二版**：对 WebView 和 listRoot 各设 `bottomMargin`，高度真的变了（innerH 895→573，差 322 一致），键盘遮挡消失。**但开始抖。**
3. **第三版**：解出 MIUI 的真实动画参数（`input_method_enter.xml`：`duration=300`、`interpolator=decelerate_quint factor=2.5` → `1-(1-t)^5`），用 `ValueAnimator` 补间。**还是抖。**
4. **第四版（定案）**：发现根本原因是**页面侧的 innerHeight 不是逐帧生效的**。

决定性证据来自 `tools/measure-sync.cjs` 的同钟对齐：

| 侧 | 位移跨度 | 变化次数 | 节奏 |
|---|---|---|---|
| 原生 `bottomMargin` | 456ms | 53 | 约 7ms/次 |
| 页面 `innerHeight` | 897ms | 19 | **约 108ms/次** |

起始只差 6ms，但全程差两倍。→ WebView 把尺寸变化按批合并提交，**原生怎么补间都追不上**。

对照实验 `tools/test-page-drive.cjs` 反过来验：页面自己 rAF 改 `#root.style.height`，帧间隔中位数 12~20ms，
且 `#root` 高度减多少、输入框就上移多少，与原生压 WebView **完全等效、比例 1:1**。

于是分工彻底反转：**WebView 全程不缩，原生只推一次终值，页面用 rAF 补间。**

中间还有一个把我坑进去的判断错误：`WindowInsetsAnimationCompat` 的 `onProgress` 给的是动画**中间态**，
`setOnApplyWindowInsetsListener` 给的才是**终值**。我搞反了，每帧改一次目标，页面补间被反复重启。
是 `tools/trace-keyboard-calls.cjs` 打出的 `h=321.8 → h=0 → 34.2 → 67.3 → …` 序列才把它揪出来。

**最终实测**：

| 方向 | 位移帧数 | 帧间隔中位数 | 全程 | 单调 |
|---|---|---|---|---|
| 修复前 | 19 | 108ms | 897ms | — |
| 弹出 | 22 | **8ms** | **195ms** | 是 |
| 收起 | 9 | ~14ms | ~170ms | 是 |

另一个隐性坑：原生 insets 是设备像素 885，页面 CSS 是 322，`density = 2.748`。
忘了换算会算出 `895 - 885 = 10px`，布局直接崩。

## 第 5 步：启动自动连接 + 落在主界面 ✅

用户要求「开启软件直接进入主界面，后台自动连接」，追加澄清「进入主界面，不是直接进入某一个对话」。

`autoconnect()`：有历史记录就直连，没有就用 `DEFAULT_LAN_URL` 建一条再连。

主界面这一半更麻烦：App 只加载 `http://192.168.50.58:3081/`（无 hash、无 path），但 DSH 前端会自己恢复上次会话。
CDP 查出靠的是 `localStorage['dsh.sessions.current']`，与 URL 无关。

`onPageFinished` 里删太晚（旧对话已渲染，删完还要再刷一次，会先闪一下）。
必须用 **document-start**：`WebViewCompat.addDocumentStartJavaScript(wv, HOME_RESET_JS, setOf("*"))`，
赶在 DSH 前端模块初始化读 localStorage 之前删键。
加双层一次性标记（`window.__dshHomeReset` + `sessionStorage.__dshHomeReset`）：
冷启动进主界面，进程内点进会话再返回不会被踢回去。

验证：CDP 实测 `title = "DeepSeek Harness"`（不再是会话标题）、`sessions.current` 换成了新的空会话。

## 第 6 步：移除顶部返回键 ✅

用户说「自动连接，左上角的返回键就可以不用了吧」。
确实该删：它常驻会压住 DSH 自己的顶部栏，而那个位置左边就是「打开侧边栏」。
回列表改由系统返回键承担（`onKeyDown` 里 `canGoBack()` 则 `goBack()`，否则 `showList()`）。

---

## 第 7 步：公网远程连接 ⛔ → 🟡 阻塞解除（2026-11-02 实测）

### 旧记录说的阻塞理由已经不成立

`AGENTS.md` 与旧 PROGRESS 都写「Clash/mihomo 开 sing-tun 掐断 cloudflared（error 1033）」。本轮逐项实测：

| 检查项 | 旧记录 | 实测 |
|---|---|---|
| mihomo/clash/verge 进程 | 开着 | **一个都没有** |
| wintun/TAP 网卡 | 启用 | **无** |
| 系统代理 | — | `ProxyEnable=0`（只剩 `ProxyServer=127.0.0.1:7890` 字符串残留） |
| 出口 | — | `ip=2408:832e:...:7844 loc=CN warp=off`，直连 |
| cloudflared | 边缘被掐 | `2026.10.7`；precheck 全 PASS（QUIC UDP / HTTP2 TCP / Cloudflare API） |
| 隧道注册 | 1033 | `Registered tunnel connection` `location=lax11` |
| 公网可达 | — | `https://<random>.trycloudflare.com/` → **200**，`title=DSH Pocket · 访问验证`，`cf-ray=...-LAX` |

本地 `http://127.0.0.1:3081/` 与公网都是 200 / 4210 B，内容一致 —— 数据面真的通了。
探测用 cloudflared 已清理，3081 主进程监听不受影响。

**结论**：不用关 TUN，也不用换 cpolar。第 7 步的阻塞从「技术不通」降级为「产品取舍」。

### 顺带查清的事实

- `3081` 由 `DeepSeek Harness.exe`（pid 10148）自己监听；`54282` 当前无监听，反代仍工作。
- `settings.json`：`publicPinCustom=true`、`lanPinCustom=true` → **PIN 已固定，不再轮换**；
  `token`(8 B) 与 `token-lan`(8 B) 都在，`DEFAULT_LAN_URL` 里的 `token=60111186` 就是 `token-lan`。
- `tunnel-auto.json` 存在但当前没有 cloudflared 在跑，说明上次隧道未处在开启态。
- `Endpoint.parseUri` 本来就接受 `https://`，公网地址不需要改解析逻辑。

### 剩余阻塞（都不是技术问题）

1. **公网 URL + PIN**：要在 dsh-pocket 设置页点「开启公网访问」（会弹免责声明，服务端强制校验）。
2. **真机**：`adb devices` 当前是空列表，公网验证必须上真机（关 WiFi 走 4G）。

---

## 第 7a 步：连接列表区分落点 ✅

### 为什么做这一步

列表里会同时存在「局域网入口」和「公网隧道入口」，两者指向同一台电脑。
不区分的话，人在外面点了局域网那条必然打不开，而且看不出为什么。

### 改动

`Endpoint` 增加 `kind: Kind`（`LOOPBACK` / `LAN` / `PUBLIC`），**默认值由 url 推断**，
所以老的构造点一个字不用改。旁边补两个派生属性：

- `isPublic` —— 公网入口换 Wi-Fi、切 4G 都该用它。
- `urlIsVolatile` —— quick tunnel 的 `*.trycloudflare.com` 每次重开都变，界面要提示
  「变了要重新扫码」，否则用户会在列表里反复点一条死链接。

推断规则里的两个坑，都用单测锁住了：

- **CGNAT `100.64/10` 不算私有**。手机在 4G 下常拿到 100.x，但那是运营商内网，
  连不到家里那台电脑。判成 LAN 会把一条必然打不开的链接标成「局域网」。
- **IPv4-mapped IPv6 `::ffff:192.168.1.5` 要拆出内嵌的 v4 再判**。
  只看首字节会掉进「3 不是 fc/fd/fe → 判公网」。

序列化从 4 列扩到 5 列（末列 kind），`deserialize` 对 4 列老数据**降级按 url 推断**，
无法识别的 kind 值也按 url 重新推断 —— 否则用户升级后连接列表会凭空清空。

### 验证

- `:app:assembleDebug` 通过；`:app:testDebugUnitTest --rerun-tasks` **tests=24 failures=0 errors=0**
  （12 → 23 → 24：新增 12 条覆盖网段边界、回环、IPv6 私有、CGNAT、mapped-v6、序列化兼容、易变地址）。
- APK `7,469,704 B`（全量构建）。
- 真机验证待 adb 设备接入后补做。

---

## 第 7b 步：「访问验证」页自愈 ✅

### 症状

用户原话：「打开 App 又要我输 PIN，可地址里明明带着 token」。
更糟的是 `HEAL_PROBE_JS` 老版本把「访问验证」页判成 `'0'`（正常），
所以自愈机制**永远不会动手**，用户只能手动重输。

### 根因（dsh-pocket 一侧，不是 App 的锅）

`lib/proxy.mjs:509-525`：

```js
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;   // ← 就是这一行
  ...
}
```

只要请求里带着**一个哪怕早已失效的** `dsh_pocket_token`，代理就拒绝下发新的。
而 `dsh_pocket_token` 的值是 `sha256(PIN:sessionKey)`，`sessionKey` 是 dsh web 的
**进程级随机数**（`lib/index.js:331-333`，不落盘）—— Harness 每重启一次就换新，
手机上那枚 cookie 必然失配。

于是链路变成：

```
GET /?token=PIN → 200 「正在进入」（认证通过）
  → GET /       → 带着坏 cookie → 认证失败 → 「DSH Pocket · 访问验证」
```

### 实测对照（用不同 `cf-connecting-ip` 换掉握手计数做隔离）

| 场景 | 第一步 | 第二步 |
|---|---|---|
| 基线（无 cookie） | `200 seed=True` | `200 len=47868` `DeepSeek Harness` ✅ |
| 故障（残留坏 cookie） | `200 seed=False` | `200 len=3969` `DSH Pocket · 访问验证` ❌ |
| 修复（清 cookie 后） | `200 seed=True` | `200 len=47868` `DeepSeek Harness` ✅ |

连续 5 轮「`?dsh-pocket-retry=1&token=PIN` → `GET /`」全部进主界面，不撞 503。

### 改动

新增 `RecoveryPlanner.kt`（纯 JVM，可单测），把「页面状态 → 该做什么」抽出来：

| PageState | 触发条件 | RecoveryAction |
|---|---|---|
| `HEALTHY` | 探测返回 `'0'` | `NONE` |
| `HANDSHAKE_BROKEN` | 返回 `'1'` | `CLEAR_UPSTREAM_COOKIE`（清 `dsh-auth-*`） |
| `PIN_REQUIRED` | 返回 `'2'` | URL 带 `?token=` → `CLEAR_POCKET_COOKIE`；否则 `ASK_USER` |
| `UNKNOWN` | 求值失败/空 | `NONE` |

`HEAL_PROBE_JS` 增加返回 `'2'`：正文含「受访问密码保护」或「访问密码」、
标题含「访问验证」。（老版本这些分支都 return `'0'`，这就是修不好的直接原因。）

`MainActivity`：
- `healHandshakeIfNeeded()` 改为按 `RecoveryPlanner.plan()` 分派，不再只看 `'1'`。
- 新增 `clearPocketCookie()`：只删 `dsh_pocket_token`，保留 `dsh-auth-*`。
- 删除 `appendRetryParam()`，统一委托 `RecoveryPlanner.withRetry()`
  （老版本没处理 `#`，`?dsh-pocket-retry=1` 会拼进 fragment，服务端收不到）。

### 两条铁律（都写进了注释与单测）

1. **只有 URL 里确实还带 `?token=` 时才允许清 `dsh_pocket_token`。**
   没有 token 就清，用户被永久锁在「访问验证」页外 —— 那个页面没有密码可填。
   → `plan_pinPageWithoutTokenAsksUser` / `plan_pinPageWithEmptyTokenAsksUser`
2. **`dsh-pocket-retry=1` 必须插在 `#` 之前**，否则落进 fragment 服务端收不到，
   握手计数清不掉，重连撞 503「无法完成登录握手」。
   → `withRetry_insertsBeforeFragment`

### 验证

- `:app:assembleDebug` 通过；`--rerun-tasks` 全量 **tests=59 failures=0 errors=0 skipped=0**。
  其中 `RecoveryPlannerTest` 14 条（`fromProbe` 2、`plan` 6、`hasPinToken` 2、`withRetry` 4）。
- 编译期仍只有 3 条既有 deprecation 警告（`ScanActivity.kt:108/113`、`WebViewFactory.kt:33`），与本次无关。
- **真机验证未做**：`adb` 无线调试配对成功（`guid=adb-ZY22GHMK5F-xFoQoe`）但连接一直 `offline`，见下节。

---

## 第 7c 步：真机无线调试接入（未完成）

用户在手机开了无线调试。排查过程：

1. `adb devices` 空、`adb mdns services` 空 —— Windows 上 adb 的 mDNS 发现不可靠
   （UDP 5353 被 `svchost` pid 3164 与 adb 自己 pid 7468 同时占）。
2. 从 ARP + mDNS 应答定位到手机是 **`192.168.50.138`**（MAC `6A-51-C1-17-9F-2D`），
   实例名 `adb-ZY22GHMK5F-xFoQoe`。
3. 全端口扫描 1-65535（并发 2500、超时 200ms、约 200s）→ **唯一开放端口 `51688`**，
   无明文首包（符合 TLS）。
4. `adb pair 192.168.50.138:37659 120264` → **`Successfully paired`**。
5. 但 `adb connect 192.168.50.138:51688` **一直是 `offline`**；
   `kill-server` / `reconnect offline` / 重扫端口都无效，手机侧始终只有 51688 一个端口。

**卡点判断**：配对成功（信任关系已建立），但连接端口协商不成功。
51688 在配对前后的全端口扫描里都稳定开放，说明它不是配对时随机分配的临时端口。
下一步需要用户在手机「无线调试」页面直接读出 `IP:端口`（那才是当前 connect 端口，
与配对端口不同），或改用 USB 线接入。

---

## 第 8 步：手机软件开发知识库 ✅

用户说「建立手机软件开发的知识库」，之后要「把五篇种子文档真正入库」。

**为什么不走插件工具**：`knowledge` 网关只暴露 base 创建/更新、文档分组、文档状态、note 系列、search/read，
**没有 document_create**。所以入库只能落到存储层。

**关键发现：不需要手搓格式。** 知识库后端不在 `dsh-mnemon`，而在 `@lemoncat7/dsh-knowledge` v2.17.0
（`C:\Users\yaoqi\.dsh\profiles\desktop\node_modules\@lemoncat7\dsh-knowledge\lib\`，ESM）。
直接 import 它自己的 `renderKnowledgeMarkdown` / `markdownHash` / `parseKnowledgeMarkdown` /
`buildPassageStructure` / `contentHash` / `normalizeTags`，渲染、哈希、structure_json 全部由插件代码算，
再用 Node 24 内置 `node:sqlite` 的 `DatabaseSync` 写库 —— 格式与哈希 100% 一致。

之前试 6 种哈希组合全不匹配，是因为漏了两件事：
- `knowledge_entries.content_hash` = `sha256(JSON.stringify({knowledgeBaseId, title 小写, body 小写, type, tags: normalizeTags(tags), scope}))`
- `knowledge_documents.content_hash` = `markdownHash(带 front matter 的完整 markdown)`，不是 `content` 列
- `knowledge_passage_index.body_hash` = 裸 `sha256(body)`

**脚本三件套**（`tools/`，均可复跑，`kb-ingest.mjs` 幂等靠 `ON CONFLICT`）：

| 脚本 | 作用 |
|---|---|
| `kb-ingest.mjs` | 读 `kb/*.md` → 插件函数渲染/哈希/切节 → 一个事务写 5 张表 + 落盘 md。`--dry` 只打印不写 |
| `kb-verify.mjs` | 入库核对：5 表计数、structure_json 过 `validStructure`、磁盘 md 能否被 `parseKnowledgeMarkdown` 解回、FTS 召回试探 |
| `kb-mount.mjs` | 把库挂到 `D:\DeepSeek Harness` 与 `D:\dsh-mobile-app`（`write_mode='audit'`） |

**踩到的坑**：`knowledge_passage_index` 上有个 `knowledge_passage_insert AFTER INSERT ON knowledge_entries`
触发器，插 entry 时自动建了 `state='pending'` 的行，所以后续 `INSERT` 会撞 `UNIQUE constraint failed: entry_id`。
必须改成 `ON CONFLICT(entry_id) DO UPDATE` 覆盖成 `ready`。

**验证证据**：
- `entries=5 documents=5 fts=5`，5 篇全部 `state=ready`、`validStructure=valid`、`totalChars` 与正文长度一致。
- 磁盘 `base-e1b49da1\` 下 5 个 md 全部能被 `parseKnowledgeMarkdown` 解回，title/body 逐字相等。
- UI 实测：知识文档页显示「5 篇已加载」，分组为 测试/调试/构建/键盘/外壳 各 1 篇；
  「知识库与挂载」页显示「知识库 5、项目与会话挂载 3」。
- 本会话 mounted bases 已出现该库，`knowledge_search`「WebView 键盘动画 页面驱动 108ms 批处理」
  一次命中 3 篇，首条正好定位到「原生侧：不给 WebView 设 bottomMargin」那一节。

---

## 下一步

1. **真机验证第 7b 步自愈**：需要有效的 adb 连接（USB 线，或从手机「无线调试」页读出当前 `IP:端口`）。
   验证手法：进 App 后手动把 `dsh_pocket_token` 改成垃圾值，看是否自动恢复进主界面。
2. **第 7 步公网远程连接**：技术阻塞已解除，只差在 dsh-pocket 设置页点「开启公网访问」
   拿到公网 URL + PIN，然后关 WiFi 走 4G 验证。
3. 拿到公网端点后：把它存成第二条连接、验证列表里「局域网 / 公网」两条并存时点击行为正确、
   把 `HandshakeHealGate` 在公网首次握手时的表现量一遍。

命名隧道（固定域名）是第 7 步的可选项，需要 Cloudflare 账号 + 自有域名 + Tunnel Token，
走 `tunnel.setConfig`；它解决的是「地址每次重开都变」这个体验问题，不是可用性问题。

