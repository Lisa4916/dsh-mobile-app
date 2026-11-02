# AGENTS.md — dsh-mobile-app（DSH 手机遥控）

> 工程根：`D:\dsh-mobile-app` ｜ 包名 `com.dsh.remote` ｜ 版本 0.1.0
> 上游依赖（外部、不属于本仓库）：`dsh-pocket` 2.12.0 反向代理 :3081，以及它背后的 `dsh web` :54282
> 状态：**A 档主体已真机跑通**，公网远程连接（第 7 步）已在真机 4G 下打通（第 7e 步）。
> 「访问验证页自愈」已实现（第 7b 步）并**在真机上抓到决定性证据**（第 7d 步，公网域名下同样复验过）：
> 坏 cookie → 判 `'2'` → 清 `dsh_pocket_token` → 带 `retry+token` 重连 → 进主界面。
> 反向分支（地址里没有 `?token=`）也实测过：**只提示、不清 cookie**，否则用户被永久锁在验证页外。

---

## 0. 这个项目是什么

把电脑上正在跑的 DeepSeek Harness 搬到手机上：**同一份会话、同一批文件、同一套工具**。
不是重写 DSH 前端，是一个 WebView 外壳，直接打开 `dsh-pocket` 提供的已认证页面。

```
手机 App（本仓库，WebView 外壳）
   │ http://192.168.50.58:3081/?token=<PIN>
   ▼
dsh-pocket 反向代理 :3081（外部组件，已装已跑，本仓库不改它）
   ▼
本机 dsh web :54282（宿主进程 DeepSeek Harness.exe）
```

**为什么不做原生重写**（这是立项时定下的边界，别推翻）：
1. DSH web 的 `/`、`/api/`、`/api/sessions`、`/api/events` 全部 401，`/sse` 404。直连要先自己做 token→cookie 握手，再自己实现 `events.mux` WebSocket。
2. 连成熟项目 `saya-ch/dsh-mobile` 都注明「直接打开插件提供的已认证 HTTPS 页面，不打包另一套 DSH 前端」。
3. `dsh-pocket` 已移植 `dsh-web-mobile`（MIT）的窄屏布局，移动端体验现成。

---

## 1. 每次新会话第一步：构建环境

`gradle` 不在 PATH，`JAVA_HOME` / `ANDROID_HOME` 也没设。不设就是 `command not found`。

```powershell
$env:JAVA_HOME='D:\AndroidDev\jdk17'
$env:ANDROID_HOME='D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'

# 构建 + 单测（两条一起跑，基线 tests=235 failures=0）
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    -p 'D:\dsh-mobile-app' :app:assembleDebug :app:testDebugUnitTest --console=plain -q

# 安装到真机
& 'D:\AndroidDev\sdk\platform-tools\adb.exe' -s ZY22GHMK5F install -r `
    'D:\dsh-mobile-app\app\build\outputs\apk\debug\app-debug.apk'
```

**内置连接地址**（`local.properties`，已 gitignore，不进仓库）：

```properties
dsh.lanUrl=192.168.50.58:3081
dsh.lanPin=<token-lan 的内容>
```

不填也能构建、也能用（App 落到连接列表走扫码/手输）。
**`MainActivity` 里不再有任何写死的 IP 或 PIN —— 别再写回去。** 详见 §6.19。

| 项 | 值 |
|---|---|
| JDK | `D:\AndroidDev\jdk17`（Temurin 17.0.20.1） |
| SDK | `D:\AndroidDev\sdk` |
| Gradle | `C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat` |
| AGP / Kotlin | 8.7.3 / 2.0.21 |
| compileSdk / minSdk / targetSdk | 35 / 24 / 35 |
| 真机 | **motorola XT2335-3**（`penang`），Android 14 / SDK 34，adb **`ZY22GHMK5F`**，WebView 117.0.5938.60 |
| 旧真机（作废） | Redmi 23054RA19C / Android 15 / `8PCE7LJB99VG7TRO` —— 已不是主用验证机，`kb/` 与 `CONTEXT-ANCHOR.md` 里的历史环境标注仍指它 |
| Node（跑 tools/ 脚本） | `C:\Users\yaoqi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |

**Gradle 版本有硬约束**：本机缓存里的 `gradle-9.4.1` 与 AGP 8.7.3 **不兼容**，必须用 8.9。
`gradle-8.9` 解压在短路径 `%TEMP%\gradle-short\` 下；长路径解压会丢 `bin/`（Windows 260 字符限制）。

---

## 2. 用户的工作方式

- **一步一个会话**。每完成一步：跑测试 → 更新 `PROGRESS.md` → 停止。
- 不要一次推进多步，不要在没被要求时顺手做下一步。
- 真机验证优先于「代码看起来对」。这个项目里所有结论都是从设备上量出来的，不是推出来的。

---

## 3. 当前进度

| # | 事项 | 状态 |
|---|---|---|
| 1 | 工程骨架 + 构建工具链 | ✅ |
| 2 | 连接列表 / 扫码（CameraX+ZXing）/ 手输地址 | ✅ |
| 3 | 全屏 WebView 加载 dsh-pocket 页面，真机显示同一段对话 | ✅ |
| 4 | 键盘避让（WebView 不缩 + 页面 rAF 自驱） | ✅ 见 §5 |
| 5 | 启动即自动连接，落在 DSH 主界面（document-start 清 `dsh.sessions.current`） | ✅ |
| 6 | 移除顶部返回键（压住了 DSH 自己的侧边栏按钮） | ✅ |
| **7** | **公网远程连接（隧道）** | ✅ 真机 4G 通过（第 7e 步） |
| 7a | 连接列表区分「局域网 / 公网 / 本机」落点 | ✅ |
| 7b | 「访问验证」页自愈 | ✅ 见 §6.13 |
| 7c | 真机无线调试接入 | ❌ 放弃（配对成功但恒 offline，改走 USB） |
| 7d | 真机 USB 接入 + 第 7b 步真机复验 | ✅ |
| 7e | 公网隧道开启 + 真机 4G 验证 + ASK_USER 分支实测 | ✅ |
| 8 | 手机软件开发知识库：5 篇种子文档入库 + 挂载到本项目与 `D:\DeepSeek Harness`；三次强化后共 **26 篇**（含平台版本节奏、Android 16 迁移、WebView 安全基线、渲染进程兜底、R8/发布、测试分层、架构分层、敏感数据、性能验证、启动阶段 CSS 过渡闪屏） | ✅ 见 §8 |
| 11 | 体检出的四个问题：同域判定 / 状态栏前景 / 文案 / 渲染进程兜底 | ✅ 见 §6.21–§6.23 |
| 9 | 前台服务保活（测试期靠 `svc power stayon true`，不该长期开） | ⏳ |
| 10 | 任务完成通知 / 文件拍照附件 / 多电脑一键切换 | ⏳（局域网自动发现已做，见第 15 行） |
| 12 | 体检剩余四项：删无用权限与资源 / release 补齐 / 长按删除加确认 / 收敛 strings 与颜色 | ✅ 第 16 步 |
| 13 | 返回与进入严格互逆：页面拆七层，一次只退一层 | ✅ 见 §6.28 |
| 14 | 第二台手机装机与收更新：版本号单一来源 + release 分发页 | ✅ 见 §6.29 |
| 15 | 装完就能连：自动扫局域网找电脑，扫到只差 PIN | ✅ 见 §6.31 |
| 16 | 免 PIN 直进主界面：扫描时识别「这台电脑不需要 PIN」 | ✅ 见 §6.32 |
| 17 | 出门只插流量也能连：抓公网地址 + 连不上立刻回落 + 没 Wi-Fi 不等局域网 | ✅ 见 §6.33 |

**第 7 项现状（2026-11-02 重测，旧结论已作废）**：`cloudflared.exe` 在
`C:\Users\yaoqi\.dsh\dsh-pocket\bin\cloudflared.exe`（55,390,512 B，2026.10.7）。
**本机现在没有 Clash/mihomo 进程、没有 TUN 网卡、系统代理 `ProxyEnable=0`**，
cloudflared precheck 全 PASS，quick tunnel 注册成功（`lax11`）且公网返回 200 ——
「sing-tun 掐断边缘连接（error 1033）」这条旧结论**已经不成立**，不要再照着它关 TUN 或换 cpolar。

第 7 步（公网远程连接）**已打通**（第 7e 步）：dsh-pocket 设置页开启 quick tunnel 拿到
`https://<random>.trycloudflare.com` + 公网 PIN，真机关 WiFi 走 4G 直接进主界面；
公网域名下「访问验证页自愈」与「无 token 时不乱清 cookie」两支都实测过。

**quick tunnel 地址每次重开都变**：`~/.dsh/dsh-pocket/tunnel-auto.json` 只记 `{"at":<ts>}`、不记 URL，
目录里也没有任何文件含 `trycloudflare` 字符串 —— 隧道重开后必须回设置页重新读地址与 PIN。
（端点参考：`tunnel.start` / `tunnel.stop` / `tunnel.setConfig`；`tunnel.start` 必须带 `payload.disclaimer=true`，服务端强制校验。）

---

## 4. 源码地图

