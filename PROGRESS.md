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
| 7 | 公网远程连接（隧道） | ✅ | 真机 4G 走 `https://<random>.trycloudflare.com` 进主界面（第 7e 步） |
| 7a | 连接列表区分「局域网 / 公网 / 本机」落点 | ✅ | `tests=24 failures=0`（EndpointTest） |
| 7b | 「访问验证」页自愈：清失效 `dsh_pocket_token` 后带 token 重连 | ✅ | 全量 `tests=59 failures=0` + 真机抓包实证 |
| 7c | 真机无线调试接入 | ❌ 放弃 | 配对成功但 connect 恒 offline |
| 7d | 真机 USB 接入 + 第 7b 步真机复验 | ✅ | CDP 抓到 `retry+token` 重连并恢复主界面 |
| 7e | 公网隧道开启 + 真机 4G 验证 | ✅ | 4G 下 `title=DeepSeek Harness`；公网下自愈跳同样成立 |
| 8 | 手机软件开发知识库（5 篇种子文档入库 + 挂载） | ✅ | entries/documents/fts = 5/5/5 |
| 9 | 工程加固：截图出库 / PIN 去硬编码 / CI / 集成契约 / 文档纠错 | ✅ | 全量 `tests=69 failures=0`；`git ls-files` 无调试截图 |
| 10 | 拆 `MainActivity`：抽 `RecoveryExecutor` / `CookieNames` / `ConnectionRepository` | ✅ | 全量 `tests=118 failures=0`；真机自愈 3 跳仍成立 |
| 11 | 补 `androidTest`：`PageProbe` 判据拆成纯函数 + 真 WebView 取值验证 | ✅ | 真机 `OK (7 tests)`；`tests=118` |
| 12 | 滑动返回不再闪侧栏（直接点屏外按钮，不展开侧栏） | ✅ | 真机 4 轮 `sideL` 全程 `-217` 不动；`tests=118`；lint 0/27 |
| 13 | 知识库二次强化：纠 4 篇过时/错误结论 + 新增 3 篇 | ✅ | base 内 13 → 16 篇；`passage` 全部 `ready`；`kb-verify` 全绿 |
| 14 | 安全与可见性修复：同域判定 / 状态栏前景 / 文案 / 渲染进程兜底 | ✅ | 全量 `tests=135`；真机四项逐条验证通过（第 14 步） |
| 15 | 全网检索手机开发资料 + 知识库扩到 25 篇 | ✅ | base 内 16 → 25 篇；`passage` 全部 `ready`；`kb-verify` 全绿 |
| 16 | 审计问题的 P0/P1 修复：release 通道打通、权限依赖清理、字号不再重建、删除加确认 | ✅ | release APK 1,976,330 B 签名有效且真机可用；`tests=135`；lint 29→20 |
| 17 | 运行态全量功能回归（14 项主流程 + 3 项自愈/兜底） | ✅ | 全部符合设计；另修 2 处工具缺陷（硬编码序列号、依赖残留手势文件） |
| 18 | 启动时侧栏不再闪：禁掉移动端 frame 侧栏首次就位的 transition | ✅ | 冷启动逐帧采样 `sideL >= -60` 帧数 1 → 0（两轮）；`tests=135`；lint 20 warning |
| 19 | 返回与进入严格互逆：页面拆七层，一次只退一层 | ✅ | 真机 7 种层叠状态全通过（`tools/verify-back-layers.cjs`）；`tests=142`；lint 0/20 |
| 20 | 第二台手机装机与收更新：版本号单一来源 + 局域网分发页 | ✅ | 手机侧 curl 下载 1,930,818 B，SHA-256 与清单一致；`adb install -r Success |
| 21 | GitHub Release 发版：专用签名密钥 + tag 触发构建 | ✅ | Release `v0.2.0` 已发布；`releases/latest/download/dsh-remote-latest.apk` 实测 302→200、1,930,818 B，SHA-256 与 `SHA256SUMS.txt` 一致 |
| 22 | 装完就能连：自动扫局域网找电脑，扫到只差 PIN | ✅ | 254 地址并发扫完 1.86 s 命中本机；真机 `lan discovery done, found=1` 已复现；单测 142 → 176 |
| 23 | 免 PIN 直进主界面：扫描时识别「这台电脑不需要 PIN」 | ✅ | 清数据冷启动 313ms 直接落主界面，无 PIN 屏；单测 176 → 189；Release `v0.4.0` 已发布，固定地址实测 1,930,950 B |
| 24 | 在外面只插流量也能连：抓公网地址 + 连不上立刻回落 + 没 Wi-Fi 不等局域网 | ✅ | 真机只走 4G 冷启动直进主界面；`pocket.status: saved public address …`；单测 189 → 235；Release `v0.5.0` 已发布 |

**测试基线：JVM 单测全量 `tests=235 failures=0 errors=0 skipped=0`**
（`AutoConnectTest` 7 + `AutoFailoverTest` 14 + `BackNavigationDeciderTest` 18 + `BootstrapUrlTest` 10 +
`ConnectWatchdogTest` 15 + `CookieNamesTest` 10 + `EndpointTest` 24 + `HandshakeHealGateTest` 10 +
`HostMatchTest` 17 + `LanAdoptTest` 18 + `LanDiscoveryTest` 29 + `PageProbeTest` 20 +
`PocketStatusTest` 17 + `RecoveryExecutorTest` 12 + `RecoveryPlannerTest` 14）
**真机 instrumented：`PageProbeJsTest` 7 条 `OK (7 tests)`**（Redmi `8PCE7LJB99VG7TRO`，Android 15）
**APK：`app-debug.apk` 7,365,924 B / `app-release.apk` 1,976,330 B**（versionName 0.1.0，versionCode 1）
**lint：0 error / 22 warning**

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
  `token`(8 B) 与 `token-lan`(8 B) 都在，`DEFAULT_LAN_URL` 里的 `token=12345678` 就是 `token-lan`。
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

## 第 7c 步：真机无线调试接入 ❌ 已放弃

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

**放弃理由**：配对成功（信任关系已建立），但连接端口协商不成功；`51688` 在配对前后
稳定开放，不像配对时随机分配的临时端口。改用 USB 后一次成功（见 7d），
**无线调试这条路不再投入**——真要远程调试时再看 Android 15+ 的 `adb pair` 新流程。

---

## 第 7d 步：真机 USB 接入 + 第 7b 步自愈真机复验 ✅

### 设备身份（旧记录是另一台手机）

| 项 | 旧记录（作废） | 实测（有效） |
|---|---|---|
| 型号 | Redmi 23054RA19C（Note 12T Pro） | **motorola XT2335-3**（`penang`） |
| 系统 | Android 15 / SDK 35 | **Android 14 / SDK 34** |
| adb 序列号 | `8PCE7LJB99VG7TRO` | **`ZY22GHMK5F`** |
| WebView | 随系统较新 | **117.0.5938.60**（这就是 `POLYFILL_JS` 的来源） |

USB 接入即 `ZY22GHMK5F  device`，与之前无线配对得到的 `adb-ZY22GHMK5F-xFoQoe` 是同一台。
`install -r` → `Success`，`am start` → 约 8 秒后落在「探索未至之境」主界面。

### 截图踩坑（新增）

`adb exec-out screencap -p > file.png` 在 PowerShell 里会把 PNG 的 LF 改成 CRLF，
产出 217,986 B 的坏图（`read_image` 报 `Unsupported or malformed image data`）。
**必须** `adb shell screencap -p /sdcard/shot.png` 再 `adb pull`。

### 验证方法：为什么必须"同一进程内"

第一版尝试是「CDP 弄脏 cookie → `am force-stop` + `am start` → 看是否恢复」，**结论无效**：
`Network.setCookie` 只保证写进 WebView **活的** cookie store，杀进程后 WebView 从磁盘
Cookies 库恢复，那里还是旧的好值 —— 于是「重启 App」反而把故障抹掉了。

改为同一进程内做：`verify-selfheal-net.cjs` 在一条 CDP 连接里
「弄脏 cookie → `Page.navigate` → 采集 30 秒网络事件」。

### 决定性证据（CDP 抓到的 Document 级请求序列）

```
原始 dsh_pocket_token = bf66ff652862b546…
已弄脏            -> deadbeefdeadbeef…

1. http://192.168.50.58:3081/                                   200
2. http://192.168.50.58:3081/?token=12345678&dsh-pocket-retry=1  200  ← 自愈重连
3. http://192.168.50.58:3081/                                   200

FINAL  title = DeepSeek Harness
       body  = "导出会话日志 探索未至之境 预览版 默认工作区 标准模式 …"
       token = bf66ff652862b546…   ← 被重新下发，不再是死值
```

第 1 跳带着坏 cookie 落到「访问验证」→ `HEAL_PROBE_JS` 判 `'2'`（`PIN_REQUIRED`）→
`RecoveryPlanner` 给出 `CLEAR_POCKET_COOKIE`（因为 URL 里确实有 `?token=`）→
清 `dsh_pocket_token` → 带 `dsh-pocket-retry=1` 重导航 → 第 2 跳拿到新 cookie → 第 3 跳进主界面。

**自愈重连请求出现 = 是 ✅ ；cookie 被重新下发 = 是 ✅**

### 新增工具

| 脚本 | 用途 |
|---|---|
| `tools/simulate-stale-cookie.cjs` | `dump` 列 cookie（含 httpOnly/domain）；`stale` 把 `dsh_pocket_token` 写成 `deadbeef`×8 |
| `tools/verify-selfheal.cjs` | 同一进程内「弄脏 → 导航 → 逐秒采样页面」，给 ✅/❌ |
| `tools/verify-selfheal-net.cjs` | **判定力最强**：抓 `Network.requestWillBeSent`，识别同时带 `dsh-pocket-retry` 与 `token=` 的那一跳。**支持 `<cdpPort>` 参数、cookie domain 从页面 origin 现取**（公网域名也能用） |
| `tools/verify-ask-user.cjs` | 验证反面分支：无 `?token=` 时自愈**必须不动手**（不清 cookie、不重导航、停在验证页） |
| `tools/probe-netstack.cjs` | 探 WebView 当前 title/url/readyState/body；`--navigate <url>` 时先导航再观察 15 秒，统计 Document 请求/响应/失败 |
| `tools/watch-net.cjs` | 持续监听 CDP 网络事件 `<cdpPort> <秒数>`，末尾给「Document 请求总数」，为 0 时标注「loadUrl 被短路」 |
| `tools/tap.cjs` | **真机可靠点击**：`node tap.cjs <x> <y> [serial]`，走 `monkey -f` 绕开 MIUI 对 `input tap` 的注入拒绝 |

---

## 第 7e 步：公网隧道开启 + 真机 4G 验证 ✅

### 隧道怎么开起来的

dsh-pocket 设置页路径：`设置 → 手机访问`，公网区块按钮点「开启公网访问」→ 弹「⚠️ 安全免责声明」→
勾最后一个 checkbox（`cbs[cbs.length-1]`）→ 点「我已知情，同意开启」→ 约 14 秒后出地址。

- 首次点会失败并留文案 `❌ 开启失败：隧道进程退出（code=4294967295）`；
  出处 `dsh-pocket/lib/service.mjs:347`，`code=4294967295` 即 -1（进程被杀）。
  **复位办法**：点 `关闭公网` 让按钮回到「开启公网访问」，再点一次即可。
- `tunnel.start` 服务端强制要求 `payload.disclaimer === true`（`web-rpc.js:371-373`）。
- 快速隧道 spawn 参数写死在 `lib/tunnel.mjs:556`：`--no-autoupdate tunnel --url http://127.0.0.1:<port> --protocol http2`，
  `cloudflaredEnv()` 会剥掉所有代理变量强制直连。

### 本次拿到的地址

| 项 | 值 |
|---|---|
| 公网 URL | `https://<tunnel>.trycloudflare.com` |
| 公网 PIN | `<PUB_PIN>`（= `~/.dsh/dsh-pocket/token`） |
| 本机侧实测 | 未认证 200/4210「访问验证」；`?token=<PUB_PIN>` → 200/499「正在进入」+ 双 Set-Cookie；再 GET / → 200/48062 `DeepSeek Harness` |

**注意：quick tunnel 的域名每次重开都变，`tunnel-auto.json` 只记 `{"at":<ts>}` 不记 URL，
目录里也没有任何文件含 `trycloudflare` 字符串 —— 隧道重开后必须重新从设置页读地址。**

### 真机 4G 验证（第 7 步本体的验收）

流程：`svc wifi disable` 确认只剩 `ccmni*`（4G）→ 把公网端点写进 `shared_prefs/dsh_endpoints.xml` →
`am start` → 25 秒后截图。

- **结果：完整主界面**「探索未至之境 预览版 / 默认工作区 / 标准模式 / 描述你想要构建的内容」，
  状态栏 4G、无 Wi-Fi。证据图见 [docs/evidence/step7-public-4g.png](D:\dsh-mobile-app\docs\evidence\step7-public-4g.png)。
- CDP：`title=DeepSeek Harness`、`url=https://<tunnel>.trycloudflare.com/`。
- 同一台机器上第二台机（motorola XT2335-3 / `ZY22GHMK5F`）在 4G 下**页面黑屏后从 adb 掉线**，未继续追；
  改用 Redmi `8PCE7LJB99VG7TRO` 一次通过。

### 公网下的自愈同样成立

`tools/verify-selfheal-net.cjs` 加了两个参数化（`process.argv[2]` 指定 CDP 端口、
cookie domain 从当前页面 origin 现取，否则换公网域名时 `setCookie` 会因 domain 不匹配失败）后实测：

```
1. https://<host>/
2. https://<host>/?token=<PUB_PIN>&dsh-pocket-retry=1   ← 自愈重连   ← 带 token
3. https://<host>/
FINAL title = DeepSeek Harness
自愈重连请求出现 = 是 ✅ ；cookie 被重新下发 = 是 ✅
```

### ASK_USER 分支实测（新增 `tools/verify-ask-user.cjs`）

把端点写成不带 `?token=` 的地址后，弄脏 `dsh_pocket_token` 再导航：

```
Document 序列：1. https://<host>/          （只有一跳，没有 retry / token）
FINAL title = DSH Pocket · 访问验证
dsh_pocket_token = 仍是脏值（未清）
15 秒内全部请求数 = 3
未触发自愈重连 = 是 ✅ ；停在访问验证页 = 是 ✅ ；未清 cookie = 是 ✅
```

**这条比自愈成功更重要**：没有 token 可重放时，清了 `dsh_pocket_token` 就等于把用户永久锁在验证页外。
单测（`RecoveryPlannerTest.plan_pinPageWithoutTokenAsksUser`）钉住了这个判据，真机这次也证明代码确实按它走。

### 断网 → 恢复 → 点重连：**结论已推翻**（假阴性）

当初记的是「恢复网络后点同一行，前 2 次都是『网页无法打开』，`am force-stop` 后才进得去」，
并怀疑 WebView 错误页把 `loadUrl` 短路了。**这个结论是错的，已作废。**

真因：**MIUI 拒绝了 `adb shell input tap` 的触摸注入**，按钮根本没被点到。
logcat 铁证：
```
W MIUIInput: Input event injection from package: null action ACTION_DOWN
D InputManager: injectMotionEvent: 6369-{action=ACTION_DOWN, ... x[0]=540.0, y[0]=613.0 ...}
W InputManager: Input event injection from pid 6369 failed.
```
`input tap` / `input touchscreen tap` / `input swipe` / `input motionevent` / `sendevent`
全部无效（`sendevent` 还 `Permission denied`），只有 `input keyevent` 有效 ——
所以「adb 能用」这个假象特别容易骗人。之前 CDP 抓到的「Document 请求数 = 0」
就是这么来的：不是导航被短路，是压根没人点它。

