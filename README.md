# dsh-mobile-app — DSH 手机遥控

自研 Android 外壳 App：把电脑上的 DeepSeek Harness 搬到手机，同一份会话、同一批文件。

## 现状

**局域网与公网都已在真机跑通。** 手机屏幕上就是电脑上正在进行的同一段对话，
含流式输出、工具卡片、子智能体状态。公网走 Cloudflare quick tunnel，关掉 Wi-Fi 走 4G 也能进主界面。

入口类型由 App 自动判断并标注（局域网 / 公网 / 本机），公网快速隧道地址会提示「每次重开都会变」。

## 架构

```
手机 App（WebView 外壳）
   │ 局域网：http://<电脑IP>:3081/?token=<PIN>
   │ 公网：  https://<随机三词>.trycloudflare.com/?token=<PIN>
   ▼
dsh-pocket 反向代理（认证 + cookie + 注入 launch token）
   ▼
本机 dsh web（端口每次启动都变，App 不需要知道）
```

选这个架构而不是原生重写，依据是：

1. DSH web 的所有路径都 401，要直连必须自己做 token→cookie 握手 + `events.mux` WebSocket。
2. 连成熟项目 `saya-ch/dsh-mobile` 都明确写着「直接打开插件提供的已认证 HTTPS 页面，不打包另一套 DSH 前端」。
3. `dsh-pocket` 已移植 `dsh-web-mobile` 的窄屏布局，移动端体验现成。

**App 与 dsh-pocket 的耦合面（cookie 名、query 参数、页面文案）全部记在 [INTEGRATION.md](INTEGRATION.md)** ——
那些不是公开 API，升级 dsh-pocket 后可能静默失效，改代码前先读那份。

## 源码

| 文件 | 行数 | 职责 |
|---|---|---|
| `MainActivity.kt` | 864 | 连接列表 + 全屏 WebView + 扫码/手输 + 键盘避让编排（只留必须有 Android 才能做的事） |
| `WebViewFactory.kt` | 600 | WebView 配置的唯一出口（JS/DOM Storage/同域跳转/错误回调/document-start 脚本/键盘 hook） |
| `Endpoint.kt` | 215 | 连接档案模型 + 5 列行式序列化 + URL 解析 + 入口类型推断（局域网/公网/本机） |
| `ScanActivity.kt` | 187 | CameraX 预览 + ZXing 解码，只认真 http(s) 结果 |
| `PageProbe.kt` | 173 | 页面状态判据：`JS_TITLE`/`JS_BODY` 只管取值，`classify()` 是纯函数，`decodeJsString()` 还原回调值 |
| `RecoveryExecutor.kt` | 157 | 自愈编排：探针结果 → 动作，经 `RecoveryEnvironment` 接口注入副作用 |
| `HandshakeHealGate.kt` | 131 | 自愈的节流闸门：每次事故最多动作 3 次、退避 5→10→20→30s |
| `RecoveryPlanner.kt` | 129 | 页面状态 → 恢复动作的纯决策（不碰 Android API） |
| `BackNavigationDecider.kt` | 82 | 返回键语义：会话页回首页、首页退出 App |
| `ConnectionRepository.kt` | 69 | 档案读写接口 + `AutoConnect.decide()` 三态（Connect / Seed / ShowList） |
| `BootstrapUrl.kt` | 68 | 内置地址拼接（host + PIN → 完整 URL），不硬编码任何真实地址 |
| `CookieNames.kt` | 39 | 「删哪类 cookie」的唯一判据（`dsh-auth-*` vs `dsh_pocket_token`） |
| `WebBridge.kt` | 28 | `@JavascriptInterface` 桥：`keyboardHeight()`（CSS px）、`isNativeShell()` |