```
app/src/main/java/com/dsh/remote/
├── Endpoint.kt          data class Endpoint(id, label, url, lastUsedAt, kind)
│                        kind: Kind = LOOPBACK / LAN / PUBLIC，**默认由 url 推断**
│                        isPublic / urlIsVolatile(quick tunnel 域名会变) 两个派生属性
│                        parseUri(raw) → String?（规范化 + 补 scheme）
│                        hostOf(url) → String? / kindOf(url) → Kind
│                        isPrivateHost 覆盖 10/8、172.16/12、192.168/16、169.254/16、
│                          fc00::/7、fe80::/10、::ffff:v4；**CGNAT 100.64/10 不算私有**
│                        EndpointStore(context)：all / upsert / touch / remove / lastUsed
│                        serialize/deserialize 是行式 TSV（5 列，**4 列老数据要能读**）
│                        idFor(label, url) 稳定 id
│                        ⚠ 纯 JDK，不碰 android.net.Uri，原因见 §6.1
├── MainActivity.kt      连接列表 + 全屏 WebView + 键盘避让编排 + 生命周期
│                        autoconnect() / connect(endpoint, persist) / showList()
│                        applyImeInsets() → WindowInsetsAnimationCompat.Callback
│                        applyKeyboardInsets(insets, animated) / dispatchKeyboard(h)
│                        applyKeyboardHeight(h) → 只改 listRoot 的 bottomMargin
│                        notifyPageKeyboard(px) → 换算 CSS px 后 evaluateJavascript
│                        applyBarIconTheme(darkBackground) → 状态栏/导航栏前景随页面底色切换（§6.23）
│                        onRenderProcessGone / rebuildWebView() → 渲染进程没了就换新 WebView（§6.22）
│                        onPageFinished / onPageError / onProgress / openExternal
├── WebViewFactory.kt    WebView 配置的唯一出口
│                        create(host)：JS 开关、DOM Storage、同域跳转拦截、错误回调、
│                        背景色 0xFF151517、installHomeResetOnStart()、注入 KEYBOARD_HOOK_JS
│                        HOME_RESET_JS / KEYBOARD_HOOK_JS / NO_SIDEBAR_FLASH_JS 等常量
│                        NO_SIDEBAR_FLASH_JS：禁掉侧栏首次就位的 transition（§6.27）
├── WebBridge.kt         @JavascriptInterface，注入名 "dshNative"
├── HostMatch.kt         「算不算同一个站」的唯一判据（纯 JVM，只用 java.net.URI）
│                        isSameHost(target, allowedHost)：完全相等 或 host.endsWith(".allowed")
│                        shouldOpenExternally(target, allowedHost)：只对 http(s) 生效，
│                          mailto:/tel:/about: 一律 false（否则点电话链接会把浏览器踹出来）
│                        ⚠ 以前是 url.contains(host) —— 子串包含，evil.com/?x=<host> 等三种绕过全成功
├── LanDiscovery.kt      局域网自动发现电脑（§6.31）
│                        LanScan（纯 JVM）：candidates() / looksLikePocket() / tokenOf() /
│                          rebind(old, newHost) / schemeOf() / portOf() /
│                          localIpv4() / isWifiLikeInterface() / localLanIpv4()
│                        LanDiscovery（Android）：48 并发、TCP 300ms、HTTP/1.0 命中即返回、cancel()
│                        ⚠ 钉死 /24 不按掩码展开；判据只能看正文，**不能看响应长度**
├── LanAdopt.kt          「扫到之后怎么办」的纯决策（§6.31）
│                        plan(saved, hits, port) → Adopt / AskPin / None
│                        ⚠ 多台电脑答话时绝不搬 PIN —— 有可能连到别人家机器上
├── ConnectWatchdog.kt   「这次是慢还是根本连不上」的判据（纯 JVM，§6.33）
│                        verdict(elapsed, maxProgress) / hopeless(url, onLan) / giveUpMessage(url)
│                        ⚠ hopeless 单独判「没 Wi-Fi 却连私有网段」：实测这条路上 maxProgress
│                          能到 10，光靠「进度没动」会白等满 30 秒
├── PocketStatus.kt      从 pocket.status RPC 里取公网地址（纯 JVM，§6.33）
│                        parse() / publicEndpoint()；payloadScope() 剥 RPC 信封
│                        ⚠ 字段在 result.value 里，不在顶层；按顶层取键永远拿不到
├── AutoFailover.kt      连不上时换哪一条（纯 JVM，§6.33）
│                        pickStart(all, lastUsed, onLan) / next(all, current, triedIds)
│                        ⚠ 优先换**网络类型**（LAN ↔ PUBLIC），同类另一条失败原因大概率一样
├── CookieNames.kt       「删哪类 cookie」的唯一判据（纯 JVM）
│                        AUTH_PREFIX / POCKET / selectForRemoval(all, pocket) / expiryDirective
│                        ⚠ 以前这段逻辑在 Activity 里写了两遍（clearAuthCookies 与
│                          clearPocketCookie），删错一类就把用户踢回验证页且没密码可填
├── RecoveryExecutor.kt  自愈编排（纯 JVM）：探针结果 → RecoveryAction → 动作
│                        经 RecoveryEnvironment 接口调 clear*/navigate/notifyUser/log，
│                        所以「清什么、清不清、要不要重连」全是可断言返回值
│                        RecoveryOutcome { HEALTHY, SKIPPED, ALREADY_HEALED,
│                                          ASKED_USER, CLEARED_UPSTREAM, CLEARED_POCKET }
├── ConnectionRepository.kt 档案读写接口 + SharedPrefsConnectionRepository
│                        AutoConnect.decide(lastUsed, defaultUrl, now) → Connect/Seed/ShowList
├── PageProbe.kt         页面状态判据（纯 JVM）
│                        JS_TITLE / JS_BODY（只有这两句需要真 WebView）
│                        classify(title, body) → "0"/"1"/"2"
│                        decodeJsString(raw) → 还原 evaluateJavascript 的返回值
│                        ⚠ 判据不许再写回 JS —— 那会重新变成真机试错
├── RecoveryPlanner.kt   页面坏了该怎么修的决策中心（**纯 JVM，不碰 android.net.Uri**）
│                        PageState { HEALTHY, HANDSHAKE_BROKEN, PIN_REQUIRED, UNKNOWN }
│                        RecoveryAction { NONE, CLEAR_UPSTREAM_COOKIE,
│                                         CLEAR_POCKET_COOKIE, ASK_USER }
│                        fromProbe('0'/'1'/'2') / plan(state, url) / hasPinToken(url)
│                        withRetry(url) → 幂等加 dsh-pocket-retry=1，**必须插在 # 之前**
│                        ⚠ 铁律：URL 里没有 ?token= 时**不许**清 dsh_pocket_token，
│                          否则用户被永久锁在「访问验证」页外（单测钉住）
├── ScanActivity.kt      CameraX 预览 + ZXing 解码，只认真 http(s) 结果
├── BootstrapUrl.kt      host+PIN → 完整 URL（纯 JDK）。Gradle 只注入两个原始字段，
│                        **拼装只在这里做一次**，别再在 build.gradle.kts 里重写一遍
│                        （踩过：Gradle 那份拼漏 ?token=，App 静默落到「访问验证」页）
├── EndpointTest.kt      24 条单测：解析、序列化往返、脏数据容错、id 稳定性、
│                          入口类型推断（网段边界 / IPv6 私有 / CGNAT / mapped-v4）、
│                          4 列老数据的升级兼容
├── BootstrapUrlTest.kt  10 条单测：拼接、scheme/尾斜杠容错、空值返回 null、
│                          旧 ?token= 不叠加、PIN 特殊字符编码
├── CookieNamesTest.kt   10 条单测：删哪类 cookie（前缀精确匹配 / 值里出现名字不算 /
│                          junk 段容错 / 过期指令只作用一个名字）
├── AutoConnectTest.kt    7 条单测：lastUsed 优先、无内置地址宁可停在列表也不 loadUrl 空串、
│                          seed 的 kind 由 URL 推断、不改写已拼好的地址
├── PageProbeTest.kt     20 条单测：六种页面形态 + 优先级（主界面 > 故障 > PIN）、
│                          长正文、null 兜底、evaluateJavascript 返回值还原（\\uXXXX / null / 转义）
├── HostMatchTest.kt     17 条单测：判同域（完全相等 / 带路径 query / 大小写 / 尾点 / 子域 / 局域网 IP）
│                          与 **6 条反面用例**（host 出现在 query / fragment / 子域后缀 /
│                          路径段 / 相似域名 evilexample.com / 完全不同的 host 都必须判外链）
├── RecoveryExecutorTest.kt 12 条单测：FakeEnv 记录副作用，钉住「没有 token 时绝不清 pocket
│                          cookie」「ASK_USER 不重放 Toast」「退避与单轮额度」
└── RecoveryPlannerTest.kt 14 条单测：fromProbe 映射、plan 分支穷举、hasPinToken
                           只认 query 里的 token、withRetry 幂等与 fragment 位置
```

`androidTest/PageProbeJsTest.kt`：7 条**真机**用例，验 `PageProbe.JS_TITLE` / `JS_BODY`
在真 WebView 里能不能把中文标题与正文原样取回（转义、`display:none` 跳过、`about:blank`）。
跑法：

```
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk   # -t 不能省
adb shell am instrument -w -r -e class com.dsh.remote.PageProbeJsTest \\
    com.dsh.remote.test/androidx.test.runner.AndroidJUnitRunner
```

> 判据为什么拆两半：**取值**只有真 WebView 能验（`PageProbeJsTest`），
> **判状态**是纯函数（`PageProbeTest` 20 条）。判错要删用户 cookie，不能靠真机试错。

`res/values/`：`page_dark = #151517`（**必须与 DSH 页面 body 同色**，见 §6.2）、`surface`、`ink`、`ink_dim`、`brand`。
`AndroidManifest.xml`：`INTERNET`、`usesCleartextTraffic="true"`（目标是局域网 http 明文）、`network_security_config`。

`res/xml/network_security_config.xml`：**全局允许明文**（不是只放行某个 IP）。
原因写在该文件注释里：`<domain>` 只接受具体主机名、**不支持 CIDR**，钉死一个私网 IP 等于换个网段
就莫名其妙连不上，且失败现场是一条与被访问地址毫无关联的明文/SSL 错误。
收紧的正确方向是让 dsh-pocket 走 https，不是在这里钉 IP。

---

## 5. 键盘避让：为什么由页面驱动而不是原生（核心设计，别改回去）

**症状**：点输入框，键盘滑上来，界面跟着缩，但速度对不上 —— 界面一跳一跳地追，中间露出底色（用户原话「一闪的留白」）。

**原因（同钟对齐实测，`tools/measure-sync.cjs`）**：原生每帧改 WebView 高度，322px 位移在原生侧 456ms 均匀走完（约 7ms/帧）；
但页面 `window.innerHeight` 只变了 19 次，约 **108ms 一跳、全程 897ms**。
→ **WebView 把尺寸变化按批合并提交，原生怎么补间都追不上。**

**反过来验**（`tools/test-page-drive.cjs`）：页面自己用 rAF 改 `#root.style.height`，帧间隔中位数 12~20ms；
且 `#root` 高度减多少、输入框就上移多少，**与原生压 WebView 完全等效、比例 1:1**。

**所以分工是**：

- WebView **全程保持全屏，不缩**。
- 原生在动画开始第一帧把「键盘最终多高」**只推一次**过去（跨进程调用不能每帧发）。
- 页面用 rAF 补间 `#root` 高度，曲线 `1-(1-t)^5`。

**曲线来源（不是估的）**：`dumpsys window windows` → 输入法窗口 `wanim=0x1030056` → `style/Animation.InputMethod`
→ `res/anim/input_method_enter.xml`（`duration=300`、`interpolator=@0x010c0005`）
→ `res/interpolator/decelerate_quint`（`factor=2.5`）→ `1-(1-t)^5`。

**实测结果**：

| 方向 | 位移帧数 | 帧间隔中位数 | 全程 | 单调 |
|---|---|---|---|---|
| 修复前 | 19 | 108ms | 897ms | — |
| 弹出 | 22 | **8ms** | **195ms** | 是 |
| 收起 | 9 | ~14ms | ~170ms | 是 |

---

## 6. 踩坑清单（全部已解决，防重犯）

### 6.1 JVM 单测里 `android.net.Uri` 是 stub
`Uri.parse` 直接抛 `Stub!`。`Endpoint.kt` 因此改成纯 JDK（`java.net.URI` + 手写规范化），换来可测性。