改用 `monkey -f` 精确注入（`tools/tap.cjs`）重测，**修复版与未修复版都一样通过**：

| 场景 | 结果 |
|---|---|
| 离线启动 → 恢复网络 → 点同一行 | 一次进主界面。Document 请求 2 次：`?token=<PUB_PIN>` → `/`，`title=DeepSeek Harness` |
| 主界面正常时断网 → 恢复 | 页面一直是主界面，无需任何操作 |
| 离线时连点 3 次（每次都报错）→ 恢复 → 点 | 一次进主界面 |

**保留的改动**：`onPageError()` 里仍会在 `showList()` 之前 `loadUrl(BLANK_PAGE)`，
把 WebView 从 `chrome-error://chromewebdata/` 换成 `about:blank`。这只是状态清理
（避免错误页在下次显示时闪一帧、避免错误页自带的重试按钮与列表状态混淆），
**不是在修某个已验证的导航缺陷** —— 代码注释里也这么写，别再把它当成 bug 修复的功劳。

**教训**：在 Android 上验证「点击有没有生效」之前，先证明注入本身是通的
（点一个必定有可见副作用的控件，或看 logcat 有没有 `injection ... failed`）。
否则所有「点了没反应」都是假阴性。

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

## 第 9 步：工程加固（按软件工程流程补的欠账）✅

起因：做了一次架构与流程审计，暴露出几条「能跑但不像工程」的问题。
下面按审计给出的优先级顺序执行，每条都记了**为什么它是问题**，避免以后有人改回去。

### 9.1 62.7 MB 调试截图移出仓库 ✅

**问题**：`.git` 总大小 66.1 MB，其中 62.7 MB 是仓库根目录的 25 个 `shot-*.png` 加一个 `ui.xml`
（占 95%）。它们是排查过程中随手 `adb pull` 下来的，没有一次是交付证据。

**处理**（文件没删，只是移出仓库范围）：

```powershell
# 1. 移到 build-artifacts/（该目录本来就被 .gitignore 忽略）
$dest = 'D:\dsh-mobile-app\build-artifacts\shots'
Move-Item shot-*.png $dest; Move-Item ui.xml $dest
# 2. 取消跟踪，--cached 保证磁盘文件还在
git rm --cached --quiet shot-*.png ui.xml
```

同时在 `.gitignore` 里加 `shot-*.png` / `shot-*.jpg` / `ui.xml`，并写明「需要长期留存的证据图放
`docs/evidence/`，不要放根目录」。`docs/evidence/step7-public-4g.png`（3 MB）作为第 7 步的唯一证据**保留**。

**注意**：这次只是让后续提交不再包含它们；`.git` 里的历史对象仍然占空间。
要真正瘦身得 `git filter-repo` 重写历史 —— 因为已经推送过，属于破坏性操作，没有擅自做。

### 9.2 局域网 PIN 不再硬编码 ✅

**问题**：`MainActivity.kt` 里 `const val DEFAULT_LAN_URL = "http://192.168.50.58:3081/?token=12345678"`。
`<PIN>` 是 dsh-pocket 的**局域网访问密码**，进公开仓库等于公开它；写死的 IP 还让「换电脑/换网段」直接报废。
同一个 IP 也硬编码在 `network_security_config.xml` 的明文白名单里。

**改法**：构建时注入 + 运行时兜底。

| 层次 | 做法 |
|---|---|
| 取值 | `local.properties`（已 gitignore）的 `dsh.lanUrl` / `dsh.lanPin`；也支持 `-Pdsh.lanUrl=` 覆盖（CI 用） |
| 注入 | `app/build.gradle.kts` 注入 **两个原始字段** `BuildConfig.LAN_HOST` / `LAN_PIN` |
| 拼接 | `BootstrapUrl.build(host, pin)`（纯 JDK，`BootstrapUrlTest` 10 条钉住行为） |
| 兜底 | 任一为空 → `DEFAULT_LAN_URL = ""` → App 直接落到连接列表走「扫码 / 手输」，**不假装有个能用的地址** |
| 早失败 | 填了 `dsh.lanUrl` 却没填 `dsh.lanPin` → **构建直接失败**并说明原因 |

**踩的坑（值得记）**：第一版让 Gradle 自己把 host+pin 拼成完整 URL 注入，结果拼漏了 `?token=`，
注进去的是 `http://192.168.50.58:3081` —— App 连上去只会落到「访问验证」页，而且不报错。
教训：**同一个逻辑不要在两处各写一遍**。现在 Gradle 侧只做「能不能解析」的校验（`validateLanHost`），
拼装唯一归 `BootstrapUrl`，且被单测覆盖。

顺带改的：`network_security_config.xml` 从「只放行 `192.168.50.58` 明文」改成全局允许明文。
理由写进了那个文件：`<domain>` 只接受具体主机名、**不支持 CIDR**，写死一个私网 IP 等于换个网段就
莫名其妙连不上，且失败现场是一条与被访问地址毫无关联的明文/SSL 错误。收紧的正确方向是让 dsh-pocket 走
https，不是在配置里钉一个 IP。

**注意**：`local.properties` 是本机真实值所在处，**不要提交**（`git check-ignore` 已确认被忽略）。

### 9.3 GitHub Actions ✅

`.github/workflows/ci.yml`，三个 job step：`assembleDebug` + `testDebugUnitTest --rerun-tasks` + `lintDebug`。

- `--rerun-tasks` 是刻意的：不上缓存时也能保证测试真的跑过，避免 UP-TO-DATE 假装绿。
- `lintDebug` 先量了基线再决定策略：实测 `0 error / 27 warning`（`UnusedResources` 9、`SetTextI18n` 8、
  `GradleDependency` 3 等），AGP 默认 `abortOnError` 只对 error 生效，所以 **warnings 不挡合并、真 error 立刻挡**。
- 另验了一条容易漏的：把 `local.properties` 改名后重跑 `--rerun-tasks`，`BUILD SUCCESSFUL` 且
  `BuildConfig.LAN_HOST=""`。**CI 上没有真实地址也能过**，这条不验就会在第一次 push 时崩。

### 9.4 写 `INTEGRATION.md` ✅

App 依赖 dsh-pocket 一堆**内部细节**（cookie 名 `dsh_pocket_token` / `dsh-auth-*`、query 参数
`?token=` / `dsh-pocket-retry=1`、页面文案 `访问验证` / `正在进入` / `受访问密码保护`），
这些都不是公开 API，升级时会**静默失效**（不崩、不报错，只是某个自愈功能悄悄不工作）。

`INTEGRATION.md` 把这些逐条列成表（App 侧字面量 ↔ dsh-pocket 侧位置 ↔ 语义 ↔ 坑），
外加**升级后的人工检查清单**（6 条，都能在真机上验，不需要读源码）与遗留风险表。
另外明确写了 App **不**依赖的东西（dsh web 端口、RPC 通道、`settings.json` 结构），免得以后有人误加依赖。

### 9.5 修过期文档 ✅

审计发现「文档比没有更危险」的地方：

| 文件 | 原内容 | 更正 |
|---|---|---|
| `CONTEXT-ANCHOR.md:44` | Gradle 用 `gradle-9.4.1` | **必须 8.9**（9.4.1 与 AGP 8.7.3 不兼容），这条错记录曾让人白折腾一轮 |
| `CONTEXT-ANCHOR.md:102` | 阻塞点「cloudflared 撞 sing-tun」 | **已证伪**：本机无 mihomo/clash 进程、无 TUN 网卡，precheck 全 PASS |
| `CONTEXT-ANCHOR.md:20/65-71` | 明文写 IP 与 PIN、只记一台真机 | 改为构建注入 + 两台真机场景区分；PIN 不再进仓库文档 |
| `README.md:36/91-92` | `tests=12`、APK `9,710,467 B`、`EndpointTest` 12 条 | 现为 `tests=69`、7,469,572 B、24 条；补全 5 个测试类与 5 个纯逻辑类 |
| `README.md` 全文 | 完全没提 `RecoveryPlanner` / `HandshakeHealGate` / `BackNavigationDecider` / `BootstrapUrl` | 新增「自动恢复」整节 + 源码表补全 + 踩坑补 MIUI 触摸注入 / CRLF 毁 PNG / `$pid` 只读 |

`AGENTS.md` 的实测部分一直是准的，未动事实，只补了第 9 步与新的构建参数说明。

**验证**：`assembleDebug :app:testDebugUnitTest --rerun-tasks` → `BUILD SUCCESSFUL in 28s`，
`tests=69 failures=0 errors=0 skipped=0`，APK 7,469,572 B；
编译期仍只有两条既有 deprecated 警告（`ScanActivity.kt:108` / `:113` 的 `setTargetResolution`）。

---

## 第 10 步：拆 `MainActivity` ✅

从 911 行降到 864 行（`healHandshakeIfNeeded()` 从 47 行缩到 4 行，两个 cookie 清理方法合并成一个）。
抽出的四个单元各自有纯 JVM 测试：

| 新文件 | 行 | 职责 | 测试 |
|---|---|---|---|
| `CookieNames.kt` | 39 | `dsh-auth-*` / `dsh_pocket_token` 的**删哪类**判据 + 过期指令 | `CookieNamesTest` 10 |
| `RecoveryExecutor.kt` | 157 | 自愈编排：探针结果 → `RecoveryAction` → 动作（通过 `RecoveryEnvironment` 接口） | `RecoveryExecutorTest` 12 |
| `ConnectionRepository.kt` | 69 | 档案读写接口 + `SharedPrefsConnectionRepository` + `AutoConnect.decide` | `AutoConnectTest` 7 |
| `PageProbe.kt` | 173 | 页面状态判据（纯函数）+ `evaluateJavascript` 返回值还原 | `PageProbeTest` 20 |

### 为什么这么切

`MainActivity` 现在只留**必须有 Android 才能做**的事：造 UI、WebView 生命周期、
`CookieManager` 调用、`Toast`、`evaluateJavascript` 求值。凡是有「判断」的部分都搬出去了：

- `RecoveryEnvironment` 接口把 `navigate` / `notifyUser` / `clear*Cookie` / `log` 抽成注入点，
  于是「清哪个 cookie、清不清、要不要重连」全是可断言的返回值，
  `RecoveryExecutorTest` 里的 `FakeEnv` 直接记录副作用次数。
- `AutoConnect.decide` 返回 `Connect` / `Seed` / `ShowList` 三态，
  「没有内置地址时宁可停在列表也不 loadUrl 空串」这条有测试钉住。
- `CookieNames.selectForRemoval` 是「删哪类 cookie」的唯一判据 —— 以前这段逻辑
  在 Activity 里写了两遍（`clearAuthCookies` 与 `clearPocketCookie`），删错一类就会
  把用户踢回验证页且没有密码可填。

### 编译期踩到的一个真错误

```
e: MainActivity.kt:608:22 Return type of 'log' is not a subtype of the return type of
   the overridden member 'fun log(message: String): Unit'
```

`override fun log(message: String) = android.util.Log.i(...)` —— `Log.i` 返回 `Int`，
表达式体把返回类型推断成 `Int`。改成块体即可。
**教训**：给 Android API 写单行 `override fun ... =` 包装时，要看被调函数的返回类型。

## 第 11 步：补 `androidTest` ✅

### 判据拆成两半，是这一步的核心决定

原来整段判定逻辑是一个 JS 字符串（`HEAL_PROBE_JS` 里 `if (b.indexOf('xx')) return '1'`）。
问题不是「不能测」而是**测错了代价极高却只能靠真机试错**：判错就删用户 cookie。

现在拆成：

| 半边 | 位置 | 谁来验 |
|---|---|---|
| **取值**：`document.title` / `document.body.innerText` 能不能原样取回 Kotlin | `PageProbe.JS_TITLE` / `JS_BODY` + `decodeJsString` | `androidTest/PageProbeJsTest`（真 WebView） |
| **判状态**：拿到 (标题, 正文) 后是 `"0"` / `"1"` / `"2"` | `PageProbe.classify`（纯函数） | `test/PageProbeTest`（20 条 JVM） |

`MainActivity.healHandshakeIfNeeded()` 变成：先求值取标题 → 用 `classify(title, "")` 快判
（标题命中 PIN 页就直接定案，省一次求值）→ 否则再取正文 → `classify(title, body)`。

### 真机上测出来的两个实际问题（都改了测试，不是改产品代码）

1. **`<no result>` 与进程崩溃**：第一版用固定 300ms 延时再求值，真机上还没加载完就求值了，
   回调不来、`CountDownLatch` 超时；反复创建/销毁 `WebView` 还让测试进程崩了。
   改为在 `WebViewClient.onPageFinished` 里求值。
2. **`loadDataWithBaseURL` 加载的文档上 `document.title` 读回空串**（`<title>` 标签不生效）。
   改为用 `evaluateJavascript("document.title = ...")` 设置标题 —— 这恰好也是 DSH 前端
   （SPA）真实产生标题的方式，比塞 `<title>` 更贴近实际。
   **这一条是 instrumented 测试独有的发现**：纯 JVM 侧永远撞不到。

### 真机结果

```
$ adb shell am instrument -w -r -e class com.dsh.remote.PageProbeJsTest \
    com.dsh.remote.test/androidx.test.runner.AndroidJUnitRunner
OK (7 tests)
```

7 条覆盖：中文标题含 `·` 的往返、正文中文往返、空标题还原成空串、
`innerText` 跳过 `display:none`（判据靠这一点区分「页面里藏着的旧告警」与真故障页）、
长正文不丢末尾特征、六种真实页面形态端到端、`about:blank` 不崩。

### 装测试 APK 的坑

`adb install app-debug-androidTest.apk` 报
`INSTALL_FAILED_USER_RESTRICTED: Install canceled by user` —— 需要加 `-t`（允许测试包）：
`adb install -r -t app-debug-androidTest.apk`。

### 拆分后的真机回归

- 启动直接进主界面（截图 `build-artifacts/shots/regress-step6-7.png`，`title=DeepSeek Harness`）。
- 自愈仍成立（`tools/verify-selfheal-net.cjs 9231`）：
  ```
  1. https://<公网域名>/
  2. https://<公网域名>/?token=<PIN>&dsh-pocket-retry=1   ← 自愈重连(retry)   ← 带 token
  3. https://<公网域名>/
  title = DeepSeek Harness ; 自愈重连请求出现 = 是 ✅ ; cookie 被重新下发 = 是 ✅
  ```

---

## 第 12 步：滑动返回不再闪侧栏 ✅

用户报「滑动返回时界面存在问题」。CDP 连拍抓到现场：侧栏整条滑出再收回，用户看到的就是
一条黑边横扫屏幕。

### 根因

`WebViewFactory.DSH_GO_HOME_JS` 的旧实现为了点 `.wtg9ga_newSession`，先去点顶部开关
**把侧栏展开**、等按钮进屏幕、再点它。展开这一步纯属多余。

### 推翻一条旧结论

旧注释写「收起态 `.wtg9ga_newSession` 在屏幕外（`left = -207`），所以 `click()` 无效」——**错的**。
直接 `ns.click()` 就能回首页，因为 DOM 的 `click()` 派发合成事件、**不经过命中测试**，
元素在屏幕外照样收到。当时是用坐标点击验证的，屏外坐标本来就点不到，
把「坐标点不到」误当成「click 无效」。

### 改动

| 项 | 旧 | 新 |
|---|---|---|
| 路径 | 展开侧栏 → 等 → 点 | **直接点屏外按钮**，失败才走旧路径兜底 |
| `DIRECT_MS` | 900 | **2400**（实测用到 1996ms，留 900 会误判成失败转兜底，等于白改） |
| `reachedHome()` 判据 | 首页特征在前 | **先 `tabs = 对话 && 轨迹` 判会话页**，为真直接 false |
| 轮询间隔 | 60ms | 40ms |

