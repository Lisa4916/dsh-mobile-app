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

# 构建 + 单测（两条一起跑，基线 tests=59 failures=0）
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    -p 'D:\dsh-mobile-app' :app:assembleDebug :app:testDebugUnitTest --console=plain -q

# 安装到真机
& 'D:\AndroidDev\sdk\platform-tools\adb.exe' -s ZY22GHMK5F install -r `
    'D:\dsh-mobile-app\app\build\outputs\apk\debug\app-debug.apk'
```

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
| 8 | 手机软件开发知识库：5 篇种子文档入库 + 挂载到本项目与 `D:\DeepSeek Harness` | ✅ 见 §10 |
| 9 | 前台服务保活（测试期靠 `svc power stayon true`，不该长期开） | ⏳ |
| 10 | 任务完成通知 / 文件拍照附件 / 局域网自动发现 / 多电脑一键切换 | ⏳ |

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
│                        onPageFinished / onPageError / onProgress / openExternal
├── WebViewFactory.kt    WebView 配置的唯一出口
│                        create(host)：JS 开关、DOM Storage、同域跳转拦截、错误回调、
│                        背景色 0xFF151517、installHomeResetOnStart()、注入 KEYBOARD_HOOK_JS
│                        HOME_RESET_JS / KEYBOARD_HOOK_JS 两个常量
├── WebBridge.kt         @JavascriptInterface，注入名 "dshNative"
├── RecoveryPlanner.kt   页面坏了该怎么修的决策中心（**纯 JVM，不碰 android.net.Uri**）
│                        PageState { HEALTHY, HANDSHAKE_BROKEN, PIN_REQUIRED, UNKNOWN }
│                        RecoveryAction { NONE, CLEAR_UPSTREAM_COOKIE,
│                                         CLEAR_POCKET_COOKIE, ASK_USER }
│                        fromProbe('0'/'1'/'2') / plan(state, url) / hasPinToken(url)
│                        withRetry(url) → 幂等加 dsh-pocket-retry=1，**必须插在 # 之前**
│                        ⚠ 铁律：URL 里没有 ?token= 时**不许**清 dsh_pocket_token，
│                          否则用户被永久锁在「访问验证」页外（单测钉住）
├── ScanActivity.kt      CameraX 预览 + ZXing 解码，只认真 http(s) 结果
├── EndpointTest.kt      24 条单测：解析、序列化往返、脏数据容错、id 稳定性、
│                          入口类型推断（网段边界 / IPv6 私有 / CGNAT / mapped-v4）、
│                          4 列老数据的升级兼容
└── RecoveryPlannerTest.kt 14 条单测：fromProbe 映射、plan 分支穷举、hasPinToken
                           只认 query 里的 token、withRetry 幂等与 fragment 位置
```

`res/values/`：`page_dark = #151517`（**必须与 DSH 页面 body 同色**，见 §6.2）、`surface`、`ink`、`ink_dim`、`brand`。
`AndroidManifest.xml`：`INTERNET`、`usesCleartextTraffic="true"`（目标是局域网 http 明文）、`network_security_config`。

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
`http` 会变成 `p://`，分字符注入也失败。所以 App 里有「填入本机示例」按钮（`DEFAULT_LAN_URL` 常量），地址由代码写，不经过输入法。

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

`tools/` 里还有一批 `_` 前缀与 `.py` 的一次性探针，是排查过程的残留，不保证可用，新脚本别依赖它们。

---

## 8. 知识库（本项目经验沉淀，开发前先查）

本项目在 DSH 里挂了一个知识库：**手机软件开发知识库** `e1b49da1-ad61-4586-9333-ee4ec202e315`，
覆盖 Android/Kotlin 工程知识（构建约束、WebView 外壳与 JS 桥、键盘避让、动画时序、ADB+CDP 调试、单测可测性）。
已挂载到 `D:\DeepSeek Harness` 与本项目目录，`write_mode='audit'`。

**开发前先查**：遇到「这个 Android 问题以前怎么解决的」「构建为什么失败」「真机行为怎么量」，先 `knowledge_search`，
不要重新推一遍。库里每条都是本机实测结论，带环境标注。

种子文档在 `kb/`（5 篇 Markdown），入库脚本在 `tools/`：

| 脚本 | 用途 |
|---|---|
| `kb-ingest.mjs` | 读 `kb/*.md` → 用插件自己的函数渲染/哈希/切节 → 一个事务写 5 张表 + 落盘 md。`--dry` 只打印 |
| `kb-verify.mjs` | 入库核对：5 表计数、`validStructure` 校验、磁盘 md 能否解回、FTS 召回试探 |
| `kb-mount.mjs` | 挂载到项目目录 |

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
- **不改 `dsh-pocket`**。它是外部组件，本仓库只消费它的 :3081 页面。
- **不引入 Compose**。UI 量很小（一个列表 + 一个 WebView + 一个扫码页），命令式 View 够用，且能精确控制 WebView 与 insets。
- **不做 root / 不改系统**。所有避让都靠 WindowInsets + 页面 CSS。

---

## 10. 相关项目

| 项目 | 关系 |
|---|---|
| `D:\mobile-android`（netacc-android） | 无关。只是同一个作者的另一条 Android 线，构建环境的坑可互相参考 |
| `D:\network-manager` | 无关。Python + Tk 桌面版 |
| `dsh-pocket`（`~/.dsh/profiles/desktop/node_modules/dsh-pocket`） | **本项目的上游依赖**，提供 :3081 反代与认证 |