### 6.2 所有原生侧底色必须等于 DSH 页面底色 `#151517`
`windowBackground`、WebView 背景色、容器底色三处都要对齐。差一点就在键盘动画期间露出一帧别的颜色。
（`probe-bg.cjs` 实测 `bodyBg="rgb(21,21,23)"`；注意**录屏里的颜色是被 MIUI 抬过的 `rgb(29,29,29)`**，
做像素判据时要用录屏实色，不是页面色 —— 这条坑过一次，扫描全零。）

### 6.3 `WindowInsetsAnimationCompat` 的两个值来源，别搞反
- `onProgress` 给动画**中间态**（0→94→185→279→…→884）。
- `setOnApplyWindowInsetsListener` 给**终值**，且动画第一帧就是终值。

我一开始屏蔽终值、信任中间态，结果每帧改一次目标，页面补间被反复重启 —— 这才是「不同步」的真因。
`tools/trace-keyboard-calls.cjs` 打出的 `h=321.8 → h=0 → 34.2 → 67.3 → …` 序列才把它揪出来。
**正确做法：只认终值，`onProgress` 一律 `return insets`，且第一帧认定后用 `keyboardCommitted` 锁住。**

### 6.4 `WindowInsetsAnimationCompat` 没有 `lowerBound` / `upperBound`
javap 查 `androidx.core:core:1.15.0` 实际只有 `getTypeMask/getFraction/getInterpolatedFraction/getInterpolator/getDurationMillis/setFraction/getAlpha/setAlpha`。
要拿终值走 `ViewCompat.getRootWindowInsets(root)`。
另：`WindowInsetsAnimationCompat.setCallback(...)` 是 **package-private**，Kotlin 报 `it is package-private`，必须走 `ViewCompat.setWindowInsetsAnimationCallback(...)`。

### 6.5 单位：原生 insets 是设备像素，页面 CSS 是 CSS px
本机 885 设备像素对应 322 CSS px，`density = 2.748`。
忘了除会算出 `895 - 885 = 10px`，布局直接崩。`notifyPageKeyboard()` 和 `WebBridge.keyboardHeight()` 都必须除。

### 6.6 首页重置只能靠 document-start
DSH 前端在模块初始化时**同步**读 `localStorage['dsh.sessions.current']` 来恢复上次会话。
`onPageFinished` 太晚（旧对话已经渲染，删键要再刷一次，会先闪一下旧对话）。
用 `WebViewCompat.addDocumentStartJavaScript(wv, HOME_RESET_JS, setOf("*"))` + 双层一次性标记
（`window.__dshHomeReset` + `sessionStorage.__dshHomeReset`）：冷启动进主界面，进程内点进会话再返回不会被踢回主界面。
需要依赖 `androidx.webkit:webkit:1.12.0`，且先 `WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)`。

### 6.7 本机屏幕录制是坏的，调试必须走 CDP
`adb shell screenrecord` 退出码 235、落盘 0 字节（MTK `c2.mtk.avc.encoder` 起不来，`Qinput: 0, DQinput: 0 success out of 0 tries`），
任何时长/分辨率/输出格式都一样。`screencap` 单帧 1.5s，也采不到 300ms 动画。
→ 用 `tools/` 下的 CDP 脚本。`page.tracing` 与 `Page.captureScreenshot` 可用。

### 6.8 CDP 转发每次重装都要重建
App 重装后 `webview_devtools_remote_<pid>` 名字会变。
`cat /proc/net/unix | grep webview_devtools_remote` 会返回**两条**，必须选**不带 `browser_` 前缀**的那条，再 `adb forward tcp:9222 localabstract:<name>`。
直接跑 `node tools/cdp-forward.cjs` 会自动做这件事。

### 6.9 `adb shell input text` 在中文输入法下吞字符
`http` 会变成 `p://`，分字符注入也失败。所以 App 里有「填入本机示例」按钮（读 `DEFAULT_LAN_URL`，值为构建时注入），
地址由代码写，不经过输入法。**按钮只在注入值非空时出现** —— 给用户一个空串「填入」比没有按钮更糟。

### 6.10 `adb input tap` 坐标要按密度换算
CSS px × `(1080 / window.innerWidth)` = ×2.748。用 CSS 值直接点会全部落空。
`element.focus()` 在 Android WebView **不唤**系统键盘，必须真实触摸。

**注意**：坐标换算对了也没用 —— 这台 MIUI 会拒绝 `input tap` 的注入，见 §6.18，
真机点击一律走 `tools/tap.cjs`（`monkey -f`）。

### 6.11 截图会骗人
全黑有三种不同原因：屏幕睡眠（`isSleeping=true`）、通知栏 `NotificationShade` 抢焦点（`cmd statusbar collapse`）、WebView 渲染时序。
可靠判据是 `uiautomator dump` 控件树 + chromium CONSOLE 日志的来源 URL，不是截图。

### 6.12 写文件后必须回读
曾误删 `WebViewFactory.kt` 里 `override fun shouldOverrideUrlLoading(` 的签名行，还把 `webViewClient` 覆盖成空对象。

### 6.13 「访问验证」页自愈的三条铁律（真机验过，别再踩）

**根因在上游**：`dsh-pocket` 的 `lib/proxy.mjs:509-525` `maybeSeedAuthCookie` 第一行就是
`if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;` ——
**只要请求里带一个哪怕已失效的 `dsh_pocket_token`，代理就永不下发新的。**
而它的值是 `sha256(PIN:sessionKey)`，`sessionKey` 是 dsh web 的进程级随机数
（`lib/index.js:331-333`，不落盘），Harness 每重启一次就换新 → 手机上那枚必然失配。
表现就是「URL 里带着 token，却还是停在访问验证页」。

1. **只有 URL 的 query 里确实还带 `?token=` 时，才允许清 `dsh_pocket_token`。**
   没有 token 就清，用户被永久锁死在那个页面外 —— 它没有密码输入框。
   由 `RecoveryPlanner.plan()` 的 `ASK_USER` 分支守住，单测钉死。
2. **`dsh-pocket-retry=1` 必须插在 `#` 之前。** 拼到末尾会落进 fragment，
   服务端收不到，握手计数（按客户端 IP，3 次/60 秒）清不掉，重连撞 503「无法完成登录握手」。
3. **验证必须"同一进程内"做。** `Network.setCookie` 只写进 WebView 活的 cookie store；
   杀进程后 WebView 从磁盘 Cookies 库恢复旧的好值，「重启 App」这个动作反而把故障抹掉，
   于是「看起来自愈成功了」其实是假象。
   → 用 `tools/verify-selfheal-net.cjs`：同一条 CDP 连接里弄脏 → `Page.navigate` → 抓网络事件，
   判据是「出现同时带 `dsh-pocket-retry` 与 `token=` 的那一跳」。

### 6.14 截图：PowerShell 重定向会毁掉 PNG
`adb exec-out screencap -p > file.png` 会把 PNG 里的 LF 改成 CRLF，产出坏图
（`read_image` 报 `Unsupported or malformed image data`）。
必须 `adb shell screencap -p /sdcard/shot.png` 再 `adb pull`。

### 6.15 真机换了台，别照着旧序列号敲
当前验证机是 **motorola XT2335-3 / Android 14 / `ZY22GHMK5F`**，WebView **117.0.5938.60**。
旧记录里的 `8PCE7LJB99VG7TRO`（Redmi Note 12T Pro / Android 15）不是主用机。
`POLYFILL_JS` 之所以存在，正是因为这台机器 WebView 只有 117（缺 `Promise.withResolvers`）。

**但公网 4G 那次是 Redmi `8PCE7LJB99VG7TRO` 一次通过的**：同场景下 XT2335-3 页面黑屏后从 adb 掉线。
两台机器都可以用，量真机行为时**先说清用的是哪台**，别把一台的结论搬到另一台。

### 6.16 无线调试（`adb pair`）在这台 Windows 上走不通
配对能成功拿 `guid`，但 `adb connect` 恒 `offline`；全端口扫描只有 `51688` 一个口开放且
配对前后一致（不像临时端口）；mDNS 发现也因为 UDP 5353 被 `svchost` 与 adb 自己抢而不可靠。
**用 USB。** 别在这条路上继续投时间。

### 6.17 公网隧道：地址不落盘，重开必变
`~/.dsh/dsh-pocket/tunnel-auto.json` 只有 `{"at":<ts>}`，**不记 URL**；整个 `~/.dsh/dsh-pocket/`
目录下没有任何文件含 `trycloudflare` 字符串。所以：
- 隧道重开后地址一定变，必须回设置页重新读 URL + PIN；
- 想自动化就别指望读配置文件，走 `pocket.status` / `tunnel.start` RPC。
- 设置页首次点「开启公网访问」可能失败并留 `❌ 开启失败：隧道进程退出（code=4294967295）`
  （`code` 是 -1，进程被杀的通用码，`dsh-pocket/lib/service.mjs:347`）。
  **复位办法**：点 `关闭公网` 让按钮回到「开启公网访问」，再点一次。

### 6.18 断网恢复后「点连接没反应」是**假象**——MIUI 拦掉了 `input tap`

**这条当初记错了，结论已推翻，按新结论执行。**

飞行模式下启动会正确报 `net::ERR_INTERNET_DISCONNECTED` 并退回列表（不黑屏，这是对的）。
当初看到「恢复网络后点同一行没反应、必须 `am force-stop` 重启」，于是怀疑 WebView
错误页把 `loadUrl` 短路了 —— **这个判断是错的**。

真因：**MIUI（本机 Android 15）拒绝 `adb shell input tap` 的触摸注入**，事件根本没进 App。
logcat 里是：
```
W MIUIInput: Input event injection from package: null action ACTION_DOWN
D InputManager: injectMotionEvent: 6369-{action=ACTION_DOWN, ... x[0]=540.0, y[0]=613.0 ...}
W InputManager: Input event injection from pid 6369 failed.
```
`input tap` / `input touchscreen tap` / `input swipe` / `input motionevent` / `sendevent`
在这台机器上全部无效（`sendevent` 还会 `Permission denied`），而 **`input keyevent` 有效**
（`KEYCODE_HOME` 能回桌面）—— 所以「adb 能用」这个假象特别容易骗人。

**正确做法：用 `monkey -f` 精确注入**，见 §6.19 和 `tools/tap.cjs`。

用 `monkey` 重测后的实况（修复前后都一样）：
- 离线启动 → 恢复网络 → 点同一行：**一次就进主界面**，出现 2 个 Document 请求
  （`?token=…` → `/`），`title=DeepSeek Harness`；
- 主界面正常时断网再恢复：页面一直是主界面，不需要任何操作。

教训：**在 Android 上验证「点击有没有生效」之前，先证明注入本身是通的**
（点一个必定有可见副作用的控件，或看 logcat 有没有 `injection ... failed`）。
否则所有「点了没反应」都是假阴性。