第 3 条踩过一次坑：首版把首页判据放前面，会话页 DOM 里同时留着「探索未至之境」（idx 9633）
与「描述你想要构建的内容」（idx 9661），被判成首页 → 函数直接 return → **返回键完全没反应**。

### 验证（真机 Redmi `8PCE7LJB99VG7TRO` / Android 15）

手势滑动返回连测 4 轮，`record-back.cjs` 连拍显示：

```
[ 1] sideL=-217 side=wtg9ga_collapsed … tabs=true  going=true
[ 5] sideL=-217 side=wtg9ga_collapsed … tabs=false going=false   ← 0.4 秒到首页
Document 请求: 无（页面未重载）
```

**`sideL` 全程 `-217` 未动**，侧栏没有滑出。修复前同一工具抓到的是
`-308 → 0 → -216`（滑出再收回）。截图对比：`build-artifacts/back-frames/frame-001.jpg`
（修复前，侧栏覆盖左半屏）vs `frame-005.jpg`（修复后，干净的首页）。

首页再按返回仍正常退出到桌面（`topResumedActivity` 变成 `com.miui.home/.launcher.Launcher`）。

### 回归

`gradle :app:assembleDebug :app:testDebugUnitTest :app:lintDebug --rerun-tasks` →
BUILD SUCCESSFUL in 1m 26s，`tests=118 failures=0 errors=0`，lint `0 error / 27 warning`，
APK 7,485,956 B。

---

## 第 13 步：知识库二次强化 ✅

目标不是「多加几篇」，而是**把被实测推翻的结论改掉、把只可意会的东西写成可执行判据**。过时的知识库比没有更危险：下一个人会照着错结论做出更贵的改动。

### 13.1 为什么必须走 `LocalKnowledgeProvider.update()`

插件 `lib/local-provider.js:900-934` 的 `updateEntry()` 只写 `knowledge_entries` / `knowledge_fts` / `knowledge_versions`，
**不重写磁盘 `.md`、不重建 passage 索引**。直接 `UPDATE` 数据库会让 DB 与磁盘一致性地脱钩，
下次插件启动按 DB 重写磁盘时又把改动覆盖回来，或者检索命中旧 passage。

`provider.update()`（`local-provider.js:782-795`）才是官方路径：事务内改 entries，再 `syncKnowledgeEntryQueued()`
重写 projection markdown（`knowledge_documents` + 磁盘），并让 passage 索引按 `body_hash` 重建。

因此新建了 `tools/kb-update.mjs`：读 `kb/updates/*.md` 的 front-matter（`id` 可选 = 更新/新建），
先离线校验「id 前缀唯一命中」+「`renderKnowledgeMarkdown` → `parseKnowledgeMarkdown` 往返正文一字不差」，
再逐篇走 provider，最后复开只读 DB 核对 `body` 长度、`knowledge_documents.rel_path`、`versions` 条数、`passage.state`。

> 踩坑：首版校验只喂 `"# title\n\nbody"` 给 `parseKnowledgeMarkdown`，报 `missing YAML front matter` ——
> 它是**完整文档**解析器，必须先用 `renderKnowledgeMarkdown` 造出带 front-matter 的完整文档再往返。

### 13.2 纠正的 4 篇（都是被实测推翻的）

| 文档 | 旧结论（错） | 现结论 |
|---|---|---|
| 滑动返回/回主页 `d7618755` | 「侧栏收起时 `left=-199`，click 静默无效，必须先展开侧栏」 | **推翻**：DOM `click()` 不经命中测试，屏外照样生效；真问题是等待上限（实测需 ~1996ms / 54 轮 25ms） |
| 握手自愈闸门 `0cb36dae` | 「自愈永远只清 `dsh-auth-*`，保留 `dsh_pocket_token`」；只有健康/坏两态 | 三态判据（`0`/`1`/`2`）+ **cookie 清理范围对照表**：PIN 页且 URL 有 `?token=` 时必须清 pocket cookie |
| 登录态自愈 `eb3c513a` | 同上，且基线写 `EndpointTest 12 + HandshakeHealGateTest 10 = 22` | 收敛到「端口变了」这一种故障，指向 02 的对照表；基线改为四个类 46 例 |
| 全量回归清单 `1d1c339c` | 第 6 节「已知未解项：`location.reload()` 回主页是体验硬伤」；`33 passed` | 该项**已解除**；基线改为 118 passed + 真机 `OK (7 tests)` + lint 0/27，并新增「仍然靠手工验证的 4 块」 |
| ADB + CDP 调试 `f71d31a1` | 缺 PowerShell 毁 PNG、App 在后台、注入被拒等 | 补 5 条：`exec-out >` CRLF 毁 PNG、`mousedown`/`monkey -f`、`Document` 请求过滤、instrumented 崩渲染进程、`adb install -r -t`、无线调试实测走不通 |

### 13.3 新增的 3 篇

1. **点击注入的三层可信度**（`480e3091`，调试）：DOM click / 坐标点击 / system 级事件 的对照表。
   含 MIUI 拒 `input tap` 的 logcat 原文（退出码仍是 0）、`monkey -f` 模板与 `Events injected` 判据、
   CSS px × (屏幕宽/innerWidth) 换算、`element.focus()` 不唤 IME、**排查顺序 4 步**。
2. **外部依赖的隐式契约**（`50051a9b`，架构）：把「会静默失效的耦合点」写成可检查的文档。
   7 个耦合点四栏表（对方实现位置含行号 / 我方依赖的行为 / 失效症状 / 升级后检查命令）；
   「什么时候该抽接口」的判据是**判错会造成不可逆损害吗**。
3. **页面判据的可测化设计**（`09ca858e`，测试）：把 page probe 拆成「取值」与「判状态」两半。
   `decodeJsString` 的 5 种转义、缺位 `\u` 不能吞字符、正文截断放 classify 里以便单测；
   反面教材是「整段 JS 做 instrumented → `<no result>` + 进程崩溃」。

### 13.4 结果

```
更新  01-home-return.md         d7618755 v2  3112字
更新  02-handshake-gate.md      0cb36dae v2  3707字
更新  03-login-state.md         eb3c513a v2  1578字
更新  04-regression.md          1d1c339c v2  3057字
新建  05-click-injection.md     480e3091 v1  3077字
新建  06-integration-contract.md 50051a9b v1 2152字
新建  07-page-probe.md          09ca858e v1  2542字
更新  08-adb-cdp.md             f71d31a1 v3  6247字
```

- base 内条目 **13 → 16 篇**（新增 3 篇）；全库 entries/documents 均为 32。
- `tools/kb-verify.mjs`：`passage_index` 全部 `ready`，`validStructure=valid`，磁盘 16 个 `.md` 全部可解析；
  `versions` 31 条；FTS 召回正常（`monkey` / `契约` / `页面判据` / `maybeSeedAuthCookie` 都命中预期文档）。
- 全库 `pending/failed` passage = **0**。

> `.knowledge-base.yml` 在 `kb-verify` 里报「解析失败」是**预期行为**：它是 manifest（`renderKnowledgeBaseManifest` 格式），
> 不是知识文档，走的是另一个解析器。不要把它当问题追。

---

## 第 14 步：体检出的四个问题全部修掉 ✅

`adb devices` 上换了一台机器 —— **`ZY22GHMK5F`（motorola XT2335-3 / Android 14 / WebView 117）**，
Redmi `8PCE7LJB99VG7TRO` 不在线。体检（只读）之后按严重度修了前四项，后四项留到下一步。

### 14.1 同域判定被绕过（最严重）

**病灶**：`WebViewFactory.kt:53`

```kotlin
val sameHost = host.endpointHost?.let { url.contains(it, ignoreCase = true) } ?: false
```

`String.contains` 是**子串包含**，不是 host 比对。四种 URL 真机实测：

| URL | 期望 | 修复前 | 修复后 |
|---|---|---|---|
| `https://<host>/page` | 留在 WebView | 留在 WebView ✅ | 留在 WebView ✅ |
| `https://evil.com/?x=<host>` | 交给系统浏览器 | **留在 WebView ❌** | 交给系统浏览器 ✅ |
| `https://<host>.evil.com/steal` | 交给系统浏览器 | **留在 WebView ❌** | 交给系统浏览器 ✅ |
| `https://evil.com/#<host>` | 交给系统浏览器 | **留在 WebView ❌** | 交给系统浏览器 ✅ |

危害不只是「显示了外部页面」：这个 WebView 没有地址栏，外面还挂着 `dshNative` JS 桥，
被钓鱼页套进去之后，页面里的脚本就能调用 `WebViewFactory.JS_BRIDGE_NAME` 暴露的能力。

**修法**：新建 `HostMatch.kt`，把判定抽成纯 JVM 对象（`android.net.Uri` 在单测里是空实现，
所以走 `java.net.URI`）：

- `isSameHost(target, allowedHost)`：规范化后 `host == allow` 或 `host.endsWith(".$allow")`。
  **允许子域**是刻意的 —— quick tunnel 每次重开会换一个 `*.trycloudflare.com` 子域。
  但 `endsWith(".$allow")` 要求点边界，所以 `evilexample.com` **不是** `example.com` 的子域。
- `shouldOpenExternally(target, allowedHost)`：只对 `http://` / `https://` 生效，
  `mailto:` / `tel:` / `about:` 维持旧行为（返回 false），不把系统 scheme 也丢给浏览器。

`HostMatchTest` **17 条**，其中 6 条是**反面用例**（必须判外链）——价值全在这半边：
`external_hostInQueryStringDoesNotCount`、`external_hostInFragmentDoesNotCount`、
`external_hostAsSubdomainSuffixDoesNotCount`、`external_hostAsPathSegmentDoesNotCount`、
`external_lookalikeWithoutDotBoundaryDoesNotCount`、`external_differentHost`。

真机复验（在页面里插一个 `<a href="https://example.com/?x=<当前host>">` 再 `.click()`）：

```
clicked https://example.com/?x=<tunnel>.trycloudflare.com
topResumedActivity=ActivityRecord{… u0 com.zui.browser/com.lenovo.browser.LeMainActivity t1545}
```

→ 真的交给了系统浏览器。修复前同一个 URL 会留在 App 里。

### 14.2 状态栏前景不随页面切换

**病灶**：`themes.xml:8` 的 `android:windowLightStatusBar=true` 是**静态值**，
而窗口是 edge-to-edge（`MainActivity.kt` 里 `WindowCompat.setDecorFitsSystemWindows(window, false)`），
状态栏底下直接就是页面本身。全仓库 `isAppearanceLightStatusBars|SYSTEM_UI_FLAG` = **0 处**。

状态栏区域亮度采样（720×55，BT.601 加权）：

```
修复前 WebView 主界面   p50= 21 p99= 21 max= 21   ← 图标与背景同色，时间电量看不见
修复后 WebView 主界面   p50= 21 p99=255 max=255   ← 图标已转浅色
列表页（白底）           p50=255 p99=255          ← 图标保持深色，没被带反
```

**修法**：`MainActivity.applyBarIconTheme(darkBackground: Boolean)`，内部用
`WindowCompat.getInsetsController(window, window.decorView)` 同时设
`isAppearanceLightStatusBars` 与 `isAppearanceLightNavigationBars`（导航栏同理）。
调用点只有两个：`connect()` 里 `applyBarIconTheme(true)`、`showList()` 里 `applyBarIconTheme(false)`。

### 14.3 文案与事实矛盾

原文案写「扫码即连，凭 PIN 由网页完成认证，**App 不保存任何密钥**」，
但 `run-as com.dsh.remote cat shared_prefs/dsh_endpoints.xml` 里明明白白存着两条带 `?token=` 的地址。

**没有改成「不存 token」**，而是改成说实话。理由：`?token=` 是一次性入口凭据，
`dsh_pocket_token` 的寿命 = dsh web 进程寿命（`INTEGRATION.md` §2.1），
不存地址就得每天电脑重启后重新扫码 —— 那是把可用性换一句漂亮话。

新文案：

```
电脑端：设置 → 手机访问 → 局域网二维码
地址（含访问 PIN）只保存在本机，不会上传；
换电脑或不再使用这台，长按列表项删除
```

`allowBackup=false` + 非 root 读不到，实际风险不高；文字与其相符就够了。

### 14.4 渲染进程没了就整个 App 跟着死

**病灶**：全仓库 `onRenderProcessGone` = 0 处。不覆盖它时，系统的默认兜底是**杀掉宿主进程** ——
用户看到的是「用着用着闪退」。而渲染进程被回收在这台机器上是常态，不是理论风险，
第 7e 步的 logcat 里就抓到过：

```
ProcessSceneCleaner: SwipeUpClean: kill procName=com.google.android.webview:sandboxed_process0:…
```

渲染进程一死，那个 WebView 实例就永久失效：`loadUrl` 不报错也不加载，界面停在最后一帧，
自愈救不了、返回键也脱不了身。唯一出路是换一个新 WebView。

**修法**：
- `WebViewFactory` 的 `WebViewClient` 覆盖 `onRenderProcessGone(view, detail)` → `host.onRenderProcessGone(detail.didCrash())`，**返回 true**（表示「我处理了」，阻止系统杀进程）。
- `MainActivity.onRenderProcessGone(didCrash)`：日志 → `rebuildWebView()` → `current` 为空就 `showList()`，
  否则 `recovery.reset()`（新连接要新预算）+ 显示 WebView + `applyBarIconTheme(true)` + `loadUrl(target.url)`。
- `MainActivity.rebuildWebView()`：旧实例按 `onDestroy` 同一顺序销毁
  （removeView → client 重置 → `webChromeClient=null` → `removeJavascriptInterface` → `stopLoading` →
  `loadUrl("about:blank")` → `removeAllViews` → `destroy`），新实例插在 `progress` **之前**以保持层叠顺序。

**验证方法（这个必须记下来）**：`pkill -9 -f sandboxed_process0` 会得到 `Operation not permitted`，
非 root 杀不掉沙箱进程。唯一可靠触发是 **CDP 的 `Page.crash`** —— 新写了 `tools/crash-page.cjs`：

```
node tools/crash-page.cjs 9250
```

真机结果：

```
崩溃前 pid=23892
发送 Page.crash …（socket 立刻断开，符合预期）
崩溃后 pid=23892                       ← App 进程没被杀，兜底生效
topResumedActivity=… com.dsh.remote/.MainActivity   ← 仍在 App 里
11-02 11:43:45.086 23892 W DshRemote: render process gone (didCrash=true), rebuilding webview
11-02 11:43:46.827 23892 W DshRemote: render process gone (didCrash=true), rebuilding webview
```

截图确认页面已重新加载回主界面（「探索未至之境 / 选择工作区」）。
日志出现**两次**是正常的：`Page.crash` 让渲染进程崩了两次（第一次重建时旧连接还没完全断开）。

### 14.5 结果

```
gradle :app:assembleDebug :app:testDebugUnitTest
BUILD SUCCESSFUL in 17s
tests=135 failures=0 errors=0 skipped=0
（新增 HostMatchTest 17，其余 118 条不变）
APK 7,485,956 B
```

### 14.6 顺带踩到的坑：应用分身里也有同名包

装完新 APK 后启动，弹出「选择要使用的应用程序」，桌面上出现 **3 个同名「DSH 手机遥控」图标**：

```
pm list users  →  UserInfo{0:机主} + UserInfo{900:应用分身} + UserInfo{901:应用分身}
pm list packages --user 900 | grep dsh.remote  →  package:com.dsh.remote
pm list packages --user 901 | grep dsh.remote  →  package:com.dsh.remote
```