**除 `MainActivity` / `WebViewFactory` / `ScanActivity` / `WebBridge` 外全部不依赖 Android API**，
所以能被 JVM 单测覆盖。有「判断」的地方一律搬出 Activity —— 那里只剩造 UI、WebView 生命周期、
`CookieManager` 调用、`Toast`、`evaluateJavascript` 求值。

## 测试

```
$env:JAVA_HOME='D:\AndroidDev\jdk17'; $env:ANDROID_HOME='D:\AndroidDev\sdk'; $env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' -p D:\dsh-mobile-app :app:testDebugUnitTest
```

| 测试类 | 条数 | 覆盖 |
|---|---|---|
| `EndpointTest` | 24 | URL 解析、序列化往返、4 列老数据兼容、入口类型（含 CGNAT 100.64/10 判公网） |
| `PageProbeTest` | 20 | 六种页面形态与优先级、长正文、null 兜底、`evaluateJavascript` 返回值还原 |
| `RecoveryPlannerTest` | 14 | 页面状态 → 动作分派、「带 token 才清 pocket cookie」铁律、retry 参数插在 `#` 之前 |
| `RecoveryExecutorTest` | 12 | 副作用断言（FakeEnv 记录）：清对 cookie、`ASK_USER` 不重放 Toast、退避与单轮额度 |
| `BackNavigationDeciderTest` | 11 | 返回键三种语义 |
| `BootstrapUrlTest` | 10 | 内置地址拼接、scheme/尾斜杠容错、空值返回 null |
| `CookieNamesTest` | 10 | 前缀精确匹配、值里出现名字不算、过期指令只作用一个名字 |
| `HandshakeHealGateTest` | 10 | 节流与退避 |
| `AutoConnectTest` | 7 | lastUsed 优先、无地址宁可停在列表、seed 的 kind 由 URL 推断 |
| **合计** | **118** | |

**真机 instrumented**：`androidTest/PageProbeJsTest` 7 条，验取值链路在真 WebView 里的行为
（中文标题含 `·` 往返、`innerText` 跳过 `display:none`、`about:blank` 不崩）。

```
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk   # -t 不能省
adb shell am instrument -w -r -e class com.dsh.remote.PageProbeJsTest \\
    com.dsh.remote.test/androidx.test.runner.AndroidJUnitRunner
```

CI 见 `.github/workflows/ci.yml`：`assembleDebug` + `testDebugUnitTest`（`--rerun-tasks`）+ `lintDebug`。
lint 当前基线 **0 error / 27 warning**（warnings 不挡合并）。

## 内置地址怎么配（不再硬编码）

`MainActivity` 里**没有**任何写死的 IP 或 PIN。首次启动要自动连接，就在 `local.properties`
（已被 `.gitignore` 忽略，不进仓库）里填两行：

```properties
dsh.lanUrl=192.168.50.58:3081
dsh.lanPin=<PIN>
```

不填也完全可用：App 直接落到连接列表，提示「扫码连接」或手输地址。
`dsh.lanUrl` 填了但 `dsh.lanPin` 没填时构建会**直接失败**并说明原因——不会静默生成一个连不上的地址。

> 为什么改成这样：原来这里写死 `http://192.168.50.58:3081/?token=12345678`。
> 那等于把 dsh-pocket 的局域网访问密码写进公开仓库，同时把 IP 钉死——
> 换一台电脑或换一个网段，App 就变成一个连不上的地址，用户只会以为是网络故障。

## 键盘避让：为什么由页面而不是原生来做

这是本项目最费劲的一处，结论反直觉，写清楚免得以后又改回去。

**症状**：点输入框，键盘滑上来，界面跟着缩，但两者速度对不上 —— 界面像一跳一跳地追，中间还会露出底色（用户原话「一闪的留白」）。

**原因（同钟对齐实测，`tools/measure-sync.cjs`）**：原生每帧改 `WebView.bottomMargin`，实测 322px 位移在原生侧 456ms 走完、逐帧均匀（约 7ms 一帧）；但页面 `window.innerHeight` 只变了 19 次，约 **108ms 一跳，全程 897ms**。也就是 WebView 把尺寸变化按批合并提交了，页面永远在追一个已经跑掉的目标。**原生怎么补间都不可能追上。**

