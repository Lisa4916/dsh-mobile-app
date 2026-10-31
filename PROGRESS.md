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
| 7 | 公网远程连接（隧道） | ⛔ 阻塞 | 待定 TUN 取舍 |
| 8 | 手机软件开发知识库（5 篇种子文档入库 + 挂载） | ✅ | entries/documents/fts = 5/5/5 |

**测试基线：`tests=12 failures=0 errors=0`**（`EndpointTest`）
**APK：`app-debug.apk` 9,710,467 B**（versionName 0.1.0，versionCode 1）

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

## 第 7 步：公网远程连接 ⛔ 阻塞

用户要求「实现远程连接」。`cloudflared.exe` 已缓存在 `C:\Users\yaoqi\.dsh\dsh-pocket\bin\cloudflared.exe`（55,390,512 B），
`dsh-pocket` 的隧道端点也查清了（`tunnel.start` 必须带 `payload.disclaimer=true`）。

**卡住的原因**：本机开着 Clash/mihomo 且启用 sing-tun 入站规则，会掐断 cloudflared 边缘连接（`error 1033`）。
已向用户提出两条路，等决策：
1. 关 TUN 模式后走 cloudflared（免费、无需注册、随机子域）。
2. 换 cpolar（需要注册，有固定子域）。

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

第 7 步仍等 TUN 取舍定下来。知识库已可用，后续本项目开发会走知识优先检索。