`am start` 反复落到 `android/com.android.internal.app.ResolverActivity`。
解决：`pm uninstall --user 900 com.dsh.remote` + `--user 901`（各返回 `Success`），之后正常。

**以后遇到「点图标弹选择器 / 桌面多个同名图标」，先 `pm list users` 查应用分身**，
不要先怀疑 `am start` 的写法。

更省事的做法：**装 APK 时直接只装给主用户** —— `adb shell pm install -r --user 0 <apk>`。
`adb install -r` 默认对**所有用户**安装，所以清完分身再重装一次又会全部回来（这一步踩了第二次）。
判据：`am start` 之后 `topResumedActivity` 直接是 `com.dsh.remote/.MainActivity` 而不是 `ResolverActivity`。

---

## 第 15 步：全网检索 + 知识库扩充到 25 篇 ✅

用户要求「全网检索手机软件开发相关信息，全面提升开发能力」。做法不是收集链接，而是**把检索结论按本项目缺的空白补成可执行的文档**，并全部写进「手机软件开发知识库」。

### 15.1 检索覆盖的 8 个方向

| 方向 | 检索到的关键事实 |
|---|---|
| 平台版本节奏 | Play 自 2025-08-31 要求 `targetSdk ≥ 35`；**2026-08-31 起要 36**，延期申请截止 2026-11-01 |
| Android 16 行为变更 | **edge-to-edge 的 opt-out 被彻底移除**（`windowOptOutEdgeToEdgeEnforcement` 在 target 36 下 deprecated + disabled）；predictive back 默认开启，`onBackPressed()` 不再被调用 |
| WebView 安全 | `shouldOverrideUrlLoading` 必须做 host 白名单比对；`addJavascriptInterface` 从 API 17 起只暴露 `@JavascriptInterface`，但注解只解决「哪些方法可见」，不解决「谁在调用」 |
| 渲染进程 | 官方文档明确：不覆盖 `onRenderProcessGone` 返回 true，系统会杀掉宿主进程 |
| R8 / 发布 | Google 2025-11 官方把「R8 optimizer full mode」列为投入产出比最高的性能改动；AGP 8.12 起有 optimized resource shrinking |
| 测试分层 | Robolectric **不支持 WebView 与系统 UI**，这两类必须走真机/模拟器；Gradle Managed Devices 是自建 CI 的首选 |
| 性能验证 | Baseline Profile 官方量级「首启快约 30%」，Now in Android 实测 229ms vs 324.8ms |
| 架构 | 模块化的出发点是「多人/多特性并行」与「多 App 复用」，单人体量下收益接近零 |

### 15.2 新增 9 篇（`kb/updates/09..17`）

```
09-android-version-cadence.md           c993c4c8 v1 1622字 构建
10-android16-edge-to-edge-predictive-back.md  ff26c2a9 v1 2840字 外壳
11-webview-security-baseline.md         e7fa212d v1 2972字 外壳
12-render-process-gone.md               8692ab03 v1 2492字 外壳
13-test-layering.md                     1ec2da37 v1 2422字 测试
14-r8-and-release.md                    3256d358 v1 2651字 构建
15-architecture-layering.md             d04d8b3b v1 2705字 架构
16-local-secret-storage.md              2f1ca5b0 v1 2277字 架构
17-performance-verification.md          676ec630 v1 2142字 测试
```

每篇都做到了两件事：**引用了外部的日期/数字**（不是凭印象），**落回本项目的实际取舍**（例如明确写了「本项目为什么暂时不做 Baseline Profile」—— 冷启动 820ms 里绝大部分是 WebView + 远程页面首屏，代码执行只占少数，优化 95ms 无体感）。

### 15.3 工具改造：`kb-update.mjs` 加 `--only`

第一次跑发现的问题：`kb/updates/` 里已有 8 篇**已入库**的源文件，直接全量跑会把它们各再升一版（凭空多 8 个版本号）。加了 `--only '<regex>'`：

```
node tools/kb-update.mjs --dry --only '^(09|1[0-7])-'
node tools/kb-update.mjs       --only '^(09|1[0-7])-'
```

**默认不加 `--only` 就等于「全目录重刷」**，这个行为本身是对的（要批量修的时候用得上），但追加新文档时必须限定范围。

### 15.4 结果

```
base 内 16 → 25 篇；全库 entries 44；passage ready 44 / pending 0
kb-verify：25 个 .md 全部「解析OK」，validStructure 全 valid
FTS 召回抽检：
  targetSdk                → 平台版本节奏 + Android 16 迁移面
  onRenderProcessGone      → 渲染进程被回收
  R8 / proguard / MinifyEnabled → R8 与发布配置
  Robolectric              → 测试分层
  allowBackup              → 本地敏感数据的存放边界
  "Baseline Profile"       → 性能验证
  shouldOverrideUrlLoading → WebView 安全基线 + 外壳 + 回归清单
```

`NewApi` 这类只出现在正文小节的词召回 0 条，是 FTS5 分词 + 只索引 title/body 摘要的已知行为，不影响按主题检索。

### 15.5 库备份

改库前用 `VACUUM INTO` 出了快照 `C:\Users\yaoqi\.dsh\knowledge\snapshot-20261102-124433.sqlite`。
**不要用文件复制备份 WAL 模式的 sqlite**，先 `VACUUM INTO` 再复制才安全。

---

## 下一步

1. ~~真机验证第 7b 步自愈~~ ✅ 已完成（第 7d 步，CDP 抓到 `retry+token` 重连）。
2. ~~第 7 步公网远程连接~~ ✅ 已完成（第 7e 步）：隧道开启、真机 4G 进主界面、公网下自愈与 ASK_USER 两支都实测。
3. ~~断网恢复后点重连，首次点击仍会「网页无法打开」~~ ❌ **已推翻，不是 App 的问题**。
   真因是 MIUI 拒绝 `adb shell input tap` 的触摸注入，按钮根本没被点到（见第 7e 步末尾小节）。
   改用 `monkey -f`（`tools/tap.cjs`）重测，修复前后都能一次连上。**不用再查这条。**
4. **隧道重开后地址会变**：`tunnel-auto.json` 不存 URL。可以考虑把「刷新公网地址」做进 App ——
   从 dsh-pocket 的 `pocket.status` / `tunnel.start` RPC 读回当前地址，省掉手动抄。
5. 公网首次握手走的是 **POST 登录路径**（`proxy.mjs:852`），与局域网 `?token=` 不同，
   `HandshakeHealGate` 在这条路径上的表现还没单独量。
6. 真机身份已更正为 `ZY22GHMK5F`（motorola XT2335-3 / Android 14），
   后续验证以这台为准；Redmi 那台的记录只在 `kb/` 与 `CONTEXT-ANCHOR.md` 的历史环境标注里保留。
   > 补充：**公网 4G 验收是在 Redmi `8PCE7LJB99VG7TRO` 上通过的**，XT2335-3 在 4G 下页面黑屏过一次并掉了 adb。
   > 两台都能用，但写结论时要说清是哪台。
7. ~~补 `androidTest`~~ ✅ 已完成（第 11 步）：`PageProbe` 判据拆成纯函数，
   `PageProbeTest` 20 条 JVM + `PageProbeJsTest` 7 条真机。
   **仍缺**：WebView 同域判定（`shouldOverrideUrlLoading`）、cookie 清除→重导航的端到端、
   键盘 insets、扫码 CameraX+ZXing —— 这四块还是靠 `tools/*.cjs` 手跑。
8. ~~拆 `MainActivity`~~ ✅ 已完成（第 10 步）：抽出 `RecoveryExecutor` / `CookieNames` /
   `ConnectionRepository` / `PageProbe`，四个类共 49 条测试。
   **仍有 864 行**：`buildUi()` 约 128 行代码造 UI（无 layout XML），可考虑拆成
   `HomeView` / `WebPanel` 两个自定义 View，但收益不如前四项明显。

命名隧道（固定域名）是第 7 步的可选项，需要 Cloudflare 账号 + 自有域名 + Tunnel Token，
走 `tunnel.setConfig`；它解决的是「地址每次重开都变」这个体验问题，不是可用性问题。


---

## 第 16 步：审计问题按优先级修复（P0/P1）✅

第 15 步的只读审计（时间 2026-11-02）产出了一份按严重度排序的问题清单。这一步按顺序修掉
P0 两条与 P1 四条，P2 里顺手能做的也一起做（lint 与仓库卫生）。

### 16.1 P0-1：`gradlew` 没有可执行位，CI 一定红

```
git ls-tree HEAD gradlew
100644 blob f5feea6...   gradlew        ← 应该是 100755
```

`.github/workflows/ci.yml` 里用的是 `./gradlew --no-daemon ...`，Ubuntu runner 上会直接
`Permission denied`。这个 workflow 建好之后从未在 GitHub 真跑过（本机没有 runner），
所以一直没暴露。

Windows 默认 `core.fileMode=false`，改文件系统属性 git 看不见 —— 必须走索引：

```
git update-index --chmod=+x gradlew
git ls-files -s gradlew      # 100755
```

`git status` 里它表现为「`M gradlew` 但 0 行改动」，这正是 mode 位在变的形态，别以为是噪音。

### 16.2 P0-2：release 通道形同虚设

三件事叠在一起，让「release 构建」这件事看起来存在、实际不可用：

| 现象 | 实测证据 |
|---|---|
| 引用了不存在的规则文件 | `app/build.gradle.kts` 的 `proguardFiles(..., "proguard-rules.pro")`，而该文件不存在。AGP 只打一行 `Supplied proguard configuration does not exist`，**构建照样 SUCCESSFUL** |
| 产物根本不能装 | `app-release-unsigned.apk` 6,007,317 B；`apksigner verify` → `DOES NOT VERIFY / Missing META-INF/MANIFEST.MF` |
| 开关是关的 | `isMinifyEnabled = false`，release 与 debug 除签名外完全一致 |

修法三条一起做：

1. 补 `app/proguard-rules.pro`。里面**只写真正会因为混淆/裁剪坏掉的东西**，并写明
   「不写这条当前也不会坏」的理由（见 16.5）。
2. `isMinifyEnabled = true` + `isShrinkResources = true`。
3. 配签名。此处踩了一个坑：原先的代码在 **SDK 目录**下找 `debug.keystore`，
   报 `SigningConfig "releaseLocal" is missing required property "storeFile"`。
   实测它不在 SDK 里，而在 **`~/.android/debug.keystore`**（`C:\Users\yaoqi\.android\debug.keystore`），
   由 AGP 在第一次 debug 构建时生成。所以改成：先读 `local.properties` 的
   `dsh.releaseStoreFile`（有则用真实发布 key），否则依次找用户目录与 SDK 目录的
   debug keystore，一个都没有就 `logger.warn` 说明补救办法，而不是静默产出一个不能装的包。

结果：

```
app-release.apk  1,976,330 B      （原 7,485,956 B 的 debug 包）
apksigner verify → V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug
```

**关键验证不是「构建过了」，是「R8 之后 App 还能跑」** —— 真机装上 release 包：
进主界面（`topResumedActivity=com.dsh.remote/.MainActivity`）、点输入框拉起键盘时
输入框正确让位到键盘上方（说明 `@JavascriptInterface` 的 JS 桥在 R8 之后仍然可用）。

### 16.3 P1：四个「不致命但会咬人」的问题

1. **零使用的权限与依赖**
   `POST_NOTIFICATIONS` / `ACCESS_NETWORK_STATE` 代码引用各 0 处（原本计划做通知与断网提示，
   最终靠 `onReceivedError` 就够了）；`androidx.constraintlayout` 的 `ConstraintLayout` 出现 0 处
   （UI 全是代码构造的 `LinearLayout`）。全部删除。
   留着的代价不是安全，是**误导读代码的人**：看到权限就以为有对应功能。

2. **改字号会 relaunch**
   `configChanges` 缺 `fontScale|uiMode`。实测 `settings put system font_scale 1.3` →
   logcat `WindowManager: finishDrawing of relaunch: Window{... com.dsh.remote/.MainActivity} 290ms`，
   页面重新加载回 `HARNESS / Loading plugins…`，DSH 那边正在跑的会话界面全丢状态。
   补进 `configChanges` 并实现 `onConfigurationChanged`：只重建连接列表视图与状态栏前景，
   **不动 WebView**（强刷正是要避免的那件事）。
   验证：`font_scale` 1.15 → 1.3 → 1.15 两轮，pid 与外层 ActivityRecord 都不变。

3. **`postDelayed` 的 Runnable 无法取消**
   `onPageFinished` 里排的那个「健康复查」活 1.4 秒，原来连引用都没存，全文件 `removeCallbacks` 0 处。
   现在存 `healthRecheck`，并在三处取消：`onPageFinished` 重排前、`connect()` 换地址时、`onDestroy()`。
   `isFinishing` 只是兜底判断，不是取消 —— 真到回调执行那一刻 WebView 可能已经 destroy，
   `evaluateJavascript` 会静默失败，那一轮闸门就永远卡在「还在同一轮故障里」，后续自愈全被节流挡掉。

4. **长按删除无确认**
   删的是一条**带 token 的连接地址**，删了要回电脑重新扫码。改走 `confirmDelete()` +
   `AlertDialog`（标题「删除这条连接？」+ 地址 + 后果说明）。用对话框而不是 Toast 撤销，
   因为删除是同步写 SharedPreferences，撤销要维护排队状态，不值得。

### 16.4 P2：lint 与仓库卫生

- `colors.xml` 原来 10 个颜色里 **7 个零引用**（UI 颜色取的是 Kotlin 常量），删到只剩
  XML 真正引用的 `page_dark` / `brand` / `brand_dim`；`strings.xml` 删 `retry` / `saved`。
  **lint 29 → 20 warning，`UnusedResources` 9 → 0。**
- `MainActivity` 里裸的 `0xFFB26B00` 提成 `WARN` 常量（它与 `@color/warn` 的 `#B45309`
  语义相同、色值不同，两份定义并存最容易改一处漏一处；现在只剩一处）。
- 删 `tools/` 下 12 个 `_` 前缀一次性探针（`_probe*.py`、`_prof*.py`、`_px.py`、`_tabs.cjs` 等）。
- `git gc --aggressive --prune=now`：382 loose objects / 66.55 MiB → **1 pack / 65.95 MiB**。
  注意 `.git` 仍然是 66 MB 量级 —— 最大的 blob 是历史里的 6 张 3 MB 截图，
  gc 只能压紧不能变小；真要瘦身得 `git filter-repo`（已推送，破坏性，未做）。
- 文档回填：`README.md` 与 `AGENTS.md` 里写的 lint 基线是 27，实测 29（第 14 步新增
  `NewApi` 与 `LockedOrientationActivity` 后没回填）。现在统一为 20。

### 16.5 被这次实测推翻的一条知识库结论

`kb/updates/14-r8-and-release.md` 原文写「`@JavascriptInterface` 的方法必须手动 keep，
R8 不知道这层关系，会把 `keyboardHeight` 改成 `a`」。打开 minify 后的
`app/build/outputs/mapping/release/mapping.txt`：

```
com.dsh.remote.WebBridge -> K0.x:                       ← 类名被混淆
    1:2:boolean isNativeShell():27:27 -> isNativeShell    ← 方法名保留
    1:5:float keyboardHeight():23 -> keyboardHeight       ← 方法名保留
```

类名被改、**方法名原样保留** —— AGP 内置规则
`-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }` 已经在起作用。
所以正确结论是「**当前不写也不会坏**」，但仍显式写：内置规则是 AGP 的实现细节不该外包，
且显式写能让读代码的人知道「桥依赖方法名」这个事实。