**反过来验**（`tools/test-page-drive.cjs`）：页面自己用 rAF 改 `#root.style.height`，帧间隔中位数 12~20ms，而且 `#root` 高度减多少、输入框就上移多少，比例 1:1。

**所以分工改成**：

- WebView **全程保持全屏不缩**。原生只在动画开始的第一帧把「键盘最终多高」推一次过去（跨进程调用不能每帧发）。
- 页面收到后在 rAF 里补间 `#root` 高度，曲线用 `1-(1-t)^5`。

**曲线不是估的**：`dumpsys window windows` → 输入法窗口 `wanim=0x1030056` → `style/Animation.InputMethod` → `res/anim/input_method_enter.xml`，`duration=300`、`interpolator=@0x010c0005` → `res/interpolator/decelerate_quint`，`factor=2.5`，即 `1-(1-t)^5`。

**中间踩的坑（重要）**：`WindowInsetsAnimationCompat` 同时有两个值来源——`onProgress` 给动画**中间态**（0→94→185→279→…→884），`setOnApplyWindowInsetsListener` 给**终值**。我一开始判断反了，屏蔽终值、信任中间态，结果每次 `onProgress` 都改一次目标，页面的 rAF 补间被反复重启，界面就在那里抖。`tools/trace-keyboard-calls.cjs` 打出的调用序列 `h=321.8 → h=0 → 34.2 → 67.3 → …` 才把它揪出来。正确做法是：**只认终值，`onProgress` 一律忽略**。

**单位**：原生 insets 是设备像素（本机 885px），页面 CSS 是 CSS px（322px），换算 `/density`（2.748）。忘了换会算出 `895 - 885 = 10px`，布局直接崩。

**最终实测**（`tools/measure-smooth.cjs`、`tools/verify-collapse.cjs`）：

| 方向 | 位移帧数 | 帧间隔中位数 | 全程时长 | 单调 |
|---|---|---|---|---|
| 弹出 | 16 | 11ms（修复前 108ms） | 177ms（修复前 897ms） | 是 |
| 收起 | 9 | ~14ms | ~170ms | 是 |

## 自动恢复（「访问验证」页自愈）

DSH web 重启后 `dsh-pocket` 的 `sessionKey` 会换新，手机上那条 30 天的
`dsh_pocket_token` 立刻失效。更糟的是：只要请求里还带着**一个哪怕早已失效**的这个 cookie，
`dsh-pocket` 就拒绝下发新的 —— 于是「URL 里明明有 token，却还是被要求输 PIN」。

App 的处理（`RecoveryPlanner` + `HandshakeHealGate`）：

1. `HEAL_PROBE_JS` 判页面状态：`'0'` 正常/过渡、`'1'` 上游握手损坏、`'2'` PIN 验证页。
2. `'1'` → 只清 `dsh-auth-*`；`'2'` 且 URL 里**确实还有** `?token=` → 清 `dsh_pocket_token`。
3. 带 `dsh-pocket-retry=1` 重新导航（顺带清掉握手重试计数，避免撞 503）。
4. `HandshakeHealGate` 保证每次事故最多动作 3 次、间隔退避，不会把用户卡在刷新循环里。

**铁律：URL 里没有 `?token=` 时绝不清 `dsh_pocket_token`** —— 那会把用户永久锁在验证页外，那里没有密码可填。

真机已验证（CDP 抓包，`tools/verify-selfheal-net.cjs`）：弄脏 cookie 后重新导航，能抓到
`?token=<PIN>&dsh-pocket-retry=1` 那一跳，随后 cookie 被重新下发、进入主界面。
反向分支（`tools/verify-ask-user.cjs`）也验过：地址不带 token 时**不**清 cookie、停在验证页等用户重扫码。