### 6.19 真机上可靠点击：`monkey -f` 而不是 `input tap`

```powershell
node .\tools\tap.cjs 540 613 8PCE7LJB99VG7TRO   # 坐标 + 序列号
```
内部做的事：把 `DispatchPointer(...)` 脚本 base64 送进 `/data/local/tmp/tap.txt`，
再 `monkey -p com.dsh.remote -f /data/local/tmp/tap.txt -v 6`。

两个必须知道的点：
- **判据只看 `Events injected` 是否非 0**。末尾那行 `Dropped: keys=0 pointers=1` 在点击
  **正常生效**时也会出现 pointers=1，拿它判断会误报失败。
- `monkey` 会先起一个 LAUNCHER Intent，把 App 带到前台。所以用它点击前，
  App 必须已经停在你要点的那个界面（不会被它重置状态）。

坐标用 `uiautomator dump` 拿 `bounds` 再取中心，别按逻辑像素硬猜（§6.10）。

### 6.20 返回首页**不能展开侧栏**——屏外元素 `click()` 照样生效

`WebViewFactory.DSH_GO_HOME_JS` 的旧实现是「点顶部开关展开侧栏 → 等 `.wtg9ga_newSession`
进屏幕 → 再点它」。中间那一步纯属多余，用户在滑动返回时会看到**一条黑边横扫屏幕**
（侧栏滑出再收回），这就是「闪屏 / 侧边栏闪动」的真身。

**关键事实（真机实测，推翻旧注释）**：收起态下 `.wtg9ga_newSession` 的 `left = -207`（屏幕外），
但直接 `ns.click()` 就能回首页。原因：DOM 的 `click()` 派发合成事件，**不经过命中测试**。
旧注释里「left 是负数所以 click 无效」是错的——当时用坐标点击验证，屏外坐标本来就点不到，
把「坐标点不到」误当成「click 无效」。

三条硬约束：
1. **`DIRECT_MS` 必须 ≥ 2400**。真机实测从点击到页面切完要**约 1996ms**（54 次 25ms 轮询），
   留 900ms 会误判「点了没反应」而走上兜底（= 把侧栏滑出来），等于白改。
2. **`reachedHome()` 必须先判会话页再判首页**。会话页 DOM 里同时留着「探索未至之境」
   （idx 9633）与「描述你想要构建的内容」（idx 9661），先判首页会把会话页误认成首页 →
   函数直接 return → **返回键完全没反应**。正确顺序是先 `tabs = 对话 && 轨迹`，`tabs` 为真直接 false。
3. 兜底路径（展开侧栏）保留但只在前两条都不成立时才走，`FALLBACK_MS = 2600` 封顶。

验证方式：`node tools/record-back.cjs 9240 16 80` 连拍，看 `sideL` 是否全程 `-217` 不动；
只要中途出现 `sideL=0` 就说明还在走展开侧栏那条路。截图见
`build-artifacts/back-frames/frame-005.jpg`（干净的首页）与 `frame-001/002.jpg`（修复前的闪屏）。

### 6.21 判同域一律走 `HostMatch`，**别再写 `url.contains(host)`**

旧实现在 `WebViewFactory.kt:53` 用 `url.contains(endpointHost)` 判同域，那是**子串包含**。
真机实测三种绕过全部成功：`https://evil.com/?x=<host>`、`https://<host>.evil.com/steal`、
`https://evil.com/#<host>` —— 外部整页留在没有地址栏的 WebView 里，外面还挂着 `dshNative` JS 桥。

铁律：
1. 判同域、判外链**只能**调 `HostMatch.isSameHost` / `HostMatch.shouldOpenExternally`。
2. `shouldOpenExternally` 只对 `http://` / `https://` 生效，`mailto:` / `tel:` / `about:` 必须返回 false
   （否则点电话链接会把浏览器踹出来）。
3. 允许子域（`host.endsWith(".$allow")`）是刻意的：quick tunnel 每次重开换一个
   `*.trycloudflare.com` 子域。点边界保证 `evilexample.com` 不算 `example.com` 的子域。
4. `HostMatch` 里**只用 `java.net.URI`**（经 `Endpoint.hostOf`），不要用 `android.net.Uri` ——
   后者在 JVM 单测里是空实现，`host` 恒为 null，测试会全绿但真机行为相反。

验证：`HostMatchTest` 17 条，其中 6 条反面用例价值最大。真机复验方法是在页面里插一个
`<a href="https://example.com/?x=<当前host>">` 再 `.click()`，看 `topResumedActivity` 是否变成浏览器。

### 6.22 渲染进程被回收后 App 会跟着死 —— 必须覆盖 `onRenderProcessGone`

不覆盖 `WebViewClient.onRenderProcessGone` 时，系统的默认兜底是**杀掉宿主进程**，用户看到闪退。
这台机器上渲染进程被清是常态（第 7e 步 logcat：`ProcessSceneCleaner: SwipeUpClean: kill procName=…:sandboxed_process0:…`）。

三条约束：
1. 回调里**必须 return true**，否则系统的杀进程兜底照样生效。
2. 死掉的 WebView **不能复用**：它的 `loadUrl` 不报错也不加载。只能按
   `onDestroy` 的顺序销毁（`removeJavascriptInterface` 那一步不能省）再 `WebViewFactory.create` 一个新的。
3. 新实例要插在 `progress` **之前**，否则进度条会被整页 WebView 盖住。

**怎么验**：`pkill -9 -f sandboxed_process0` 会得到 `Operation not permitted`（非 root 杀不掉沙箱进程）。
唯一可靠触发是 CDP 的 `Page.crash` —— `node tools/crash-page.cjs <cdpPort>`。
判据三条：App 的 `pidof` 不变、logcat 出现 `render process gone (didCrash=true), rebuilding webview`、
页面自己回到主界面。日志出现两次是正常的（`Page.crash` 让进程崩了两次）。

### 6.23 edge-to-edge 下状态栏前景必须跟着页面底色切

`themes.xml` 里的 `android:windowLightStatusBar` 是**静态值**，只在启动那一刻生效。
本项目 `WindowCompat.setDecorFitsSystemWindows(window, false)` 之后状态栏底下就是页面本身，
页面是深色（实测状态栏区域亮度 `p50=21`）而图标也是深色 → 时间电量看不见。

铁律：页面**进/出**两处各调一次 `MainActivity.applyBarIconTheme(darkBackground)`（`connect()` 传 true、
`showList()` 传 false），内部用 `WindowCompat.getInsetsController` 同时设
`isAppearanceLightStatusBars` 与 `isAppearanceLightNavigationBars`。
不要改成在主题里写死 —— 列表页是白底，写死必然坏一半。

### 6.24 SamSung/摩托罗拉**应用分身**里也有同名包，会弹「选择要使用的应用程序」

装完新 APK 后点图标弹选择器、桌面出现 3 个同名图标时，先查用户：

```
adb shell pm list users                             # 会看到 UserInfo{0:机主} + 900/901 应用分身
adb shell pm list packages --user 900 | grep <pkg>  # 命中的话这就是元凶
adb shell pm uninstall --user 900 <pkg>             # 每个分身用户都清一遍
```

不要先怀疑 `am start` 的写法 —— `topResumedActivity=android/com.android.internal.app.ResolverActivity`
就说明是**系统在选择器阶段**，跟 Activity 名对不对无关。

**注意 `adb install -r` 会把分身里的包一起装回来**（默认对所有用户安装）。
所以每次重装之后都要么再清一遍分身，要么干脆只装给 user 0：

```
adb shell pm install -r --user 0 <apk>     # 只装主用户
```

判据：`am start` 之后 `topResumedActivity` 直接是 `com.dsh.remote/.MainActivity`，
而不是 `ResolverActivity`。

### 6.25 工具脚本不许写死设备序列号，也不许依赖设备上的残留文件

第 17 步回归时，两处工具缺陷各骗了一次人，都是「工具跑错」被读成「App 坏了」：

1. 六个脚本把序列号写死成 `8PCE7LJB99VG7TRO`（那台 Redmi 已下线），
   换到 `ZY22GHMK5F` 后一律 `device 'xxx' not found`。
2. `record-back.cjs` 读 `/data/local/tmp/swipe.txt`，那个文件是上一台机器留下的，
   新机器上没有 → `monkey` 报错，看着像「手势不生效」。

现在统一走 `tools/device.cjs`：

```js
const { ADB, resolveSerial } = require('./device.cjs');
const DEV = resolveSerial(process.env.DEV_SERIAL);   // 参数 > DEV_SERIAL > 唯一一台
```

解析不到就报错退出，**不要写「猜第一台」** —— 多设备时猜错比报错代价大得多。
手势类脚本现场用 base64 生成到 `/data/local/tmp/` 再喂给 `monkey`，不依赖任何预置文件。

### 6.26 验证脚本必须先自查前提，否则会给出假阴性

`tools/verify-ask-user.cjs` 验的是「地址里没有 token 时不许动 cookie」。
第一次跑时端点还带着 `?token=`，于是自愈走了 `CLEAR_POCKET_COOKIE` 并成功恢复主界面，
三项判据全判❌ —— **那恰恰说明自愈是对的**，结论完全反了。

现在脚本开跑前直接 `run-as` 读 `shared_prefs/dsh_endpoints.xml`，
端点全带 token 就 `exit 2` 并说明原因。判据不能看页面当前 URL：
页面加载完已经是干净的 `origin/`，token 早被消费掉了。

推广到所有验证脚本：**先断言「这次跑的前提成立」，再断言「结果对不对」**。
前提不成立时给非零退出码，让人一眼看出是没匹配上而不是失败。

### 6.27 启动时侧栏闪一下 = 页面的 CSS 过渡，不是我们的代码

现象：冷启动约 3.1 秒，移动端 frame 的侧栏列从 `left=0`（整个露在屏幕里）
用一条 `transform 0.28s cubic-bezier(0.4,0,0.2,1)` 收到 `-209`。那 280ms 就是「闪一下」。

根因：`data-sidebar-collapsed="true"` 在**首帧就已经在 DOM 上**，但页面要等 hydration
之后才把 `transform: matrix(…,-208.337,0)` 写上去。**DOM 属性先到、样式后到**，中间这段就是「展开了又收回去」。

修法（`WebViewFactory.kt` 的 `NO_SIDEBAR_FLASH_JS`，走 document-start）：
```css
[data-mobile-nav="frame"] [class*="_sidebarCol"],
[data-mobile-nav="frame"] [class*="_rightbarCol"] { transition:none !important; animation:none !important }
```

四条铁律：

1. **别去改 `DSH_GO_HOME_JS`** —— 启动路径根本不调它（只有按返回键才调），
   而且它入口有 `reachedHome()` 保护。改它只会把返回键弄坏，对启动闪动毫无作用。
2. **只禁 transition，不写死 transform** —— 位置该由页面决定，我们只让它「不带动画地就位」。
   页面以后改侧栏宽度、用户手动展开都不受影响。