把「必须手动 keep」当成事实写进文档的坏处是双重的：让人以为修了一个不存在的 bug，
同时**掩盖真正需要 keep 的东西**（反射、序列化字段名这类 R8 真的看不到的）。
判据永远是 `mapping.txt`，不是记忆。

已用 `tools/kb-update.mjs --only '^14-'` 把该篇更新到 v2（3338 字），
`kb-verify` 全绿。改库前 `VACUUM INTO` 出快照 `snapshot-20261102-1330.sqlite`。

### 16.6 结果

```
tests=135 failures=0 errors=0        （10 个测试类）
lint  0 error / 20 warning           （原 29）
debug   APK 7,296,484 B
release APK 1,976,330 B  签名有效、真机可用
真机：release 进主界面 / 键盘避让正确 / 长按弹确认框 / 改字号不 relaunch / 断网回落列表页
```

提交 `6672510`。**仍未处理**（留给下一步）：CI 从未在 GitHub 真跑过；
`.git` 66 MB 里的历史截图未清；`MainActivity` 仍有约 1000 行；
`SetTextI18n` 那 10 条要靠「把文案收敛进 strings.xml」这类独立改造。

---

## 第 17 步：运行态全量功能回归（16 项）✅ / 2 个工具缺陷已修

设备 **motorola XT2335-3 `ZY22GHMK5F`**（Android 14 / SDK 34 / WebView 117.0.5938.60）。
本轮只做「跑起来逐项验」，代码除工具脚本外未改。所有截图在 `build-artifacts/reg-*.png`。

### 17.1 基线

```
gradle :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest :app:lintDebug --rerun-tasks
BUILD SUCCESSFUL in 1m 42s
tests=135 failures=0 errors=0   （10 个测试类）
lint  0 error / 20 warning
```

### 17.2 正常项（14 项）

| # | 功能 | 实测结果 |
|---|---|---|
| 1 | 冷启动 | `am start -W` → `TotalTime: 798ms`；约 8–14 s 出主界面 |
| 2 | 自动连接 | 启动直接落在 `https://<tunnel>/`，`title=DeepSeek Harness`，hero + composer 都在 |
| 3 | 点已保存连接 | 点第一行 → 进 WebView 主界面，`readyState=complete` |
| 4 | 返回：会话 → 首页 | 0.75 s 内 `tabs=true→false`、`hero=false→true`，`goingHome` 只亮一次 |
| 5 | 返回：首页 → 退出 | `topResumedActivity` 变 `com.motorola.launcher3/...`，进程存活 |
| 6 | 快速连按返回 3 次 | 无崩溃、无 FATAL、pid 不变，正常退到桌面 |
| 7 | 断网启动 | 真实飞行模式下 `main frame error -2: net::ERR_NAME_NOT_RESOLVED` → **回落列表页**，列表与文案完整 |
| 8 | 手动连接：空地址 | Toast「地址要以 http:// 或 https:// 开头」，列表未变 |
| 9 | 手动连接：非法地址（`back at`） | 同上；输入内容保留，不误建档案 |
| 10 | 填入本机示例 | EditText 被填成 `http://192.168.50.58:3081/?token=…` |
| 11 | 长按删除 | 弹「删除这条连接？/ 公网隧道 / <完整地址> / 删除后需要重新扫码或手输地址才能连回来。/ 取消 删除」；点取消正常关闭且列表不变 |
| 12 | 扫码页 | 拒权限 → Toast「没有相机权限，可以手动输入地址」；允许 → `ScanActivity` 起 CameraX（日志 `SyncCaptureSessionImpl ... onConfigured`）；点取消回列表、pid 不变 |
| 13 | 键盘避让 | 真实点击输入框 → `mInputShown=true`，页面 `#root` 高度 **772px → 502px**（键盘 270px），输入框被顶到键盘上方 |
| 14 | 状态栏前景 | WebView 主界面顶部条带 `p50=21 p99=255 max=255`（浅色图标）；列表页 `min=102 p50=255`（深色图标）——两边都对 |

自愈与兜底单列：

| # | 功能 | 实测结果 |
|---|---|---|
| 15 | 自愈正向 | 弄脏 `dsh_pocket_token` → 三跳 `/` → `/?token=…&dsh-pocket-retry=1` → `/`，`title=DeepSeek Harness`，cookie 被重下发 `73a8dddd…` |
| 16 | 自愈 ASK_USER 反向 | 端点去掉 `?token=` 后：Document 只有 1 跳、停在「DSH Pocket · 访问验证」、`dsh_pocket_token` **仍是脏值（未清）** —— 三项全 ✅ |
| 17 | 渲染进程崩溃 | CDP `Page.crash` → logcat `render process gone (didCrash=true), rebuilding webview` 两次；**pid 31491 不变**，12 s 后页面自己回到主界面 |

其他：`/data/tombstones` 与 `/data/anr` 均为 0；dropbox 无本包记录；内存 Java Heap 8,984 KB / Native 10,372 KB。

### 17.3 异常项：两个工具缺陷（已修，非产品问题）

这两条都不是 App 的 bug，但都会让人把「工具跑错」误判成「App 坏了」，所以按异常项记录。

**A. 六个脚本把设备序列号写死成旧机器**
复现：`node tools/record-back.cjs 9222` → `adb.exe: device '8PCE7LJB99VG7TRO' not found`。
`cdp-forward.cjs`、`record-back.cjs`、`probe-back-nav.cjs`、`measure-smooth.cjs`、`verify-collapse.cjs` 全部受影响。
修复：新增 `tools/device.cjs`，解析顺序「显式参数 > `DEV_SERIAL` > `adb devices` 里唯一一台」；
零台或多台且没指定就报错退出，**不猜**。

**B. `record-back.cjs` 依赖设备上预先存在的 `/data/local/tmp/swipe.txt`**
那个文件是上一台机器留下的，新机器上没有 → `monkey` 报错，看着像「手势不生效」。
修复：现场用 base64 生成手势脚本再喂给 `monkey`，不再依赖残留文件。

**C. 顺带修掉一个验证陷阱**
`verify-ask-user.cjs` 只对「端点不带 `?token=`」的场景有判定力。第一次跑时端点还带 token，
自愈走了 `CLEAR_POCKET_COOKIE` 并成功恢复，三项全判❌ —— 那是**假阴性**。
现改为直接读 `dsh_endpoints.xml` 判断，端点全带 token 就 `exit 2` 并说明原因。

### 17.4 整体结论

**功能层面没有发现新的产品缺陷**：14 项主流程 + 3 项自愈/兜底全部符合设计。
第 14、16 步修的四项（同域判定、状态栏、文案、渲染进程兜底）在运行态复验中仍然成立。

**仍需注意的一点**：`adb install -r` 默认对所有用户安装，本机有 `应用分身`（user 900/901），
装完会变成 3 个同名图标且 `am start` 落到 `ResolverActivity`。
本轮先 `pm uninstall --user 900/901` 才继续，之后 `pm list packages --user 900/901` 确认干净。
装包一律建议 `adb shell pm install -r --user 0 <apk>`。

**建议（按性价比排序）**：
1. `tools/` 里剩下几个仍靠人工点坐标的脚本（如长按用 `UserWait` 拼 monkey 脚本），
   可以像 `device.cjs` 一样收口成一个 `longpress.cjs`，避免每次手写 `DispatchPointer`。
2. 键盘避让、扫码 CameraX、同域判定这三块仍然只能手跑（JVM 单测覆盖不到），
   可以考虑用 Gradle Managed Devices 把它们做成 instrumented 用例 —— 但需要先接受一条
   "每个用例起一台模拟器" 的时间成本。
3. 飞行模式开关在 `cmd connectivity airplane-mode disable` 之后偶尔仍显示 `airplane_mode_on=1`，
   本轮就撞到一次（以为网络没恢复，实际是开关没生效）。脚本化时应把
   `ping` 结果作为判据，而不是命令退出码。

---

## 第 18 步：启动时侧栏不再闪 ✅

用户反馈：「启动时侧面栏闪动一下」。这一条**不是我们代码引起的**，是被页面自己的 CSS 过渡放大出来的。

### 18.1 先把它变成可观测的量

没有测量手段就只能靠肉眼猜。`tools/record-back.cjs` 只能测「已连上 CDP 后触发返回」，
而这个问题发生在 **CDP 连上之前**（WebView 刚创建、文档还没解析完）。

新写 `tools/probe-startup.cjs`：`am force-stop` → `am start` → **边等边连 CDP**
（从 `/proc/net/unix` 正则 `@?webview_devtools_remote_[0-9]+` 取 socket，去掉 `@`）
→ 连上后按 40ms 一帧求值一整个 `SAMPLE_JS`。一次求值拿全部量（`t/tabs/hero/len/sideL/sideCls`），
避免多次往返把帧间隔吃掉。

判据：`sideL >= -60` 的帧数 > 0 且 `sideL < -60` 的帧数 > 0 → 判「闪」。

第一版两个坑：
- socket 名匹配用了 `split('\n').map(match)`，`webview_devtools_remote` 前面有 `@` 取不到 → 报「20 秒内没连上 CDP」；
  改整段正则 + 打 `lastErr` 才定位到。
- 采样完不 `process.exit(0)`，WebSocket 长连接让 Node 永不退出，看起来像「脚本卡死」→ 加了 `ws.socket.destroy()` + 显式退出。

### 18.2 三次测量，把根因钉死

`probe-startup.cjs`（修复前）：
```
[  3422ms] sideL=0    cls=mP3x-q_sidebarCol tabs=false hero=true len=33   ← 侧栏整个露在屏幕里
[  3546ms] sideL=-191
[  3657ms] sideL=-209
侧栏闪动 = 是 ❌（sideL >= -60 的帧数 = 1）
```

`tools/probe-frame-attrs.cjs`（document-start 装 MutationObserver，看首帧属性）：
```
[  2516ms] first-seen            collapsed=true colRectL=0    tr=matrix(1,0,0,1,0,0)
[  2945ms] attr:data-mobile-nav-explorer collapsed=true colRectL=-209 tr=matrix(1,0,0,1,-208.337,0)
```
**首帧 `data-sidebar-collapsed` 就已经是 `true`，但 `transform` 还是 0。**
→ 矛盾点在这里：DOM 属性先到，样式后到。

`tools/probe-sidebar-anim.cjs`（逐帧 + `getAnimations()`）：
```
[  3139ms] left=0    anims=[transform:running]
[  3255ms] transitionrun prop=transform target=mP3x-q_sidebarCol
[  3260ms] left=-13  … 一条 0.28s cubic-bezier(0.4,0,0.2,1) 的过渡
[  3463ms] left=-209  anims=[]
```
**结论：是一次真正的 CSS transition，不是页面 JS 慢一步直接跳。**

### 18.3 为什么不能改 `DSH_GO_HOME_JS`

`MainActivity.kt` 里只有**按返回键**才调它（`installBackHandling()`），启动路径根本不调。
而且它入口有 `if (reachedHome()) { … return; }` 保护。去改它只会把返回键弄坏，
对启动闪动一点作用都没有 —— 这条差点被当成「顺手一起修」的错方向。

### 18.4 修法

在 `WebViewFactory.kt` 加 `NO_SIDEBAR_FLASH_JS`，走 **document-start** 注入（和 `POLYFILL_JS` 同一条链）：

```css
[data-mobile-nav="frame"] [class*="_sidebarCol"],
[data-mobile-nav="frame"] [class*="_rightbarCol"] {
  transition: none !important;
  animation: none !important;
}
```

三条设计约束：
1. **只禁 transition，不写死 transform** —— 位置该由页面决定，我们只让它「不带动画地就位」。
   以后页面改侧栏宽度、用户手动展开，行为都不受影响。
2. **选择器用 `[class*="_sidebarCol"]` 而不是完整类名** —— 实测类名是 `mP3x-q_sidebarCol`，
   前缀随 DSH 构建变化，后缀是稳定的语义命名。
3. **必须 document-start** —— 实测过渡 3139ms 起、3463ms 结束，晚一步就完全错过。

### 18.5 验证

`tools/verify-no-sidebar-flash.cjs`（先注入样式再 reload，看侧栏还会不会进屏）：
```
[  2092ms] sideL=-209 hero=true  css=ok|true     ← 一出现就是收起态
sideL >= -60 的帧数 = 0 ；侧栏闪动 = 否 ✅
```
（这一版也踩了个坑：首版 `(document.head || document.documentElement).appendChild` 在 document-start
时两者都是 null 直接抛错，后面的监听器没注册上 → `css=false`，测出来是「没注入」而不是「注入了没用」。
改成 `head || documentElement || getElementsByTagName('html')[0]` 三级回落 + `setInterval` 重试。）

装新包后 `probe-startup.cjs` 连跑两轮：
```
第 1 轮：sideL >= -60 帧数 = 0，sideL < -60 帧数 = 169 → 否 ✅
第 2 轮：sideL >= -60 帧数 = 0，sideL < -60 帧数 = 136 → 否 ✅
[  3347ms] sideL=-209 cls=mP3x-q_sidebarCol hero=true   ← 一出现即 -209，中间没有任何帧
```

### 18.6 回归（确认没把别的弄坏）

| 项 | 结果 |
|---|---|
| 侧栏手动展开 | `probe-sessions.cjs 9222 open` → `sidebar {"l":0,"w":280}`，会话条目完整列出 9 条 |
| 进入会话页 | 点第 4 条会话 → `title=网络管理器代理模式优化 — DeepSeek Harness`，`tabs=true` |
| 会话页按返回 | 返回键回首页 → `{"sideL":-209,"hero":true,"tabs":false}`，`Document 请求: 无（页面未重载）` |
| 首页按返回 | 退到桌面 |
| 单测 | **135 / 0 failures**（10 个类，与第 17 步一致） |
| lint | 20 条 warning / **0 error**（与第 16 步一致，无新增） |

### 18.7 装的坑（第二次撞）

装完 APK `am start` 又落到 `ResolverActivity` —— `pm list users` 仍显示 900/901 两个应用分身。
`adb install -r` 默认对**所有用户**安装，清完分身再装一次就全回来。
本轮又 `pm uninstall --user 900/901` 一次。**根治办法是装包时就用 `adb shell pm install -r --user 0 <apk>`**（已写进 AGENTS §6.24）。

### 18.8 新增工具

| 脚本 | 用途 |
|---|---|
| `tools/probe-startup.cjs` | 冷启动逐帧采样侧栏位置，判「启动时闪不闪」 |
| `tools/probe-frame-attrs.cjs` | document-start 装观察器，抓首帧 `data-sidebar-collapsed` 与侧栏几何 |
| `tools/probe-sidebar-anim.cjs` | 逐帧记 `getAnimations()` + `transitionrun` 事件，区分「CSS 过渡」与「JS 直接跳」 |
| `tools/verify-no-sidebar-flash.cjs` | 注入去过渡样式后复测，验证修法有效 |
---

## 第 19 步：返回与进入严格互逆 ✅

用户要求：`滑动返回，要求与进入的步骤相反，不能缺少步骤也不能多`；`无论进入哪个功能项都应如此`。

### 19.1 旧版为什么「多退」

旧 `BackNavigationDecider` 只认三档：`session` / `home` / `other`。于是：

| 现状 | 按一次返回 | 问题 |
|---|---|---|
| 首页 + 侧栏展开 | **直接退出 App**（实测 `topResumedActivity` 变成 launcher） | 少退一层抽屉，直接跳到最外层 |
| 首页 + 弹出菜单 | 直接退出 App | 同上 |
| 会话知识库面板开着 | 面板不动，页面被当成 `session` 拉回首页 | 多退一层 |
| 插件 / Purge 等功能视图 | 直接回首页 | 少退一层 |