## 关键决策与踩过的坑

1. **`android.net.Uri` 在 JVM 单测里是 stub。** 第一次跑测试 3 条失败，全是 `Uri.parse` 抛 `Stub!`。改用 `java.net.URI`，`Endpoint` 变纯 JDK 可测。（这条在 netacc-android 的 AGENTS.md 记过，我这次又踩了一遍。`RecoveryPlanner` 里判断 `?token=` 也刻意自己拆字符串，没用 `Uri`。）
2. **Gradle 9.4.1 与 AGP 8.7.3 不兼容**，用工程自带 wrapper（8.9），JDK 17。
3. **`adb shell input text` 在中文输入法下不可靠**，`http` 和 `://` 会被吞成 `p://`。所以 App 里加了「填入示例」按钮，由代码写地址，不经过输入法。
4. **截图会误导。** 三次全黑/看不到 App：一次是屏幕睡眠（`isSleeping=true`），一次是通知栏被拉下来抢焦点，一次是 WebView 渲染时序。真正的判据是 `uiautomator dump` —— 控件树里只剩 WebView（铺满全屏）和返回按钮，说明已进入 WebView 模式。
5. **MIUI 会拒绝 `input tap` 的触摸注入。** logcat 是 `InputManager: Input event injection from pid N failed`。这时 `input tap` 静默无效、页面毫无反应，**极易被误判成 App 的 bug**（本项目就为此追查了一个不存在的「断网重连失败」缺陷）。可靠做法是 `monkey -f` 注入 `DispatchPointer`，判据看 `Events injected` 非 0。
6. **`adb exec-out screencap -p >` 会 CRLF 毁 PNG**，必须 `adb shell screencap -p /sdcard/x.png` + `adb pull`。
7. **PowerShell 里 `$pid` 是只读自动变量**，脚本里改名 `$appPid`。

## 构建

```powershell
$env:JAVA_HOME='D:\AndroidDev\jdk17'
$env:ANDROID_HOME='D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    -p D:\dsh-mobile-app :app:assembleDebug :app:testDebugUnitTest
```

装到真机：

```powershell
$adb = 'D:\AndroidDev\sdk\platform-tools\adb.exe'
& $adb -s ZY22GHMK5F install -r app\build\outputs\apk\debug\app-debug.apk
& $adb -s ZY22GHMK5F shell am start -n com.dsh.remote/.MainActivity
```

> 需要 `GRADLE_USER_HOME` 隔离时加 `-g 'D:\dsh-mobile-app\.gradle-home'`，
> 避开 `~/.gradle/init.d/aliyun-mirrors.gradle` 与 settings repositories 的冲突。

## 验证证据

| 项 | 结果 |
|---|---|
| 单元测试 | `tests=118 failures=0 errors=0 skipped=0`（9 个测试类） |
| APK | 7,485,956 B（第 11 步后全量构建） |
| 真机 instrumented | `PageProbeJsTest` 7 条 `OK (7 tests)`（`8PCE7LJB99VG7TRO`，Android 15） |
| lint | 0 error / 27 warning |
| 局域网 | 扫码/手输后进入 DSH 主界面 |
| 公网 4G | 关 Wi-Fi 走 4G，Redmi `8PCE7LJB99VG7TRO` 一次通过（证据图 `docs/evidence/step7-public-4g.png`） |
| PIN 页自愈 | CDP 抓到 `?token=…&dsh-pocket-retry=1` 重连跳 + cookie 重新下发 |
| 反向分支 | 地址不带 token 时停在验证页、不清 cookie（`tools/verify-ask-user.cjs` 三项全过） |
| 键盘弹出 | 帧间隔中位数 11ms，全程 177ms，单调无回弹 |
| 键盘收起 | rootH 574→895，composerTop 324→484，逐帧 |