3. **选择器不许写死完整类名** —— 实测是 `mP3x-q_sidebarCol`，`mP3x-q_` 前缀随 DSH 构建变化，
   `_sidebarCol` 后缀是稳定语义命名。要写 `[class*="_sidebarCol"]`。
4. **必须 document-start** —— 过渡 3139ms 起、3463ms 结束，`onPageFinished` 再注入完全错过。
   另外 document-start 时 `document.documentElement` 可能是 `null`，
   取父节点要三级回落 `head || documentElement || getElementsByTagName('html')[0]`，
   否则 `appendChild` 抛错会让后面的监听器全部注册不上，表现为「注入了但没生效」。

验证：`node tools/probe-startup.cjs 9222 14000 40`，判据是 `sideL >= -60` 的帧数为 0。
修复前 1 帧，修复后连跑两轮都是 0。

### 6.28 返回键必须「一次只退一层」，页面有七层

用户口径：`返回与进入严格互逆，不能缺少步骤也不能多，无论进入哪个功能项都如此`。

七层与判据（**顺序即层级，不许改**，`WebViewFactory.DSH_LOCATION_JS`）：

| 层 | 判据 | 退法 |
|---|---|---|
| `panel` | 可见的「关闭xxx」`button`/`[role=button]` | `DSH_CLOSE_PANEL_JS` 点它 |
| `overlay` | 可见的 `[role=menu]/[role=listbox]/[role=dialog]` | `DSH_PRESS_ESCAPE_JS` |
| `sidebar` | `[class*="_sidebarCol"]` 的 `left > -40`（收起 -209 / 展开 0） | `DSH_PRESS_ESCAPE_JS` |
| `session` | 正文同时含「对话」与「轨迹」 | `DSH_GO_HOME_JS` |
| `feature` | `[aria-current]` 或 `[aria-selected=true]` 且文案非「新会话」 | `DSH_GO_HOME_JS` |
| `home` | `探索未至之境` / `描述你想要构建的内容` / `发消息或创建任务` / `选择一个工作区开始` | **`finish()`** |
| `other` | 其它 | 退过就 `finish()`，没退过先回首页 |

五条铁律：

1. **`session` 必须排在 `feature` 之前** —— 会话页也有 `aria-selected="true"`（「对话」那个 tab），
   先判 feature 会把会话页误认成功能视图（首轮就这么判错过）。
2. **只有 `home` 才退出 App**。旧版把「首页 + 侧栏展开」直接退出（实测 `topResumedActivity` 变 launcher），
   就是典型的多退一层。
3. **`Escape` 管不了 panel 和 session** —— 实测 `layerN 0→2→2` 与 `tabs` 不变，这两层必须我们动手。
4. **`DSH_GO_HOME_JS` 不用改** —— 上一版担心「侧栏已收起时点不到新会话」，第 18 步已实测
   屏外元素 `click()` 照样生效（§6.20）。
5. **`visible(el)` 四判缺一不可**：`display!=='none' && visibility!=='hidden' && opacity>=0.05 && r.width>8 && r.height>8`。
   少判一个就会把 `opacity:0` 的隐藏浮层当成还开着，返回键连按两次都没反应。

验证：`node tools/verify-back-layers.cjs 9222`，7 个场景全过才算通过。**这个脚本自己踩过四个坑，别重犯**：
- CDP 转发要随 pid 重建（`am force-stop` 后端口名变，不重建每条求值吃满 8 秒超时，看着像卡死）；
- 判前台只能读 `topResumedActivity` 那一行（整段 `dumpsys` 里留着历史 `ActivityRecord`，会导致拿后台冻结的 WebView 空转）；
- 构造没成功不许判产品对错（每个构造步骤后断言期望层已出现，失败就打印「构造失败，跳过」）；
- 功能页入口不在侧栏，在侧栏「更多」菜单里（侧栏只有 `打开侧边栏/新建会话/更多/搜索会话/展开会话知识库/导出会话日志/账号菜单`）。

排查时先看日志：`adb logcat | Select-String 'DshRemote: back:'`，格式 `back: layer=… action=…`。

### 6.29 第二台手机装机与收更新：三条前提缺一不可

需求是「另一部装了这软件的手机也能收到更新」。做不到的原因几乎永远是下面三条之一，
而且**每条都表现为「装不上」，但真实原因完全不同**，别混着猜：

1. **签名不一致** → 只能卸载重装（连接列表全丢）。
   现在 `app/build.gradle.kts` 的 `releaseLocal` 用 `~/.android/debug.keystore`，
   实测 debug 与 release 两个包的 `apksigner verify --print-certs` 都是
   `SHA-256 ca77c1d16e8149d147caa61f9d5b57360338fb8ed3c8888d8be305c8102c8afc`，能互相覆盖。
   **一旦换成自己的 keystore，手机上那个包就再也覆盖不上了** —— 要么先卸载，要么永远用同一张。
2. **versionCode 下降** → 同样只能卸载重装。
   所以版本号**不能**用 `git rev-list --count HEAD`：CI 浅克隆会算成 1。
   现在唯一来源是仓库根的 `version.properties`（`versionCode=2 / versionName=0.2.0`），
   `-Pdsh.versionCode=` 可临时覆盖。发版前 `node tools/publish-apk.cjs --bump patch`。
3. **手机根本拿不到 APK** → 用 `tools/serve-apk.cjs` 起局域网下载页（默认 8123），
   另一台手机同一 Wi-Fi 下浏览器打开 `http://<本机IP>:8123/` 即可。
   手机侧没有 `wget`（`toybox: Unknown command wget`），验证连通性用 `curl`。

分发链路（都已固化成脚本）：

```powershell
node tools\publish-apk.cjs --bump patch   # 版本 +1 → 构建 release → 发到 dist/
node tools\serve-apk.cjs                  # 起 8123，打印本机局域网地址
```

`dist/` 内容：`dsh-remote-<ver>-<code>.apk`（稳定名，便于肉眼区分）、
`dsh-remote-latest.apk`（固定名）、`latest.json`（版本/大小/SHA-256/构建时间）、`index.html`（自包含下载页）。
`dist/` 已 gitignore；服务器只服务局域网、无鉴权，**不要转公网**。

**装 release 而不是 debug**：debug 包 7.3 MB 带 `debuggable` 且开着 WebView 调试，
release 1.8 MB、R8 过一遍。日常用 release，只有抓 CDP 时才临时换 debug。

实测验证（2026-11-02）：`dist/dsh-remote-0.2.0-2.apk` 1,930,818 B，
手机侧 `curl` 下载后 `sha256sum` 与 `latest.json` 完全一致
（`42db6a9bfbe18e053f354cbaac05e9f0294d5012bf5cb1281ceb2a8bdac2048f`），
`adb install -r` 覆盖安装 `Success`，`aapt2 dump badging` 显示 `versionCode='2' versionName='0.2.0'`。

### 6.30 GitHub Release 发版：手机只认一个固定网址

`serve-apk.cjs` 那套要求电脑开着、同一 Wi-Fi。给「另一台日常用的手机」更省事的是
GitHub Release —— 手机存一个书签，永远下最新：

```
https://github.com/<owner>/<repo>/releases/latest/download/dsh-remote-latest.apk
```

`latest/download/<固定文件名>` 是 GitHub 的稳定重定向：**asset 名必须保持
`dsh-remote-latest.apk` 不变**。换了名字这个链接就 404，而手机上表现成「下载失败」，
没人会想到是名字改了。

流水线：`node tools/publish-release.cjs --bump patch` 升版本 → 手动提交 version.properties →
`node tools/publish-release.cjs --no-bump` 打 tag 并推送 → [release.yml](.github/workflows/release.yml) 构建发布。

**release.yml 里三条不可省的检查**（缺任何一条都会产出「看起来成功、装上却不对」的包）：

1. **tag 必须等于 `v` + `versionName`**。否则 Release 页写 v0.2.1、包里是 0.2.0，
   而 Android 只认 versionCode，出问题时靠版本号对不上号。
2. **四个签名 secret 缺一个就 fail**（`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`）。
   缺了 `build.gradle.kts` 会**静默回落**到 debug keystore，而 runner 上根本没生成过
   `~/.android/debug.keystore`，最后只产出 `app-release-unsigned.apk`。
3. **`apksigner verify --print-certs` 必须过**，并且要检查产物存在。
   AGP 在签不出来时**不报错**，只是把产物改名成 `-unsigned`。

签名材料：`release/dsh-remote.jks`（`CN=DSH Remote`，RSA 4096，10000 天）。
`local.properties` 里配 `dsh.releaseStoreFile` 等四项后本机也用它；CI 用 secrets 里的同一份。
**`release/` 已 gitignore，必须自己另存一份备份** —— 丢了就再也发不出能覆盖装到现有手机的包。

实测（2026-11-02）：新 keystore 构建后
`apksigner verify --print-certs` → `V2 Signer: certificate DN: CN=DSH Remote, OU=Personal, O=Personal, L=Local, C=CN`，
`SHA-256 12912cf905c2691dbf9d97e72a4e7322c61f1c1dad10b5385f2a65e9d08532b0`。
**注意这意味着 debug 包与 release 包不再能互相覆盖** —— 手机上若还装着旧 debug 证书的版本，
换到新证书的 release 必须先卸载一次。

**已落地**：仓库 `https://github.com/Lisa4916/dsh-mobile-app`（public）。
已发布三个版本，手机端固定地址一直没变：

| 版本 | 产物大小 | SHA-256（`dsh-remote-latest.apk`） |
|---|---|---|
| `v0.2.0` | 1,930,818 B | `b10f01536c8a187be776d618c4bd9084421453e3e6f95bf5b4a6ce85cd2770f8` |
| `v0.3.0` | 1,930,946 B | `0904cdf3221120e27ec666939b33ca8da6da9f3d3d9339d0132ef368326aa1cc` |
| `v0.4.0`（当前） | 1,930,950 B | `8d791d29ac331193929e7b0a1df060ccb1c73a12e7c210aa9b29afbad2b68abd` |

固定地址始终 `200`，下载字节数与 `SHA256SUMS.txt` **逐字节一致**。

#### 首次跑 CI 撞的三个坑（都是真失败，不是环境抖动）

1. **`setup-android` 默认的 `tools` 包已被移除。** `android-actions/setup-android@v3`
   默认 `packages: tools platform-tools`，cmdline-tools 16.0 里没有 `tools`：
   `Warning: Failed to find package 'tools'` → `sdkmanager` exit 1 → **三个 job 全卡在
   Set up Android SDK**。必须显式 `packages: 'platform-tools'`。
2. **`apksigner` 不在 PATH 上。** 它在 **build-tools**，不在 platform-tools；
   setup 步骤只装 platform-tools 时，Verify 步骤会 `apksigner: command not found`（exit 127）。
   从 `$ANDROID_HOME/build-tools/*/apksigner` 取 `sort -V | tail -n1`，找不到就报错并列目录。