### 19.2 先把「有几层」量清楚

新建四个探测器（`tools/probe-*.cjs`），真机逐个场景构造后采样：

| 场景 | 进入后最上面一层 | Escape 能否退掉 |
|---|---|---|
| 首页 + 弹出菜单 | `overlay`（`[role=menu]/[role=listbox]/[role=dialog]`） | ✅ |
| 首页 + 侧栏展开 | `sidebar`（`[class*="_sidebarCol"]` 的 `left` 从 -209 变 0） | ✅ |
| 会话知识库面板 | `panel`（可见的「关闭xxx」按钮） | ❌ 完全无反应 |
| 插件等功能视图 | `feature`（`[aria-current]` / `[aria-selected=true]` 点亮入口名） | ❌（视图不动） |
| 会话页 | `session`（`对话` + `轨迹` 这对 tab） | ❌ |
| 首页 | `home`（`探索未至之境` 等） | — |

**判据顺序是硬约束**：`panel → overlay → sidebar → session → feature → home`。
其中 `session` 必须排在 `feature` 前面 —— 会话页也有 `aria-selected="true"`（「对话」那个 tab），先判 feature 会把会话页误认成功能视图（首轮就判错过一次，见 `tools/probe-layer.cjs` 的历史）。

### 19.3 改动

`D:\dsh-mobile-app\app\src\main\java\com\dsh\remote\BackNavigationDecider.kt`
- `PageLocation` 由 3 档扩到 7 档（`PANEL/OVERLAY/SIDEBAR/FEATURE/SESSION/HOME/OTHER`），注释里写明「顺序即层级」。
- `Action` 由 3 个扩到 7 个（`CLOSE_PANEL/DISMISS_OVERLAY/COLLAPSE_SIDEBAR/LEAVE_FEATURE/GO_TO_START/EXIT_APP/RECOVER_TO_START`）。
- `decide()` 改成**一次只退一层**：只有 `HOME` 才 `EXIT_APP`，其余层各自对应一个「只退这一层」的动作。

`D:\dsh-mobile-app\app\src\main\java\com\dsh\remote\WebViewFactory.kt`
- `DSH_LOCATION_JS` 重写：加 `visible(el)`（`display/visibility/opacity/尺寸` 四判），按上面顺序 return。
- 新增 `DSH_PRESS_ESCAPE_JS`（发 `keydown`+`keyup` 的 `Escape`，`keyCode 27`，`bubbles:true`）。
- 新增 `DSH_CLOSE_PANEL_JS`（点第一个可见的「关闭xxx」按钮）。
- **`DSH_GO_HOME_JS` 一行没动** —— 第 18 步的结论是「屏外元素 `click()` 照样生效」，所以侧栏已经收起时它照样能用。

`D:\dsh-mobile-app\app\src\main\java\com\dsh\remote\MainActivity.kt`
- `installBackHandling()` 里加日志 `back: layer=… action=…`（排查返回问题时靠它，省一轮猜）。
- 四个新分支各自只做一件事，谁都不许顺手把页面拉回首页。

### 19.4 真机验证（`tools/verify-back-layers.cjs`，7/7 通过）

```
=== 首页 + 弹出菜单 ===      overlay → home        ✅ 只退了一层
=== 首页 + 侧栏展开 ===      sidebar → home        ✅
=== 功能视图（插件）===       feature → home        ✅
=== 功能视图 + 侧栏展开 ===   sidebar → feature     ✅（只收抽屉，视图不动）
=== 会话页 ===               session → home        ✅
=== 会话页 + 侧栏展开 ===     sidebar → session     ✅
=== 会话页 + 知识库面板 ===   panel   → session     ✅
合计：7 项，失败 0 项
```

首页按返回仍退到桌面，日志 `back: layer=HOME action=EXIT_APP`。

### 19.5 这个验证脚本自己踩过的四个坑（都已修，别再犯）

1. **CDP 转发要随 pid 重建**：`am force-stop` 后 pid 变，`webview_devtools_remote_<pid>` 跟着变，不重建时每条求值吃满 8 秒超时，外面看就是脚本卡死。
2. **判「App 在不在前台」只能读 `topResumedActivity` 那一行**：`dumpsys activity activities` 整段里留着历史 `ActivityRecord`，用整段 `indexOf` 会把「已退到桌面」当成「还在前台」，然后拿一个后台被冻结的 WebView 反复求值、永远等不到 `home`。
3. **构造没成功不许判产品对错**：上一版把「点插件没点上」记成了产品缺陷。现在每个构造步骤后都断言期望层已出现，失败就打印「构造失败，跳过」。
4. **功能页入口不在侧栏上**，在侧栏「更多」菜单里。侧栏 `aria-label` 实测只有：`打开侧边栏 / 新建会话 / 更多 / 搜索会话 / 展开会话知识库 / 导出会话日志 / 账号菜单`；`插件 / 自动化任务 / XD Pool / Purge` 全在「更多」里面。

### 19.6 回归

| 项 | 结果 |
|---|---|
| 单测 | **142 / 0 failures**（`BackNavigationDeciderTest` 11 → 18 条，新增 6 条逐层断言 + 1 条「层内不越级」） |
| lint | 0 error / 20 warning（与第 16 步一致，无新增） |
| APK | `app-debug.apk` 7,296,484 B |
| 首页按返回 | 退到桌面，`back: layer=HOME action=EXIT_APP` |
| 侧栏手动展开 / 会话页 | 未被改坏（7/7 用例里含这两项） |

---

## 第 20 步：第二台手机装机与收更新 ✅

用户问题：「如何让我的另一部安装了此软件的手机，接到软件更新」。

### 20.1 先查前提：能不能走正规渠道

| 检查 | 实测结果 | 结论 |
|---|---|---|
| `git remote -v` | 空 | 没有远端仓库，GitHub Releases / 自建 update server 都无从谈起 |
| debug 与 release 签名 | 两个包的 `apksigner verify --print-certs` 都是 `CN=Android Debug`、`SHA-256 ca77c1d1…` | **能互相覆盖安装**，这是不重装的前提 |
| keystore | `C:\Users\yaoqi\.android\debug.keystore`（2618 B），`releaseLocal` 用的就是它 | 同一张证书，可覆盖 |
| 版本号来源 | 写死在 `app/build.gradle.kts`（`versionCode = 1`） | 每次发版都得手改源码，且忘了就装不上 |

### 20.2 三个改动

**a) 版本号单一来源** —— 新建仓库根 `version.properties`：

```
versionCode=2
versionName=0.2.0
```

`app/build.gradle.kts` 里读它，`-Pdsh.versionCode=` 可临时覆盖（CI 用）。

> **踩过的坑：不能用 `git rev-list --count HEAD` 当 versionCode。**
> CI 是浅克隆（`actions/checkout` 默认 `fetch-depth: 1`），算出来永远是 1，
> 打出的包比手机上装的还旧，Android 直接拒装，而用户只会看到「应用未安装」。

**b) `tools/publish-apk.cjs`** —— 构建 release 并发布到 `dist/`：
`dsh-remote-<ver>-<code>.apk`（稳定名，便于肉眼区分）＋ `dsh-remote-latest.apk`（固定名）
＋ `latest.json`（版本 / 大小 / SHA-256 / 构建时间）＋ `index.html`（自包含下载页，内联 CSS）。
`--bump patch|minor|major` 先把 `version.properties` 加一档再构建。

> 默认走 **release** 而不是 debug：debug 7.3 MB、带 `debuggable`、开着 WebView 调试；
> release 1.8 MB、R8 过一遍。日常用 release，只有抓 CDP 时才临时换 debug。
>
> 脚本实现坑：`execFileSync(GRADLE, args)` 对 `.bat` 报 `spawnSync … ENOENT`，
> 必须 `shell: true` 并把参数拼成一行。

**c) `tools/serve-apk.cjs`** —— 把 `dist/` 起成局域网下载页（默认 `0.0.0.0:8123`）：
只读、支持 `Range`（手机断点续传）、防目录穿越、`Cache-Control: no-store`，
`/version.json` 与 `/latest.json` 都返回清单，启动时打印本机局域网 IPv4（跳过 `169.254.*`）。

`dist/` 已写进 `.gitignore`（里面是二进制产物与清单，版本号本身记在 `version.properties`）。

### 20.3 实测验证

| 项 | 结果 |
|---|---|
| `node tools/publish-apk.cjs` | `dist/dsh-remote-0.2.0-2.apk` **1,930,818 B**，SHA-256 `42db6a9b…ac2048f` |
| `aapt2 dump badging` | `versionCode='2' versionName='0.2.0'`、`minSdk 24`、`targetSdk 35` |
| `adb -s ZY22GHMK5F install -r dist\…apk` | `Success`（覆盖安装可用，连接列表不丢） |
| 分发页 | `GET /` → `200 1831B`；`GET /version.json` → 清单 JSON |
| **手机侧真实下载** | `curl` 拉 `http://192.168.50.58:8123/dsh-remote-latest.apk` → **1,930,818 B**，`sha256sum` 与清单**逐字节一致** |

> 手机上没有 `wget`（`toybox: Unknown command wget`），验连通性用 `curl`。

### 20.4 用户侧操作（已写进 README）

```powershell
# 第一次
node tools\publish-apk.cjs
node tools\serve-apk.cjs          # 打印 http://<本机IP>:8123/

# 之后每次更新
node tools\publish-apk.cjs --bump patch
```

另一台手机同一 Wi-Fi 下浏览器打开那个地址 → 下载 → 覆盖安装。
**覆盖安装不丢已保存的连接**（SharedPreferences 只在卸载时清）。

### 20.5 三条前提（AGENTS §6.29）

1. 两个包必须同一张证书 —— 换成自己的 keystore 后，手机上那个包就再也覆盖不上了。
2. versionCode 只能升不能降 —— 所以不能用浅克隆下的提交数。
3. 拿不到 APK 是第三种完全不同的原因 —— 用 `serve-apk.cjs` 给个局域网下载页。

三者都表现为「装不上」，但修法互不相同，排查时先分清是哪一类。

## 第 21 步：GitHub Release 发版通道 ✅

用户：「有 GitHub 账号」—— 要把 §20 那套「电脑必须开着 + 同一 Wi-Fi」换成手机存一个固定网址。

### 21.1 为什么固定网址是这里唯一重要的东西

GitHub 的 `releases/latest/download/<asset 名>` 是**稳定重定向**：永远指向最新一个 Release
的同名 asset。于是手机上存的是

```
https://github.com/<owner>/<repo>/releases/latest/download/dsh-remote-latest.apk
```

这个链接从今往后不变。**asset 名必须一直是 `dsh-remote-latest.apk`** ——
换名字链接就 404，手机上表现成「下载失败」，而且没人会想到是名字改了。

### 21.2 换掉 debug 证书（这一步不可逆，但必须现在做）

原来 release 用的是 `~/.android/debug.keystore`。它的口令是公开的（`android`），
任何人都能签一个同证书的包覆盖安装到手机上。走公网分发（GitHub）不能这么干。

新建 `release/dsh-remote.jks`（已 gitignore）：

| 项 | 值 |
|---|---|
| 算法 | RSA 4096，SHA384withRSA，有效期 10000 天 |
| DN | `CN=DSH Remote, OU=Personal, O=Personal, L=Local, C=CN` |
| alias | `dsh-remote` |
| 口令 | 24 位随机，写入 `release/password.txt` |
| SHA-256 | `12912cf905c2691dbf9d97e72a4e7322c61f1c1dad10b5385f2a65e9d08532b0` |

`local.properties` 追加四项（`dsh.releaseStoreFile` / `dsh.releaseStorePassword` /
`dsh.releaseKeyAlias` / `dsh.releaseKeyPassword`），于是本机 `assembleRelease` 也自动用它。
实测：`apksigner verify --print-certs` 输出 `V2 Signer: certificate DN: CN=DSH Remote…`。

**代价**：debug 包与 release 包不再能互相覆盖。手机上还装着旧 debug 证书版本的，
换到新证书的 release 必须先卸载一次（连接列表跟着丢，要重新扫码）。

### 21.3 `.github/workflows/release.yml`

`on.push.tags: ['v*']` + `workflow_dispatch`（手填 tag）。`permissions: contents: write`。

三条**不可省**的检查，每条都对应一个「看起来成功、装上却不对」的失败模式：

| 检查 | 省掉的后果 |
|---|---|
| `tag == "v" + versionName` | Release 页写 v0.2.1、包里是 0.2.0；Android 只认 versionCode，事后无法靠版本号对上号 |
| 四个签名 secret 缺一即 fail | `build.gradle.kts` **静默回落**到 debug keystore，而 runner 上没生成过 `~/.android/debug.keystore`，最后只产出 `app-release-unsigned.apk` |
| `apksigner verify --print-certs` + 检查产物存在 | AGP 签不出来时**不报错**，只是把产物改名成 `-unsigned` |

还有一个刻意的选择：**CI 上 `dsh.lanUrl`/`dsh.lanPin` 留空**（没有 `local.properties`），
所以 Release 包不带家里的 IP 与 PIN，一进去要求扫码 —— 这是对的。

### 21.4 `tools/publish-release.cjs`

```
node tools/publish-release.cjs --bump patch   # 升版本，然后提示你先提交
node tools/publish-release.cjs --no-bump      # 打 tag 并推送
```

脚本先查四件事：origin 指向 GitHub、工作区干净、`release/dsh-remote.jks` 存在、tag 没重名。
**只推 tag 不推代码** —— 发版必须对一个已提交的状态打标，否则「这个 tag 是哪份代码」无法回答。
**也不替你 commit** —— bump 后的 `version.properties` 要单独提交，脚本只打印该怎么做。
本机试跑（无 origin）输出预期失败：`error: No such remote 'origin'` → `停：没有配置 origin 远端…`。

### 21.5 落地结果（2026-11-02）

仓库 **https://github.com/Lisa4916/dsh-mobile-app**（public），Release
**https://github.com/Lisa4916/dsh-mobile-app/releases/tag/v0.2.0** 已发布三个资产：

| 资产 | 大小 |
|---|---|
| `dsh-remote-0.2.0-2.apk` | 1,930,818 B |
| `dsh-remote-latest.apk` | 1,930,818 B |
| `SHA256SUMS.txt` | 185 B |

手机端固定地址实测：`releases/latest/download/dsh-remote-latest.apk` →
`302` 到 tag、再 `302` 到 `release-assets.githubusercontent.com`、最终 `200`；
下载 1,930,818 B，SHA-256 `b10f01536c8a187be776d618c4bd9084421453e3e6f95bf5b4a6ce85cd2770f8`，
与 `SHA256SUMS.txt` 一致。`aapt2 dump badging` 确认 `versionCode='2' versionName='0.2.0'`，
`apksigner verify --print-certs` 确认 `V2 Signer: certificate DN: CN=DSH Remote…`。

### 21.6 首次跑 CI 撞的三个坑（都已修，全部是真失败不是环境抖动）

**坑 1：`setup-android` 默认装的 `tools` 包已被移除。**
`android-actions/setup-android@v3` 默认 `packages: tools platform-tools`，而 cmdline-tools 16.0
已经没有 `tools` 这个包：

```
[command]/usr/local/lib/android/sdk/cmdline-tools/16.0/bin/sdkmanager tools
Warning: Failed to find package 'tools'
Error: The process '.../sdkmanager' failed with exit code 1
```

表现是 **三个 job 全卡在 Set up Android SDK**（run 41455303784 / 41455142884）。
修法：显式 `packages: 'platform-tools'`，platform / build-tools 交给 Gradle 构建期自己下。