## 调试工具链（`tools/`）

真机屏幕录制在本机是坏的（`screenrecord` 退出码 235、落盘 0 字节，MTK `c2.mtk.avc.encoder` 起不来；`screencap` 单帧 1.5s，也采不到 300ms 动画）。所以全部测量走 **CDP**。

| 脚本 | 用途 |
|---|---|
| `cdp-forward.cjs` | 重建 `adb forward tcp:9222`（App 每次重装 socket 名都变，必须重跑） |
| `watch-net.cjs <port> <秒>` | 监听 Document 级请求/响应/失败，末尾给「Document 请求总数」。**判断「点击到底有没有发出导航」的最佳工具** |
| `probe-netstack.cjs <port> [--navigate URL]` | 区分「WebView 网络栈坏死」与「我们自己的 loadUrl 有问题」 |
| `verify-selfheal-net.cjs [port]` | 弄脏 `dsh_pocket_token` → 导航 → 断言出现带 `token=`+`dsh-pocket-retry=1` 的重连跳 |
| `verify-selfheal.cjs` | 同上但不抓网络事件（分钟级采样页面正文） |
| `verify-ask-user.cjs` | 反向分支：地址不带 token 时断言「不重连、不清 cookie、停在验证页」 |
| `simulate-stale-cookie.cjs {dump\|stale}` | 只做 cookie 查改，用于手工造故障 |
| `tap.cjs <x> <y> [serial]` | MIUI 上可靠的点击（走 `monkey -f`），`Events injected = 0` 时退出码 2 |
| `measure-smooth.cjs` | 两阶段测键盘弹出：先 BACK 收干净，再 tap，逐帧输出 composerTop 与帧间隔 |
| `verify-collapse.cjs` | 单独测收起方向（漏发 h=0 会让 `#root` 卡在矮高度） |
| `trace-keyboard-calls.cjs` | 包一层 `__dshNativeKeyboard`，打出每次入参 + `#root` 实际高度 |
| `measure-sync.cjs` | 同钟对齐原生 `bottomMargin` 与页面 `innerHeight`（当初定案靠它） |
| `test-page-drive.cjs` | 对照实验：页面 rAF 自驱能否逐帧 |
| `probe-bg.cjs` / `probe-composer.cjs` | 探页面背景色 / composer 祖先链的 transition 与 flex 属性 |
| `tap-composer.cjs` | 取 composer CSS 坐标 + adb tap，含密度换算（CSS px × 1080/innerWidth） |

`_` 前缀的是早期一次性探针（`_probe-cur.cjs`、`_probe-page.cjs`、`_probe-storage.cjs`、`_tabs.cjs`、`_test-reset.cjs`），留作参考，不进主流程。

CDP 转发要点：`cat /proc/net/unix | grep webview_devtools_remote` 会返回两条，必须选**不带 `browser_` 前缀**的那条。

## 待办（下一档 B）

- 补 `androidTest`：WebView 同域判定、cookie 清除→重导航、键盘 insets、扫码链路目前只有手跑脚本
- 拆 `MainActivity`（911 行）：抽 `RecoveryExecutor` / `ConnectionRepository`
- 隧道地址自动读回（quick tunnel 每次变，现在要手动重扫；走 dsh-pocket 的 `pocket.status` RPC）
- 前台服务保活（现在靠 `svc power stayon true`，不该长期开）
- 任务完成通知（DSH 的 SSE 完成事件）
- 文件/拍照附件通道
- 局域网自动发现（现在是扫固定二维码或填地址）
- 多电脑快速切换（数据结构已支持，UI 已有列表，缺一键切）

## 依赖现状

`dsh-pocket` 2.12.0 必须保持运行（它提供反代与认证）。PIN 在 `~/.dsh/dsh-pocket/token-lan`，
**不要把它写进仓库**——需要把它内置成首次启动地址时，填进 `local.properties`（已 gitignore）。