3. **`github.com:443` 的 TLS 可能整体不可用，而 API 正常。** 本机 `github.com` 解析到
   `198.18.0.13`（代理 fake-IP），`api.github.com` / `codeload` / `raw.githubusercontent.com`
   都通，唯独 `github.com` 直连、HTTP 代理、SOCKS5、换 `--resolve` 指定官方 IP 全部
   `schannel: failed to receive handshake` / `OpenSSL: unexpected eof while reading`。
   这时 `git push` / `git ls-remote` 一律不可用，但 **`https://api.github.com` 完全正常** ——
   改用 Git Data API 推整个提交（比 Contents API 逐文件更干净，一次形成一个提交）：

   ```
   POST /git/blobs（每个改动文件 base64）
   → POST /git/trees（base_tree = 远端旧提交的 tree）
   → POST /git/commits（parents = 远端旧提交）
   → PATCH /git/refs/heads/master
   → POST /git/tags + POST /git/refs（annotated tag）
   ```

   **两个必踩的坑：**
   - 推送脚本后缀写成 `.mjs` 就不能用 `require`，报
     `ReferenceError: require is not defined in ES module scope`；要么改 `.cjs`，
     要么全用 `import { execFileSync } from 'node:child_process'`。
   - 从 `version.properties` 取版本号的正则**必须锚行首**：`/^versionName=([\d.]+)\s*$/m`。
     文件注释里还有一句 `-Pdsh.versionName=0.2.1`，不锚定就会把 tag 打成 `v0.2.1`
     （踩过，用 `DELETE /git/refs/tags/v0.2.1` 删掉重打）。

   **第三个坑更隐蔽：上传的字节必须来自 git 对象，不是工作区。**
   第一版用 `fs.readFileSync(工作区文件)` 上传，结果远端 `HEAD^{tree}` 与本地永远不同。
   两个原因都在 Windows 默认行为里：
   1. `core.autocrlf=true` —— 工作区是 CRLF，git 对象里是 LF，直接读工作区就多带了 `\r`。
      必须 `git cat-file blob HEAD:<path>` 取对象字节。
   2. **mode 不是恒为 `100644`** —— 本仓库 `gradlew` 是 `100755`，统一写 100644 会抹掉
      可执行位，而 CI 里正好要 `./gradlew`。必须从 `git ls-tree -r HEAD` 照抄 mode。

   **验收标准只有一个：`POST /git/trees` 返回的 sha 必须等于本地 `git rev-parse HEAD^{tree}`。**
   `tools/push-via-api.mjs --all` 会打印这个对比，不一致就别当推成功了。
   全量重推时不要带 `base_tree`，否则远端独有的旧文件会残留成幽灵文件。

   **发版前先探一句 `git ls-remote origin`**，不通就别指望 `publish-release.cjs` 能推上去。
   另一个反复出现的前提：本地 `git config http.proxy` 指着 `127.0.0.1:7890`，而 mihomo 不在时
   报 `Could not connect to server`；确认端口没人听就 `git config --local --unset http.proxy`
   （`https.proxy` 一起 unset），不要留着这条配置去猜。`http.sslbackend openssl` 可以保留。

### 6.31 「装完就能连」：自动扫局域网，但 PIN 必须由用户给

用户报的现象：从 GitHub Release 装完 App，第一屏永远是「扫码连接 / 手动连接」。
根因不是没写自动连接，而是**三级回落全落空**：全新安装没有 lastUsed；
CI 包里 `BuildConfig.DEFAULT_LAN_URL` 是空串（故意，防 PIN 进公开仓库）；于是只剩扫码。

#### 为什么只能自己扫

查过 dsh-pocket 服务端（v2.12.0）：`lib` 下所有 js 里
`mdns|bonjour|discovery|broadcast|multicast|ssdp` **零命中** —— 它不广播自己，也不响应发现。
所以手机侧只能扫 /24。实测 **254 个地址、并发 48、TCP 超时 300ms，1.86 秒扫完**。

#### 五条硬约束（每条都踩过）

1. **钉死 /24，不按真实掩码展开。** 家里若是 /16，展开是 65,534 个地址，手机上跑不完也没意义。
2. **判据只能是正文含 `DSH Pocket` / `DeepSeek Harness`，不能用响应长度。**
   同一个「访问验证」页实测出现过 **4210 B 与 3969 B** 两种长度。
   不判正文的话，254 个地址里任何一个路由器后台都会被当成电脑。
   **判「这台电脑免不免 PIN」则是另一件事，只能看响应头有没有 `Set-Cookie: dsh-auth-`**
   （见 §6.32）—— 长度、状态码、正文都区分不出「访问验证」页与「正在进入」页。
3. **`tokenOf` 必须先砍 fragment 再找 `?`。** `http://h/#?token=x` 里的 token 是 fragment 的，
   服务端根本收不到；反过来先找 `?` 就会把它当有效凭据。
4. **`rebind` 必须带原 scheme。** `BootstrapUrl.build` 见到无 scheme 输入会补 `http://`，
   于是 `https://` 的档案迁移后**悄悄降级成明文** —— 用户不会察觉，但 cookie 开始裸奔。
5. **扫描汇总要放独立线程等 `CountDownLatch`**，不能提到同一个线程池：
   池满时永远轮不到，表现是「扫完了但一直不回调」。

#### 扫到 ≠ 能连：PIN 这一层要说清楚

PIN 是 dsh-pocket **进程级**的一把钥匙（`~/.dsh/dsh-pocket/token-lan`），未认证时没有任何接口能读到。
实测四种请求只有「局域网 PIN」会下发 `Set-Cookie`：

| 请求 | 状态 | `Set-Cookie` |
|---|---|---|
| 无 token | 200 | 无 |
| 局域网 PIN | 200 | `dsh-auth-*` + `dsh_pocket_token` |
| 错 PIN | 200 | 无 |
| **公网 PIN 打在局域网端口上** | 200 | 无（两把不同的钥匙） |

所以扫描只解决「电脑在哪」，解决不了「PIN 是多少」。改进是把「跑到电脑前扫二维码」
压缩成「输 8 位数字」，不是消灭这一步。

**但要区分两种情况**：电脑侧把 `lanAuthEnabled` 关掉后，局域网完全免 PIN，
裸 GET 就直接下发 `Set-Cookie: dsh-auth-…`；那种情况下扫描就能一路连到主界面，
用户一次都不用输。判据与实现见 §6.32。

#### 什么时候可以沿用旧 PIN

`LanAdopt.plan` 的判据：

- 扫到的主机 == 已保存档案的主机 → 直接连；
- **只有一台**电脑答话、且有带 PIN 的档案 → `rebind` 把 PIN 搬到新 IP
  （PIN 是进程级的，不随 DHCP 变，所以换地址后仍然有效）；
- **多台**电脑答话 → 一律 `AskPin`。手机侧分不清是哪台，搬 PIN 有可能连到别人家机器上，
  宁可让用户多看一眼；
- 没有任何带 PIN 的档案 → `AskPin`；
- 一台都没扫到 → 落回列表 + 手输/扫码。

#### 走流量时不扫

`localLanIpv4()` 只认 `wlan/ap/swlan/eth/rndis/usb` 前缀的接口，不用 `ConnectivityManager`
（那要 `ACCESS_NETWORK_STATE` 权限，本项目已删）。扫运营商 NAT 网段白等两秒，一台电脑都不会有。

#### 排查

扫描过程与结果都打 `Log.i("DshRemote", "lan discovery done, found=N")`。
真机上「没找到电脑」先看这行有没有出现：没出现说明根本没起扫描（多半不是 Wi-Fi），
出现且 `found=0` 才是网络问题。

### 6.32 免 PIN 直进主界面：判据只能是响应头里的 `Set-Cookie: dsh-auth-`

用户要的是「从 GitHub 装完，第一屏就是主界面」，不是「扫到电脑再让我输 PIN」。
这件事**只在电脑侧愿意放行时才成立**，App 自己变不出 PIN。

#### 服务端依据（dsh-pocket v2.12.0）

`lib/index.js:336-339`
```js
isProtected: (host) => {
  if (isLanOverrideHost(host)) return lanAuthEnabled();
  return classifyHost(host) === 'public' ? true : lanAuthEnabled();
}
```
`lib/settings.mjs` 文件头注释：「关闭后局域网扫码直连（仅同一网络内的设备能访问），
公网不受影响（永远要密码）」。开关存在 `~/.dsh/dsh-pocket/settings.json` 的
`lanAuthEnabled`（默认 `true`），网页「设置 → 手机访问」也能切（RPC `setLanAuthEnabled`）。

#### 判据：只能看响应头

| `lanAuthEnabled` | 状态 | 正文长度 | title | `Set-Cookie` |
|---|---|---|---|---|
| `true` | 200 | 3969 | `DSH Pocket · 访问验证` | 无 |
| `false` | 200 | 522 | `DSH Pocket · 正在进入 \| opening…` | **`dsh-auth-…`** |

- **状态码没用**：两种情况都是 200。
- **长度没用**：4210 / 3969 / 522 都见过，同一页面随状态漂。
- **正文里的 `DSH Pocket` 没用**：两页都带。
- 唯一稳的是响应头里有没有 `Set-Cookie: dsh-auth-`（`CookieNames.AUTH_PREFIX`）。

实现是 `LanScan.issuesCredential(rawResponse)`：**只看第一个 `\r\n\r\n` 之前**，
逐行 `lowercase().startsWith("set-cookie:")` 且该行含 `dsh-auth-`。
正文里出现 `Set-Cookie:` 字样不算 —— 有专门的反面单测
`credential_ignoresSetCookieLookingTextInsideBody`。

`probe(host)` 的读循环退出条件必须是 `headerReady && looksLikePocket(...)` **两个都满足**；
少判 `headerReady` 会在「响应头与正文被拆成两个 TCP 段」时偶然判成「要 PIN」。

#### `LanAdopt.plan` 五步顺序（顺序本身就是结论）

1. hits 空 → `None`；
2. 任一已保存档案的 host 与某 hit 相同（忽略大小写）→ `Adopt` 旧档案（含 PIN 与端口，即使这台现在免 PIN 也不换）；
3. **恰好一台 `open`** → 造 `http://<host>:3081/`（**不带 token**）→ `Adopt`；
4. 只有一台答话时，对每个档案试 `LanScan.rebind`（沿用旧 PIN，处理电脑换 IP）；
5. 其余 → `AskPin`。

第 3 步排在第 4 步之前是有意的：电脑免 PIN 了就不该再搬一张没用的 token 进 URL
（多带一个密钥进地址栏毫无收益）。

#### 代价（改了就要记住）