**坑 2：`apksigner` 不在 PATH 上。**
上一条改完，Build release 成功了，但 Verify 步骤报 `apksigner: command not found`（exit 127）——
`apksigner` 在 **build-tools** 里，不在 platform-tools。修法：从
`$ANDROID_HOME/build-tools/*/apksigner` 取版本号最大的那个（`sort -V | tail -n1`），
找不到就报错并列出目录。

**坑 3：`github.com` 的 TLS 握手被拦，git 推送全挂。**
本机 `github.com` 解析到 `198.18.0.13`（代理 fake-IP），`api.github.com` / `codeload` /
`raw.githubusercontent.com` 都正常，唯独 `github.com:443` 无论直连、HTTP 代理、SOCKS5、
换 `--resolve` 指定官方 IP，全部 `schannel: failed to receive handshake` /
`OpenSSL: unexpected eof while reading`。`curl` 对 `github.com` 同样 `000`。

所以本轮最后两次提交（`beed43d`、`c8191e8`）**是走 GitHub Contents API 推上去的**，
不是 `git push`。做法：`PUT /repos/{owner}/{repo}/contents/{path}` 逐文件提交，
然后 `POST /git/tags` + `PATCH /git/refs/tags/vX.Y.Z` 把 annotated tag 重指到新提交。
一次性脚本用完即删，**没有留在仓库里**。

> 这不是可以忽略的偶发故障：只要 `github.com:443` 的 TLS 起不来，
> `git push` / `git ls-remote` 就一律不可用，而 `publish-release.cjs` 正是靠
> `git push origin refs/tags/...` 发版的。下次发版前先探一句
> `git ls-remote origin`，不通就走 API 或先修好代理规则（把 `github.com` 加进直连/正确节点）。

## 第 22 步：装完就能连，不必先扫码或手输 ✅

用户：「软件下载后需要手动连接或者扫码连接」—— 这是从 GitHub Release 装完 App 的第一体验，
必须先去电脑前扫二维码，或者在手机上敲一整个 `http://192.168.x.x:3081/?token=xxxxxxxx`。

### 22.1 根因不是「忘了做自动连接」，而是自动连接没有可用的东西

`autoconnect()` 本来就有三级判断（`AutoConnect.decide`）：

| 顺序 | 依据 | CI 包里的实际情况 |
|---|---|---|
| 1 | 手机里最后使用过的连接 | 全新安装 → 没有 |
| 2 | 构建时注入的 `BuildConfig.DEFAULT_LAN_URL` | **空串**（见下） |
| 3 | 落到连接列表，走「扫码 / 手输」 | ← 用户看到的就是这一步 |

第 2 条为空是**故意的**：`.github/workflows/release.yml` 不传 `dsh.lanUrl`/`dsh.lanPin`，
因为内置一个写死的 `?token=` 等于把 dsh-pocket 的局域网 PIN 公开在仓库里，
写死的 IP 也会在换网段后变成一个连不上的地址。

于是三级全落空。缺的不是「自动连接代码」，而是**「手机怎么知道电脑在哪」**这一层信息。

### 22.2 为什么不能靠服务发现

查了 dsh-pocket 服务端（`~/.dsh/profiles/desktop/node_modules/dsh-pocket`，v2.12.0）：
`lib` 下所有 js 文件里 `mdns|bonjour|discovery|broadcast|multicast|ssdp` **零命中** ——
它既不广播自己，也不响应发现请求。手机侧没有现成的服务发现可用。

所以只剩一条路：**自己扫一遍 /24**。

### 22.3 扫描可行性实测（本机真跑，不是估算）

一次性原型 `tools/_probe-lan-scan.cjs`（用完已删）：

```
候选 254 个地址（来自 192.168.50.58/24）截断=false
TCP 3081 存活：1 个，耗时 1857ms -> 192.168.50.58
总耗时 1871ms
```

参数：并发 48、TCP 连接超时 300ms、HTTP 读超时 800ms。
**254 个地址全扫完 1.86 秒**，命中唯一一台电脑。

两个关键取舍：

- **钉死 /24，不按真实掩码展开。** 家里若是 /16，展开是 65,534 个地址，
  手机上跑不完也没意义。
- **不能拿响应长度当指纹。** 同一个「访问验证」页实测出现过 4210 B 与 3969 B 两种长度
  （页面里带着动态内容）。判据只能是正文含 `DSH Pocket` 或 `DeepSeek Harness`。

### 22.4 扫到之后还差 PIN —— 这一层要说清楚

dsh-pocket 的 PIN 是**进程级的一把钥匙**（`~/.dsh/dsh-pocket/token-lan`），
没有任何接口能在未认证时读到它。实测四种请求的差异：

| 请求 | 状态 | `Set-Cookie` | 标题 |
|---|---|---|---|
| 无 token | 200 | 无 | DSH Pocket · 访问验证 |
| `?token=12345678`（局域网 PIN） | 200 | `dsh-auth-*` + `dsh_pocket_token` | 正在进入 |
| `?token=00000000`（错 PIN） | 200 | 无 | 访问验证 |
| `?token=87654321`（公网 PIN） | 200 | 无 | 访问验证 |

→ 判据是「有没有下发 `Set-Cookie`」；公网 PIN 在局域网端口上无效（两把不同的钥匙）。
→ 所以扫描能解决「电脑在哪」，解决不了「PIN 是多少」。这一步必须由用户提供，
  但可以把它从「跑到电脑前扫二维码」压缩成「输 8 位数字」。

### 22.5 落地

新增 **`app/src/main/java/com/dsh/remote/LanDiscovery.kt`**：

- `LanScan`（纯 JVM，可单测）：`candidates()` / `looksLikePocket()` / `tokenOf()` /
  `rebind()` / `schemeOf()` / `portOf()` / `localIpv4()` / `isWifiLikeInterface()` / `localLanIpv4()`。
- `LanDiscovery`（Android 侧）：线程池 48 并发、`HTTP/1.0` + `Connection: close`、
  命中即返回（不必读完）、`cancel()` 可随时停手。

新增 **`app/src/main/java/com/dsh/remote/LanAdopt.kt`**：扫到之后怎么办的纯决策。

| 情形 | 结局 | 理由 |
|---|---|---|
| 扫到的主机 == 已保存档案的主机 | `Adopt`（直接连） | 本来就认识这台电脑 |
| **只有一台**电脑答话，且有带 PIN 的档案 | `Adopt`（`rebind` 搬 PIN 到新 IP） | PIN 是进程级的，不随 IP 变；电脑换了 DHCP 地址仍有效 |
| 多台电脑答话 | `AskPin` | 手机侧分不清是哪台，搬 PIN 有可能连到别人家机器上 —— 宁可让用户输一次 |
| 扫到但没有任何带 PIN 的档案 | `AskPin` | 打开它自己的验证页／亮出 PIN 输入框 |
| 一台都没扫到 | `None` | 落回列表 + 手输/扫码 |

几条硬约束（都是踩过才知道的）：

- `tokenOf` **必须先砍 fragment 再找 `?`**：`http://h/#?token=x` 里的 token 是 fragment 的，
  服务端收不到；反过来先找 `?` 就会把它当成有效凭据。
- `rebind` **必须带上原 scheme**：`BootstrapUrl.build` 见到没有 scheme 的输入会补 `http://`，
  于是 `https://` 的档案迁移后会**悄悄降级成明文** —— 用户不会察觉，但 cookie 就开始裸奔了。
  单测 `rebind_preservesHttpsScheme` 就是钉这个。
- `connectWithPin` **必须带端口**：`BootstrapUrl.build` 只补 scheme 不补端口，
  传裸主机名会拼成 `http://<ip>/?token=…`（80 端口），连不上 3081。
- 扫描汇总要放**独立线程**等 `CountDownLatch`，不能提到同一个线程池：池满时永远轮不到，
  表现是「扫完了但一直不回调」。
- 走流量时**不扫**：`localLanIpv4()` 只认 `wlan/ap/swlan/eth/rndis/usb` 前缀的接口。
  扫运营商 NAT 网段白等 2 秒，一台电脑都不会有。
  不用 `ConnectivityManager`，那要 `ACCESS_NETWORK_STATE` 权限（本项目已删）。

`MainActivity` 侧的改动：

- `autoconnect()` 的第三级从「直接落到列表」改成「落到列表 **并起一次扫描**」。
- 列表页新增 `foundBox`（默认 GONE）：扫到电脑但没有 PIN 时亮出来，显示主机名 +
  「输入电脑上显示的 8 位访问 PIN」+ 「用这个 PIN 连接」+ 「重新找一次」。
- 新增「在局域网里找电脑」按钮，放在「扫码连接」上面 —— 它不需要用户做任何事，
  而扫码要用户跑去电脑前对着屏幕，先给最省事的那条路。
- 空态文案从「先扫电脑上的二维码」改成「装好后会自动扫一遍同一 Wi-Fi 下的电脑」。
- `onDestroy` 里 `lanDiscovery.cancel()`：一轮是 254 个 TCP 连接，退出后还在发纯属浪费。
- 扫描过程与结果都打 `Log.i("DshRemote", "lan discovery done, found=N")`，真机上可直接看。

### 22.6 单测

新增 `LanDiscoveryTest`（23 条）+ `LanAdoptTest`（11 条），全部纯 JVM、不需要设备。

最值钱的是**反面**用例：

| 用例 | 钉住的事 |
|---|---|
| `looksLikePocket_rejectsOtherServices` | 不认 `TP-LINK 路由器设置`，否则 254 个地址里任何一个路由器都会被当成电脑 |
| `looksLikePocket_doesNotDependOnLength` | 同一页面 4210 / 3969 两种长度都要认，钉住「不能用长度当指纹」 |
| `tokenOf_ignoresFragmentOnlyToken` | `#?token=` 不是凭据 |
| `rebind_preservesHttpsScheme` | 迁移不得把 https 降级成 http |
| `plan_doesNotRebindWhenMultipleComputersAnswer` | 多台答话时不搬 PIN，防连错机器 |
| `plan_exactMatchStillWinsWhenOthersAlsoAnswer` | 自己那台在旁边还有别的机器时仍要直连自己那台 |
| `plan_asksForPinWhenSavedEntryHasNoPin` | 存着裸地址时不能凭空造 PIN |

### 22.7 结果

`gradle :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` → BUILD SUCCESSFUL。

```
tests=176 failures=0 errors=0
AutoConnectTest 7 / BackNavigationDeciderTest 18 / BootstrapUrlTest 10 / CookieNamesTest 10 /
EndpointTest 24 / HandshakeHealGateTest 10 / HostMatchTest 17 / LanAdoptTest 11 /
LanDiscoveryTest 23 / PageProbeTest 20 / RecoveryExecutorTest 12 / RecoveryPlannerTest 14
```

测试基线 142 → **176**；lint **0 error / 22 warning**；APK `app-debug.apk` **7,365,924 B**。

**真机未验**（`adb devices` 当前无在线设备 —— `ZY22GHMK5F` 已断开）。
装回去之后要看三件事：① 全新安装（清数据）是否 ~2 秒内自己进主界面；
② 扫到但没 PIN 时 `foundBox` 是否正确出现；③ 走流量时是否**不**触发扫描。

### 22.8 还没解决的

- **全新安装 + 手机里没 PIN** 时仍然要用户输一次 PIN —— 已在**第 23 步**解决（电脑侧关掉
  `lanAuthEnabled` + 手机侧扫到就识别免 PIN），见第 23 步。
- 扫到多台电脑时只会 `AskPin` 第一台，没有「列出全部让用户挑」。多台场景在家里几乎不存在，
  先按最简处理。

## 第 23 步：从 GitHub 装完直接进主界面，不再出现 PIN 屏 ✅

用户：「下载后就是需要填写 pin 的那个界面，更新后要能直接进入主界面」
「在 github 上下载更新后，要直接进入主界面」。

第 22 步只做到「装完自动扫到电脑，然后弹一个输 PIN 的框」。用户要的是**扫到就直接进去**。

### 23.1 为什么这件事只能在「电脑侧愿意放行」时才成立

dsh-pocket 的 PIN 是**进程级密钥**（`~/.dsh/dsh-pocket/token-lan`），没有读取接口：

| 想做的事 | 可行性 |
|---|---|
| 手机端从电脑探出 PIN | 不行 —— 未认证响应里没有它，且错 PIN 与无 PIN 的响应完全一样 |
| 把 PIN 编进公开仓库的 Release 包 | 不行 —— 任何下载 APK 的人反编译就能拿到（第 21 步就是为了这个才不注入内置地址） |
| 让电脑在局域网内免 PIN | **可以** —— dsh-pocket 官方提供了这个开关 |

关键在 `dsh-pocket/lib/index.js:336-339`：

```js
isProtected: (host) => {
  if (isLanOverrideHost(host)) return lanAuthEnabled();
  return classifyHost(host) === 'public' ? true : lanAuthEnabled();
}
```

局域网是否要 PIN 由 `lanAuthEnabled` 决定；**公网永远要 PIN**，这条不受影响。
`lib/settings.mjs` 的文件头注释原文：「关闭后局域网扫码直连（仅同一网络内的设备能访问），
公网不受影响（永远要密码）」。

### 23.2 判据只能是「响应头里有没有 `dsh-auth-` 开头的 Set-Cookie」

实测（本机 `192.168.50.58:3081`，裸 GET，不带 token 不带 cookie）：

| `lanAuthEnabled` | 状态 | 正文长度 | title | Set-Cookie |
|---|---|---|---|---|
| `true` | 200 | 3969 | `DSH Pocket · 访问验证` | 无 |
| `false` | 200 | 522 | `DSH Pocket · 正在进入 \| opening…` | **`dsh-auth-…=v1.…; Max-Age=2592000; HttpOnly; SameSite=Strict`** |

挂上那张 cookie 再请求 → 200 / 47,868 B / `title=DeepSeek Harness`，是真实主界面。

**所以不能看状态码、不能看长度、也不能看正文**：「访问验证」页与「正在进入」页正文里都带
`DSH Pocket`，长度还会随状态漂移（4210 / 3969 / 522 都见过）。唯一稳的判据是响应头里
有没有 `Set-Cookie: dsh-auth-…`。

### 23.3 代码改动

`LanDiscovery.kt`
- 新增 `internal data class LanHit(val host: String, val open: Boolean)`
- 新增 `LanScan.issuesCredential(rawResponse: String?): Boolean` —— **只看第一个 `\r\n\r\n` 之前**的响应头，
  逐行找 `set-cookie:` 且含 `CookieNames.AUTH_PREFIX`（= `dsh-auth-`）。正文里出现
  `Set-Cookie:` 字样不算。
- `probe(host)` 返回 `LanHit?`，读循环的退出条件改成 `headerReady && looksLikePocket(...)` 两个都满足。
  **少判 `headerReady`** 会让「响应头与正文被拆成两个 TCP 段」时偶然判成「要 PIN」。
- `scan(...)` 的 `onFound` 回调改成 `(LanHit) -> Unit`。

`LanAdopt.kt` —— `plan(saved, hits, port)` 判定顺序（注释里写了「为什么是这个顺序」）：
1. hits 空 → `None`
2. 任一 saved 的 host 与某 hit 相等（忽略大小写）→ `Adopt`（原样沿用旧档案，含 PIN 与端口）
3. **恰好一台 `open`** → 构造 `http://<host>:3081/`（**不带 token**）→ `Adopt`
4. 只有一台答话时，对每个 saved 试 `LanScan.rebind`（沿用旧 PIN，用于电脑换 IP）
5. 其余 → `AskPin`

`MainActivity.kt`：`lanFound` 由 `MutableList<String>` 改成 `MutableList<LanHit>`，
`onLanScanDone` 传 `hits = lanFound.toList()`。

### 23.4 单测（新增 13 条）

