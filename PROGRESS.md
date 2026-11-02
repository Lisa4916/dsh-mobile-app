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

**测试基线：JVM 单测全量 `tests=118 failures=0 errors=0 skipped=0`**
（`AutoConnectTest` 7 + `BackNavigationDeciderTest` 11 + `BootstrapUrlTest` 10 + `CookieNamesTest` 10 +
`EndpointTest` 24 + `HandshakeHealGateTest` 10 + `PageProbeTest` 20 + `RecoveryExecutorTest` 12 + `RecoveryPlannerTest` 14）
**真机 instrumented：`PageProbeJsTest` 7 条 `OK (7 tests)`**（`8PCE7LJB99VG7TRO`，Android 15）
**APK：`app-debug.apk` 7,485,956 B**（versionName 0.1.0，versionCode 1）

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
| 公网 URL | `https://producers-discharge-atmosphere-ppc.trycloudflare.com` |
| 公网 PIN | `75330002`（= `~/.dsh/dsh-pocket/token`） |
| 本机侧实测 | 未认证 200/4210「访问验证」；`?token=75330002` → 200/499「正在进入」+ 双 Set-Cookie；再 GET / → 200/48062 `DeepSeek Harness` |

**注意：quick tunnel 的域名每次重开都变，`tunnel-auto.json` 只记 `{"at":<ts>}` 不记 URL，
目录里也没有任何文件含 `trycloudflare` 字符串 —— 隧道重开后必须重新从设置页读地址。**

### 真机 4G 验证（第 7 步本体的验收）

流程：`svc wifi disable` 确认只剩 `ccmni*`（4G）→ 把公网端点写进 `shared_prefs/dsh_endpoints.xml` →
`am start` → 25 秒后截图。

- **结果：完整主界面**「探索未至之境 预览版 / 默认工作区 / 标准模式 / 描述你想要构建的内容」，
  状态栏 4G、无 Wi-Fi。证据图见 [docs/evidence/step7-public-4g.png](D:\dsh-mobile-app\docs\evidence\step7-public-4g.png)。
- CDP：`title=DeepSeek Harness`、`url=https://producers-discharge-atmosphere-ppc.trycloudflare.com/`。
- 同一台机器上第二台机（motorola XT2335-3 / `ZY22GHMK5F`）在 4G 下**页面黑屏后从 adb 掉线**，未继续追；
  改用 Redmi `8PCE7LJB99VG7TRO` 一次通过。

### 公网下的自愈同样成立

`tools/verify-selfheal-net.cjs` 加了两个参数化（`process.argv[2]` 指定 CDP 端口、
cookie domain 从当前页面 origin 现取，否则换公网域名时 `setCookie` 会因 domain 不匹配失败）后实测：

```
1. https://<host>/
2. https://<host>/?token=75330002&dsh-pocket-retry=1   ← 自愈重连   ← 带 token
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
| 离线启动 → 恢复网络 → 点同一行 | 一次进主界面。Document 请求 2 次：`?token=75330002` → `/`，`title=DeepSeek Harness` |
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