局域网内**任何设备**裸访问 `http://<电脑IP>:3081/` 都不用密码，直接能看到会话与文件。
家里 Wi-Fi 可信才行；不可信就把 `lanAuthEnabled` 改回 `true`，App 会自动退回
「扫到电脑 + 输 PIN」。公网（cloudflared 隧道）永远要 PIN，不受这个开关影响。

#### 落地记录（`v0.4.0`，2026-11-03）

清数据冷启动 `TotalTime: 313`，`uiautomator dump` 得到 **0 个文本节点**（已在 WebView 里，
列表页才会出现「DSH 手机遥控」标题）→ 免 PIN 直进成立。

**真机验证时别把别人的弹窗当成本项目的缺陷**：第一屏看到的「用户须知 / 我已阅读并理解…
同意合法合规使用 / 我已知晓并继续」是网页里 **dsh-purge 插件**的一次性弹窗，不是 App 弹窗，
也不是 PIN 屏。判据：App 的列表页一定有「DSH 手机遥控」这个原生标题，且 WebView 内容层
不会渲染 Native 按钮。

关掉那个弹窗的正确手法（MIUI 拒 `input tap` 注入，点了毫无反应）：

1. 先滚到底（`input swipe 540 1750 540 950 500` 连来 3 次，一次不够）；
2. 复选框坐标必须用 PIL 从**原始 1080 宽截图**算（缩到 720 再量会整体偏）：
   扫 `x∈[60,200] y∈[1950,2260]`，亮度 >110 且单行命中 ≥10 px → 得到上下两条边框
   `y=2009..2011` / `2050..2052`、`x=136..175` → 中心 `(155, 2030)`；
3. 按钮亮带 `y=2208..2325 x=424..844` → 中心 `(634, 2266)`；
4. 两次点击用 `monkey -f` 的自定义手势脚本注入（`DispatchPointer` + `UserWait(600)`），
   判据看 `Events injected:` 非 0；**先勾选、隔 ≥1.2 秒再点按钮**，顺序反了不生效。

### 6.33 出门只插流量也要能连：三条各自独立、缺一就白等

用户的原话是「在外面连接使用手机网络，也没有 wifi 啊」。局域网路径天生不通，
所以「在家能连」和「出门能连」是两件事，各自要单独的机制：

| 能力 | 机制 | 失败表现 |
|---|---|---|
| 找到电脑 | 扫 /24（第 22 步） | 列表页「没找到电脑」 |
| 不需要 PIN | 认响应头 `Set-Cookie: dsh-auth-`（第 23 步） | 停在「输 PIN」屏 |
| **拿到公网地址** | **`pocket.status` RPC（本节）** | **手机里永远只有局域网那条，出门必连不上** |

#### 铁律一：`pocket.status` 的字段在 `result.value` 里，不在顶层

真实响应（2026-11-03 从真机抓的）：

```json
{"type":"server-response","rpcId":"r1",
 "result":{"ok":true,"value":{"proxyPort":3081,"lanUrl":"http://192.168.50.58:3081",
  "tunnelRunning":true,"tunnelUrl":"https://tunnel-b.trycloudflare.com",
  "tunnelState":{"phase":"ready","startedAt":…},"dshPort":42591,
  "accessToken":"87654321","lanToken":"12345678","lanAuthEnabled":false}}}
```

第一版按顶层取键 → 永远拿不到 → 日志只有一句
`pocket.status: no usable public address`，**看起来像「隧道没开」，其实隧道好着**。
正确做法是先 `payloadScope()` 剥到 `result.value`，取不到时退回「整段就是负载」的老格式。

**这条 RPC 必须带 cookie**（裸 POST 恒 `401` + body `unauthorized`），
cookie 就是 WebView 里已下发的 `dsh-auth-*`；所以调用点放在 `onPageFinished` 之后，
用 `HttpURLConnection` + `CookieManager.getInstance().getCookie(origin)`。
**不要用页面里的 `fetch`**：`evaluateJavascript` 的回调不 await Promise，拿到的是 `{}`。

#### 铁律二：「没 Wi-Fi 却连私有网段」是确定不通，不许等进度条

实测这条路上 `maxProgress` 竟然到过 **10**（页面自己画了点东西），
于是「一点进度都没走」那条判据不触发，**白等满 30 秒**才回落。

`ConnectWatchdog.hopeless(url, onLan)` 单独判这一条：

```kotlin
if (onLan) return false                       // 有 Wi-Fi 时局域网是最快路径，绝不能提前判死
return Endpoint.kindOf(target) == Endpoint.Kind.LAN
```

判据是「有没有 Wi-Fi」（`LanScan.localLanIpv4() != null`），
**不是「局域网连不连得上」** —— 后者要真拨一次才知道，那正是要避免的等待。

#### 铁律三：换下一条时优先换**网络类型**，不是换最近的

`AutoFailover.next()` 的排序是
`compareByDescending { kind == preferredKind }.thenByDescending { lastUsedAt }`，
`preferredKind` = 当前是 LAN 就 PUBLIC、反之亦然。
同一个网络类型的另一条地址，失败原因大概率一样，试它只是多等一轮。

`pickStart()` 里还有一条：**没 Wi-Fi 而 `lastUsed` 是 LAN 时直接换成最近用过的 PUBLIC**。
在家连局域网天经地义，所以它必然是 `lastUsed`；但出门之后它还是 `lastUsed`，
不换就会天天先花一轮去等一个注定不通的地址。

存公网档案时**不要动 `lastUsedAt`**（置 0），否则用户在家连一次局域网，
下次冷启动就被莫名改走公网（绕远路）。

#### 排查用的日志（跟着这三条看）

```
I DshRemote: pocket.status: saved public address xxx.trycloudflare.com   ← 抓到了，最该出现的一行
I DshRemote: pocket.status: no usable public address                     ← 解析失败或隧道没开
W DshRemote: connect gave up after 30081ms, maxProgress=10, hopeless=false, url=…
I DshRemote: connect failover -> https://…
```

`hopeless=true` 却还等了 30 秒 = `hopeless` 没接进 tick；
`hopeless=false` 而地址是 `192.168.x.x` 且没有 wlan0 = `onLan` 判错了。

#### 手输地址这条退路不可靠

真机上 `adb shell input text` 打公网地址，被讯飞/搜狗输入法的「智能标点」改成全角：

```
https：//xxx－yyy。trycloudflare。com/？token=87654321
```

`:`→`：`、`-`→`－`、`.`→`。`、`?`→`？`，地址直接失效。
所以**能自动抓就别让人手输**；真要手输，`input text` 之后必须回读 EditText 校验。

---

## 7. 调试工具链（`tools/`，全部零依赖 Node，自带极简 WebSocket 客户端）

| 脚本 | 用途 |
|---|---|
| `cdp-forward.cjs` | 重建 `adb forward tcp:9222`（§6.8） |
| `measure-smooth.cjs` | 测键盘弹出：先 BACK 收干净，再 tap，逐帧输出 innerH/rootH/composerTop + 帧间隔，直接给 PASS/FAIL |
| `verify-collapse.cjs` | 测收起方向（漏发 `h=0` 会让 `#root` 卡在矮高度） |
| `trace-keyboard-calls.cjs` | 包一层 `__dshNativeKeyboard` 打每次入参 + `#root` 实际高度，用来定位「谁在改回去」 |
| `measure-sync.cjs` | 同钟对齐原生 `bottomMargin` 与页面 `innerHeight`（当初定案靠它） |
| `test-page-drive.cjs` | 对照实验：页面 rAF 自驱能否逐帧 |
| `probe-bg.cjs` | 探页面 body/html 背景色与 composer 祖先链配色 |
| `probe-composer.cjs` | 探 composer 祖先链的 transition / animation / transform / flexGrow / visualViewport |
| `tap-composer.cjs` | 取 composer CSS 坐标 + 密度换算 + adb tap，含点前后状态 |
| `sample-viewport.cjs` | 页面内 rAF 采样 innerH / composerTop 变化点 |
| `simulate-stale-cookie.cjs` | `dump` 列 cookie（httpOnly/domain）；`stale` 把 `dsh_pocket_token` 写成 `deadbeef`×8 造故障 |
| `verify-selfheal.cjs` | 同一进程内「弄脏 → 导航 → 逐秒采样页面」，给 ✅/❌ |
| `verify-selfheal-net.cjs` | **判定力最强**：抓 `Network.requestWillBeSent`，识别同时带 `dsh-pocket-retry` 与 `token=` 的那一跳（§6.13）。支持 `<cdpPort>` 参数；cookie domain 从页面 origin 现取，公网域名可用 |
| `verify-ask-user.cjs` | 反面分支：无 `?token=` 时自愈**必须不动手**（不清 cookie、不重导航、停在验证页） |
| `probe-netstack.cjs` | 探 WebView 当前 title/url/readyState/body；带 `--navigate <url>` 时先导航再观察 15 秒并统计 Document 请求/响应/失败 |
| `watch-net.cjs` | 持续监听 CDP 网络事件（`<cdpPort> <秒数>`），末尾给「Document 请求总数」，为 0 时标注「loadUrl 被短路」。判断「点击到底有没有发出导航」用它 |
| `tap.cjs` | 真机可靠点击：`node tap.cjs <x> <y> [serial]`，走 `monkey -f` 绕开 MIUI 对 `input tap` 的注入拒绝（§6.19） |
| `eval-page.cjs` | **调页面最短路径**：`node eval-page.cjs <cdpPort> "<js>"` 或 `--file <path>`。比 `adb input` 可靠（MIUI 拒注入），调 DOM 逻辑首选 |
| `probe-sessions.cjs` | `node probe-sessions.cjs <cdpPort> [open]`，打开侧栏并列出 `.wnFoaW_sessionRow` 会话条目，用于「进会话→按返回」的重放 |
| `probe-sidebar.cjs` | 列出所有按钮几何、`aria-label`、侧栏容器位置。页面版本变化后靠它重新定位选择器 |
| `probe-back-nav.cjs` | `node probe-back-nav.cjs <cdpPort> [--state\|--back]`，打印页面位置/侧栏几何，`--back` 触发返回并逐帧采样 + 抓 Document 事件 |
| `record-back.cjs` | `node record-back.cjs <cdpPort> [帧数] [间隔ms] [目录]`，触发返回 + CDP 连拍 + DOM 采样，能抓到 1 秒内的中间态。**验证返回动效是否闪屏就看它**（§6.20） |
| `crash-page.cjs` | `node crash-page.cjs <cdpPort>`，用 CDP `Page.crash` 让渲染进程真的崩掉，验证 `onRenderProcessGone` 兜底（§6.22）。非 root 的 `pkill` 杀不掉沙箱进程，只能靠它 |
| `probe-startup.cjs` | `node probe-startup.cjs <cdpPort> <毫秒> <间隔ms>`，冷启动逐帧采样侧栏位置，判「启动时闪不闪」（§6.27）。**它能在 CDP 连上之前的时间窗里边等边连抢到采样点** |
| `probe-frame-attrs.cjs` | document-start 装 MutationObserver，抓首帧 `data-sidebar-collapsed` 与侧栏 `transform`，用来证明「属性先到、样式后到」 |
| `probe-sidebar-anim.cjs` | 逐帧记 `getAnimations()` + `transitionrun` 事件，区分「CSS 过渡」与「JS 直接跳」（修法完全不同，不能靠猜） |
| `verify-no-sidebar-flash.cjs` | 注入去过渡样式后 reload 复测，验证侧栏修法有效 |
| `probe-layer.cjs` | 把页面构造到 7 种层叠状态，逐一打印 `DSH_LOCATION_JS` 判出的层。**改判据前后都跑它**（§6.28） |
| `verify-back-layers.cjs` | `node verify-back-layers.cjs <cdpPort>`，7 个场景各按一次真实返回键，断言「只退一层」。CDP 转发随 pid 重建、构造步骤带断言，是「返回是否互逆」的唯一判据 |
| `publish-apk.cjs` | `node tools/publish-apk.cjs [--no-build] [--bump patch / minor / major]`，构建 release 并发布到 `dist/`（APK + `latest.json` + 自包含下载页） |
| `serve-apk.cjs` | `node tools/serve-apk.cjs [port]`，把 `dist/` 发布成局域网下载页（默认 8123，支持 Range），另一台手机浏览器打开即可装机与收更新 |
| `publish-release.cjs` | `node tools/publish-release.cjs --bump patch` 升版本并提示提交；`--no-bump` 打 tag 推 origin，触发 `release.yml` 建 GitHub Release（手机用固定地址收更新，见 §6.30） |
| `push-via-api.mjs` | **兜底**：`github.com:443` 的 git 传输不通时，用 Git Data API（blobs → trees → commits → refs）把 HEAD 推到远端并打 tag（§6.30）。git 通道正常时用不到 |
| `tag-only.mjs` | **兜底**：远端 master 已在正确位置、只缺 tag 时用它。取版本号的正则**必须锚行首**，否则会抓到注释里的旧版本号 |
| `ui-dump.cjs` | `node ui-dump.cjs <ui.xml>`，把 `uiautomator dump` 的 XML 打成「文本 / 类 / bounds / 中心点」，给 adb 点控件找坐标的最快路径 |