`LanDiscoveryTest` 23 → **29**：`credential_trueForAuthCookie`、`credential_falseWithoutAnySetCookie`、
`credential_falseForUnrelatedCookie`（`dsh_pocket_token` 不算登录凭据）、
`credential_ignoresSetCookieLookingTextInsideBody`、`credential_matchesHeaderCaseInsensitively`、
`credential_falseForNullAndEmpty`。

`LanAdoptTest` 11 → **18**：`plan_adoptsOpenComputerWithoutAnySavedEntry`（断言 url 不含 `token=`）、
`plan_openComputerGetsLanKindBadge`、`plan_openComputerWinsOverRebindingSavedPin`、
`plan_exactHostMatchStillWinsOverOpenFlag`、`plan_doesNotGuessWhenTwoOpenComputersAnswer`、
`plan_openAndLockedMixedPrefersTheOpenOne`、`plan_reportsOpenComputerInChattyForm`。

### 23.5 真机验证（Redmi `8PCE7LJB99VG7TRO` / Android 15）

```
uninstall → install app-release.apk → pm clear → 冷启动
LaunchState: COLD   TotalTime: 522
mCurrentFocus=Window{... com.dsh.remote/com.dsh.remote.MainActivity}
截图：直接是「探索未至之境 / 默认工作区 / 标准模式」主界面，**没有 PIN 屏**
```

电脑侧 `settings.json` 已改为 `"lanAuthEnabled": false`，备份在
`settings.json.bak-20261102-225754`。公网（cloudflared）仍要 PIN，不受影响。

### 23.6 代价与边界（记住了，别忘）

- **局域网内任何设备**访问 `http://<电脑IP>:3081/` 都不用密码就能看到会话与文件。
  家里 Wi-Fi 可信才行；不可信就把它改回 `true`（App 会退回「扫到 + 输 PIN」）。
- 电脑侧开关一关，**手机上的档案也不需要改** —— 旧档案里带的 `?token=` 仍然有效，只是用不上。
- 多台电脑都免 PIN 时不猜，仍然落到 `AskPin`。
- 回归：`tests=189 failures=0 errors=0`（12 个测试类）；lint `0 error / 22 warning`；
  `app-release.apk` **1,930,946 B**。

### 23.7 发版落地（v0.4.0，2026-11-03）

`github.com:443` 的 git 传输这一轮又断了（`Recv failure: Connection was reset`，
且 `127.0.0.1:7890` 上没有进程在听），而 `https://api.github.com` 完全正常 —— 于是走 Git Data API：

```
POST /git/blobs（逐文件 base64）→ POST /git/trees（base_tree）
→ POST /git/commits → PATCH /git/refs/heads/master → POST /git/tags + POST /git/refs
```

**踩过的两个坑：**

1. 脚本后缀是 `.mjs` 时不能写 `require`，报
   `ReferenceError: require is not defined in ES module scope`；必须
   `import { execFileSync } from 'node:child_process'`。
2. 从 `version.properties` 取版本号的正则**必须锚行首**
   `/^versionName=([\d.]+)\s*$/m` —— 注释里也有一句 `-Pdsh.versionName=0.2.1`，
   不锚定会把 tag 打成 `v0.2.1`（第一次就踩了，已 `DELETE /git/refs/tags/v0.2.1` 删掉）。

**结果：**

| 项 | 值 |
|---|---|
| 本地提交 | `6540f6e` feat(remote): 电脑侧免 PIN 时扫到就直进主界面，不再出现 PIN 屏 |
| 远端 master | `f9a5f59` |
| tag | `v0.4.0` |
| Release 工作流 | run `41475557955` completed / **success** |
| 资产 | `dsh-remote-0.4.0-4.apk` **1,930,950 B**、`dsh-remote-latest.apk` 1,930,950 B、`SHA256SUMS.txt` 185 B |
| 固定地址 | `https://github.com/Lisa4916/dsh-mobile-app/releases/latest/download/dsh-remote-latest.apk` → 200 / 1,930,950 B |
| SHA-256 | `8d791d29ac331193929e7b0a1df060ccb1c73a12e7c210aa9b29afbad2b68abd` |

还有一个**不是代码问题**的坑一起记下：更新后「远程连接不上」的真因是电脑侧
`Get-NetConnectionProfile` 把 WLAN 判成 `Public`，Windows 默认 Public 入站全挡，
手机 `ping 192.168.50.58` 100% 丢包。改成 `Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private`
（需管理员）后立刻 `0% packet loss`、`nc -z 192.168.50.58 3081` 通。
`Get-NetFirewallRule -DisplayName 'DSH Pocket*'` 至今为空 —— 通的是 Private 的默认放行，不是我们加的规则。

#### 23.8 补记：走 API 推代码时远端树为什么对不上

第一版 `push-via-api.mjs` 用 `git diff --name-only` 挑文件、再 `fs.readFileSync` 上传，
推了两次，远端 `HEAD^{tree}` 都与本地不同（`8f960ce` 对 `7839a84`）。两个原因：

| 原因 | 现象 | 修法 |
|---|---|---|
| `core.autocrlf=true` | 工作区 CRLF、对象 LF，上传字节多带 `\r` | `git cat-file blob HEAD:<path>` 取对象字节 |
| mode 写死 100644 | `gradlew` 本来是 100755，可执行位被抹掉 | 从 `git ls-tree -r HEAD` 照抄 mode |

**验收标准**：`POST /git/trees` 返回的 sha 必须等于本地 `git rev-parse HEAD^{tree}`。
现在脚本会直接打印这个对比；全量重推（`--all`）时**不带 `base_tree`**，
否则远端独有的旧文件会残留成幽灵文件。

修完实测：`新 tree = 7d1e6e7b...（与本地树一致 ✅）`，远端 master `74fa61f`，
CI 最后一个 run completed / **success**。

---

## 第 24 步：在外面只插流量也能连 ✅

用户原话两轮：

> 「当前设备远程连接不上」
> 「在外面连接使用手机网络，也没有 wifi 啊」

第二句把问题问清楚了：这台手机长期只插流量卡，**局域网路径天然不通**，
所以「局域网能连、公网靠手输」这条路不能算解决。

### 24.1 三个真因（全部在真机上量出来）

| # | 现象 | 真因 | 证据 |
|---|---|---|---|
| 1 | 页面纯黑 `#151517`，90 秒不动 | 手机上装的那个「0.4.0」是**本机注入过 `dsh.lanUrl` 的 release 包**，冷启动直奔 `http://192.168.50.58:3081`；私网地址的 SYN 被静默丢弃（不回 RST），`onReceivedError` 与 `onPageFinished` **一次都不触发** | 从设备拉回 `base.apk`，扫 dex 命中 `192.168.50.58` / `12345678`；9 次采样全 0 文本节点 |
| 2 | 手机永远只有局域网一条档案 | `pocket.status` 的**字段不在顶层**，而在 `result.value` 里；按顶层取键永远拿不到 `tunnelUrl` | 日志 `pocket.status: no usable public address`；实测响应 `{"result":{"ok":true,"value":{…}}}` |
| 3 | 明明没 Wi-Fi 还白等 30 秒 | 私网地址被丢弃时 `maxProgress` 竟然到过 **10**，于是「一点进度都没走」那条判据不触发，一路等满硬上限 | 日志 `connect gave up after 30081ms, maxProgress=10` |

### 24.2 落地的三件套（`D:\dsh-mobile-app\app\src\main\java\com\dsh\remote\`）

**`ConnectWatchdog.kt`** —— 判「这次是在慢慢加载，还是根本连不上」：

| 判据 | 什么时候判死 | 为什么是这个数 |
|---|---|---|
| `maxProgress <= 0 && elapsed >= 8s` | 一点进度都没走过 | 正常远程页面 8 秒内必到 100；被丢弃时 90 秒仍是 0 |
| `elapsed >= 30s` | 动过但走不完 | 首屏偶尔到 12 秒，不能更小 |
| `hopeless(url, onLan)` | **没连 Wi-Fi 且地址是私有网段** —— 立刻判死，不等任何秒数 | 这不是「可能慢」，是「一定不通」 |

`giveUpMessage()` 分两种说法：内网地址就说「你当前没连 Wi-Fi，局域网地址只能在同一个 Wi-Fi 下用」；
公网地址就说「地址可能已经变了，去电脑上看一眼」。

**`PocketStatus.kt`** —— 从 dsh-pocket 的 RPC 里把公网地址取出来：

- `RPC_PATH = "/dsh-pocket/pocket.status"`；
- 响应是信封 `{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{…}}}`，
  所以先 `payloadScope()` 剥到 `result.value`，取不到时退回「整段就是负载」的老格式；
- `publicEndpoint()` 三条硬约束：`tunnelRunning` 必须真（关隧道后 url 仍留着，照抄得 530 死地址）、
  必须 `https://` 且 host 以 `.trycloudflare.com` 结尾、必须带 `accessToken`；
- **不引 JSON 库**：单测跑纯 JVM，`org.json` 那里是空实现；自己写 `topLevelKeys()` 判层深，
  防止 `tunnelState` 之类的嵌套同名键冒充顶层字段。

**`AutoFailover.kt`** —— 选下一条该试谁：

- `pickStart(all, lastUsed, onLan)`：有 Wi-Fi 就用 `lastUsed`；**没 Wi-Fi 而 `lastUsed` 是 LAN 时直接换成最近用过的 PUBLIC**；
- `next(all, current, triedIds)`：**优先换一种网络类型**（LAN ↔ PUBLIC），同类型里按 `lastUsedAt` 从新到旧，试过的绝不重试。

**`MainActivity` 接线**：
- `autoconnect()` 先过 `AutoFailover.pickStart`；
- 守望 tick 里先问 `hopeless`，再问 `verdict`；
- 判死后先 `AutoFailover.next` 换一条，换不到才 toast 原因 + 回落列表页；
- `onPageFinished` 后 `maybeCapturePublicAddress()`：用 `HttpURLConnection` 带 `CookieManager` 的 cookie
  去 POST `pocket.status`，把公网地址存进档案（**不动 `lastUsedAt`**，否则用户在家连一次局域网，
  下次就被莫名改走公网）。
  **不能用页面里的 `fetch`**：`evaluateJavascript` 的回调不 await Promise，拿到的是 `{}`。

### 24.3 新增 22 条单测

`ConnectWatchdogTest` 9 → 15（新增 `hopeless_*` 5 条 + `giveUpMessage` 1 条）、
`PocketStatusTest` 11 → 17（新增信封 6 条，夹具是**真机原始响应**）、
`AutoFailoverTest` 14 条。

反面用例最值钱，例如：
- `parse_envelopeIgnoresLookalikeKeysInsideValue` —— 往 `tunnelState` 里塞 `tunnelUrl` 也不能被当真；
- `hopeless_publicUrlWithoutWifiIsNotHopeless` —— 公网慢也要等，不能提前掐；
- `hopeless_lanUrlWithWifiIsWorthTrying` —— 有 Wi-Fi 时局域网是最快路径。

### 24.4 真机验证（Redmi `8PCE7LJB99VG7TRO` / Android 15）

```
有 Wi-Fi 冷启动 → 日志 I DshRemote: pocket.status: saved public address tunnel-b.trycloudflare.com
断 Wi-Fi，只留 ccmni1 10.66.64.247/8 → am force-stop + am start -W（TotalTime: 286）
等 40 秒 → uiautomator 出现 "DeepSeek Harness" WebView + "探索未至之境" + "默认工作区"
```

**只走 4G 冷启动直接进主界面**，这是这一步的目标。

### 24.5 结果

| 项 | 值 |
|---|---|
| JVM 单测 | **`tests=235 failures=0 errors=0`**，15 个测试类（189 → 235，新增 46 条） |
| lint | **0 errors / 22 warnings** |
| release APK | **1,947,334 B** |
| 真机 | 只走 4G 冷启动 → 主界面（无黑屏、无 PIN 屏、无白等 30 秒） |

### 24.6 还没解决的

- **`github.com:443` 的 TLS 时通时不通**，所以这一步的提交仍要靠 `tools/push-via-api.mjs` 走 GitHub API。
- **GitHub Release 的包不带内置地址是故意的**（防 PIN 进公开仓库），所以「装完直接能连」
  依赖两个东西：局域网自动发现（第 22 步）+ 免 PIN 识别（第 23 步）+ 公网地址自动抓取（本步）。
  三者缺一，出门就得手输。
- 手输地址链路在真机上**被输入法坑过**：讯飞/搜狗会把手打的 `:` `-` `.` `?` 换成全角
  （`https：//…－…。…/？token=`），地址直接失效。这也是「不要靠手输」的另一个理由。

### 24.7 发版落地（v0.5.0，2026-11-03）

| 项 | 值 |
|---|---|
| 提交 | `29e70da` `feat(remote): 出门只插流量也能连，连不上立刻回落而不是黑屏干等` + `5a2d4fa` `chore(release): 版本升到 0.5.0` |
| 版本 | `versionCode=5` / `versionName=0.5.0` |
| Release | tag `v0.5.0` → 工作流 `completed/success`；资产 `dsh-remote-0.5.0-5.apk` **1,947,330 B**、`dsh-remote-latest.apk` 同尺寸、`SHA256SUMS.txt` 185 B |
| 固定地址 | `200` / 1,947,330 B，SHA-256 **`56acf0556b6175b307716fbb4032477251de9b4c711ba4750f8a8a43c8a83c46`**，与 `SHA256SUMS.txt` 逐字节一致 |
| 签名 | `CN=DSH Remote, OU=Personal, O=Personal, L=Local, C=CN` / `12912cf9…`，与 0.4.0 同一把钥匙，可直接覆盖 |

**真机终验（v0.5.0，Redmi `8PCE7LJB99VG7TRO` / Android 15）**

```
装前：pm clear com.dsh.remote（模拟全新安装）
只走移动数据（只剩 ccmni1 10.66.64.247/8）
冷启动 am start -W → TotalTime: 303
等 25 秒 → uiautomator 仍是列表页（0 条档案时这是正确行为：没地址可猜）
```

然后走一遍真实场景：

```
① 开 Wi-Fi → 手动点「在局域网里找电脑」
   I DshRemote: lan discovery done, found=1
   I DshRemote: pocket.status: saved public address <tunnel-b>.trycloudflare.com   ← 公网地址进档案
② 关 Wi-Fi（只剩 ccmni1）→ am force-stop + am start -W（TotalTime: 310）
③ 等 40 秒 → uiautomator 0 个文本节点（已在 WebView 里），截图是 DSH 主界面（dsh-purge「用户须知」一次性弹窗）
```

**注意第 ③ 步屏幕上那层弹窗不是 PIN 屏**：那是网页里 dsh-purge 插件的一次性须知，
App 的列表页才会渲染原生标题「DSH 手机遥控」。判据：`uiautomator` 里 0 个原生文本节点 = 已在 WebView。

**一个容易误判的地方**：`pm clear` 之后第一次冷启动不会自动连 —— 因为手机里一条档案都没有，
`AutoFailover.pickStart` 返回 null，落到 `ShowList` 并扫网段（只有 Wi-Fi 时才扫）。
这是设计：没有任何线索时不该乱猜地址。真实用户不会 `pm clear`，档案一直在。

**这一轮 git 通道**：`github.com:443` 恢复了，但不是 fast-forward —— 远端 master 的 sha 与本地不同
（之前几次走 API 推送造成的）。`git rev-parse origin/master^{tree}` 与本地 `3beb5ce^{tree}` 都是
`1e9c7630…`，确认树一致后 `git reset --soft origin/master` 再重放提交，得到 `29e70da`，
推送 `8a30788..29e70da` 成功。**以后遇到 push 被拒先比 tree，不要急着 pull 生成无意义的合并提交。**