`tools/` 里还有一批 `_` 前缀与 `.py` 的一次性探针，是排查过程的残留，不保证可用，新脚本别依赖它们。

---

## 8. 知识库（本项目经验沉淀，开发前先查）

本项目在 DSH 里挂了一个知识库：**手机软件开发知识库** `e1b49da1-ad61-4586-9333-ee4ec202e315`，
覆盖 Android/Kotlin 工程知识（构建约束与 targetSdk 节奏、WebView 外壳与 JS 桥与安全基线、Android 16 迁移、键盘避让、动画时序、ADB+CDP 调试、测试分层、架构分层、敏感数据存放、性能验证）。
已挂载到 `D:\DeepSeek Harness` 与本项目目录，`write_mode='audit'`。

**开发前先查**：遇到「这个 Android 问题以前怎么解决的」「构建为什么失败」「真机行为怎么量」，先 `knowledge_search`，
不要重新推一遍。库里每条都是本机实测结论，带环境标注。

种子文档在 `kb/`（5 篇 Markdown），**后续修订/新增放 `kb/updates/`**（front-matter 带 `id` = 更新该篇，省略 = 新建）。
入库与更新脚本在 `tools/`：

| 脚本 | 用途 |
|---|---|
| `kb-ingest.mjs` | **只用于首次灌种子**：读 `kb/*.md` → 插件自己的函数渲染/哈希/切节 → 一个事务写 5 张表 + 落盘 md。`--dry` 只打印。**再次运行会新建重复条目** |
| `kb-update.mjs` | **改库内容走这个**：读 `kb/updates/*.md`，逐篇走 `LocalKnowledgeProvider.update()` / `create()`，随后核对 entries / `knowledge_documents` / versions / passage。`--dry` 只打印。**加 `--only '<regex>'` 限定本次处理哪些文件** —— 不加会把这个目录里所有已入库的文档再各升一版 |
| `kb-verify.mjs` | 全库核对：5 表计数、`validStructure` 校验、磁盘 md 能否解回、FTS 召回试探 |
| `kb-mount.mjs` | 挂载到项目目录 |

**每次改库前先备份**：`VACUUM INTO` 出一个快照（不要只靠 `.bak` 文件复制，WAL 模式下复制不安全）：

```js
new DatabaseSync(DB).exec(`VACUUM INTO 'C:/Users/yaoqi/.dsh/knowledge/snapshot-<时间戳>.sqlite'`)
```

`kb/updates/*.md` 的 front-matter：
```
---
id: d7618755      # 省略 = 新建；给出 = 更新该 id（前缀必须唯一命中）
title: ...
type: lesson      # preference | fact | decision | procedure | lesson
tags: a,b,c
confidence: 0.9
group: 外壳
---
<正文，不含一级标题>
```

**为什么不能直接 `UPDATE knowledge_entries`**：`updateEntry()`（`lib/local-provider.js:900-934`）只写 entries/fts/versions，
**不重写磁盘 `.md`、不重建 passage 索引**。直接改库会让 DB 与磁盘脱钩，下次插件同步时改动静默消失。
`provider.update()`（同文件 `:782-795`）才是官方路径 —— 事务内改 entries，再 `syncKnowledgeEntryQueued()`
重写 projection markdown（`knowledge_documents` + 磁盘），并让 passage 按 `body_hash` 重建。

**校验写死一条**：`parseKnowledgeMarkdown` 是**完整文档**解析器（要求 YAML front-matter + 一级标题），
不能只喂 `"# title\n\nbody"`（会报 `missing YAML front matter`）。正确做法是
`parseKnowledgeMarkdown(renderKnowledgeMarkdown({metadata, title, body}))` 往返比对正文。

**存储层事实（要改库内容必读）**：知识库后端是 `@lemoncat7/dsh-knowledge` v2.17.0
（`C:\Users\yaoqi\.dsh\profiles\desktop\node_modules\@lemoncat7\dsh-knowledge\lib\`，ESM），
不是 `dsh-mnemon`（那只是 recall/writeback 策略层）。DB 在 `C:\Users\yaoqi\.dsh\knowledge\knowledge.sqlite`。

- **不要手搓格式**：直接 import 插件的 `renderKnowledgeMarkdown` / `markdownHash` / `parseKnowledgeMarkdown` /
  `buildPassageStructure` / `contentHash` / `normalizeTags`，用 `node:sqlite` 的 `DatabaseSync` 写。
- `knowledge_entries.content_hash` = `sha256(JSON.stringify({knowledgeBaseId, title小写, body小写, type, tags: normalizeTags(tags), scope}))`
- `knowledge_documents.content_hash` = `markdownHash(带 front matter 的完整 markdown)`，**不是** `content` 列
- `knowledge_passage_index.body_hash` = 裸 `sha256(body)`
- `knowledge_passage_index` 上有 `AFTER INSERT ON knowledge_entries` 触发器会预建 `pending` 行，
  手写时要 `ON CONFLICT(entry_id) DO UPDATE`，否则撞 `UNIQUE constraint failed: entry_id`。
- `knowledge` 工具网关**没有 document_create**，入库只能走存储层。

---

## 9. 非目标

- **不重写 DSH 前端**（§0 三条依据）。
- **不改 `dsh-pocket`**。它是外部组件，本仓库只消费它的页面。**但它与我们的耦合面必须登记**，见 §11。
- **不引入 Compose**。UI 量很小（一个列表 + 一个 WebView + 一个扫码页），命令式 View 够用，且能精确控制 WebView 与 insets。
- **不做 root / 不改系统**。所有避让都靠 WindowInsets + 页面 CSS。

---

## 10. 相关项目

| 项目 | 关系 |
|---|---|
| `D:\mobile-android`（netacc-android） | 无关。只是同一个作者的另一条 Android 线，构建环境的坑可互相参考 |
| `D:\network-manager` | 无关。Python + Tk 桌面版 |
| `dsh-pocket`（`~/.dsh/profiles/desktop/node_modules/dsh-pocket`） | **本项目的上游依赖**，提供反代与认证。耦合面见 `INTEGRATION.md` |

---

## 11. 工程红线（审计后新增，别退回去）

### 11.1 仓库里不出现调试截图
`.git` 曾因根目录 25 个 `shot-*.png` + `ui.xml` 膨胀到 66.1 MB（截图占 62.7 MB / 95%）。
现在 `.gitignore` 拦 `shot-*.png` / `shot-*.jpg` / `ui.xml`。
**需要长期留存的证据图放 `docs/evidence/`**，且只放真正对外的验收证据（现在只有 `step7-public-4g.png`）。

### 11.2 仓库里不出现真实 IP 与 PIN
`MainActivity` 的 `DEFAULT_LAN_URL` 曾硬编码 `http://192.168.50.58:3081/?token=12345678`，
等于把 dsh-pocket 的局域网访问密码公开。现在：

- 值来自 `local.properties`（已 gitignore）的 `dsh.lanUrl` / `dsh.lanPin`；
- `app/build.gradle.kts` 注入 `BuildConfig.LAN_HOST` / `LAN_PIN`；
- `BootstrapUrl.build()` 拼成完整 URL；任一为空 → 空串 → App 走扫码引导。

文档里也不要写具体 IP 与 PIN（`CONTEXT-ANCHOR.md` 已按这条重写）。

### 11.3 同一个逻辑不要在两处各写一遍
第一版让 Gradle 自己拼完整 URL 注入，结果漏掉 `?token=`，
注进去的是 `http://192.168.50.58:3081` —— App 连上去只落到「访问验证」页，**不报错、不崩**。
现在 Gradle 侧只做 `validateLanHost()` 校验（能不能解析出 host），拼装唯一归 `BootstrapUrl`，
行为由 `BootstrapUrlTest` 10 条钉住。

### 11.4 CI 必须能在「没有真实地址」的环境下过
`.github/workflows/ci.yml` 跑 `assembleDebug` + `testDebugUnitTest --rerun-tasks` + `lintDebug`。
验证方法：把 `local.properties` 改名后 `--rerun-tasks` 重跑，必须 `BUILD SUCCESSFUL` 且
`BuildConfig.LAN_HOST=""`。这条不验，第一次 push 就会红。

lint 基线：**0 error / 20 warning**（`SetTextI18n` 10、`GradleDependency` 3、`MonochromeLauncherIcon` 2、
其余各 1）。AGP 默认 `abortOnError` 只对 error 生效，所以 warnings 不挡合并。
第 16 步把 9 条 `UnusedResources` 清零（删掉 XML 侧零引用的 7 个颜色与 2 个字符串），
现在剩下的 10 条 `SetTextI18n` 是「文案写死在 Kotlin 里」——要收敛成资源是一次独立改造，不是补几行 strings。

