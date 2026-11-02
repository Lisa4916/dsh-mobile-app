# dsh-mobile-app — DSH 手机遥控

自研 Android 外壳 App：把电脑上的 DeepSeek Harness 搬到手机，同一份会话、同一批文件。

## 现状

**v0.3 起（第 22 步）：装完不必先扫码。** 全新安装且手机里没有任何连接档案时，
App 会自己在同一 Wi-Fi 的 /24 里扫一遍（254 个地址并发、约 2 秒）找电脑；
扫到就只需要输一次 8 位 PIN，扫不到才回落到扫码或手输。

**局域网与公网都已在真机跑通。** 手机屏幕上就是电脑上正在进行的同一段对话，
含流式输出、工具卡片、子智能体状态。公网走 Cloudflare quick tunnel，关掉 Wi-Fi 走 4G 也能进主界面。

入口类型由 App 自动判断并标注（局域网 / 公网 / 本机），公网快速隧道地址会提示「每次重开都会变」。

**分发**：发给另一台手机不用连线，走 	ools\publish-apk.cjs + 局域网下载页，或者走 GitHub Release（	ools\publish-release.cjs，手机存一个固定网址即可）。见「给第二台手机装机与收更新」。

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
| `MainActivity.kt` | 955 | 连接列表 + 全屏 WebView + 扫码/手输 + 键盘避让编排（只留必须有 Android 才能做的事） |
| `WebViewFactory.kt` | 674 | WebView 配置的唯一出口（JS/DOM Storage/同域跳转/错误回调/document-start 脚本/键盘 hook） |
| `Endpoint.kt` | 215 | 连接档案模型 + 5 列行式序列化 + URL 解析 + 入口类型推断（局域网/公网/本机） |
| `ScanActivity.kt` | 187 | CameraX 预览 + ZXing 解码，只认真 http(s) 结果 |
| `PageProbe.kt` | 173 | 页面状态判据：`JS_TITLE`/`JS_BODY` 只管取值，`classify()` 是纯函数，`decodeJsString()` 还原回调值 |
| `RecoveryExecutor.kt` | 157 | 自愈编排：探针结果 → 动作，经 `RecoveryEnvironment` 接口注入副作用 |
| `HandshakeHealGate.kt` | 131 | 自愈的节流闸门：每次事故最多动作 3 次、退避 5→10→20→30s |
| `RecoveryPlanner.kt` | 129 | 页面状态 → 恢复动作的纯决策（不碰 Android API） |
| `BackNavigationDecider.kt` | 123 | 返回键语义：页面七层，一次只退一层（只有首页才退出 App） |
| `ConnectionRepository.kt` | 69 | 档案读写接口 + `AutoConnect.decide()` 三态（Connect / Seed / ShowList） |
| `BootstrapUrl.kt` | 68 | 内置地址拼接（host + PIN → 完整 URL），不硬编码任何真实地址 |
| `HostMatch.kt` | 63 | 「算不算同一个站」的唯一判据：host 精确比对 + 点子域边界，`mailto:`/`tel:` 不丢浏览器 |
| `LanDiscovery.kt` | 276 | 局域网自动发现：`LanScan`（纯 JVM，候选地址/正文判据/免 PIN 判据/搬 PIN）+ `LanDiscovery`（48 并发扫 254 个地址，约 2 秒，返回 `LanHit(host, open)`） |
| `LanAdopt.kt` | 96 | 扫到之后怎么办的纯决策：`Adopt` / `AskPin` / `None`，**免 PIN 电脑直接连、多台电脑答话时绝不搬 PIN** |
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
| `BackNavigationDeciderTest` | 18 | 返回键七层逐层断言 + 层内不越级 |
| `BootstrapUrlTest` | 10 | 内置地址拼接、scheme/尾斜杠容错、空值返回 null |
| `CookieNamesTest` | 10 | 前缀精确匹配、值里出现名字不算、过期指令只作用一个名字 |
| `HandshakeHealGateTest` | 10 | 节流与退避 |
| `HostMatchTest` | 17 | 判同域 + **6 条反面用例**（host 在 query / fragment / 子域后缀 / 路径段 / 相似域名一律判外链） |
| `AutoConnectTest` | 7 | lastUsed 优先、无地址宁可停在列表、seed 的 kind 由 URL 推断 |
| `LanDiscoveryTest` | 29 | 候选地址（钉 /24、排除自己与保留段）、正文判据不依赖响应长度、**免 PIN 只认响应头 `Set-Cookie: dsh-auth-`**、`tokenOf` 不认 fragment、`rebind` 保 scheme 与端口 |
| `LanAdoptTest` | 18 | 同主机直连 / 免 PIN 电脑直接连 / 单台搬 PIN / **多台一律 AskPin** / 无 PIN 不让连 / 去重 |
| **合计** | **189** | |

**真机 instrumented**：`androidTest/PageProbeJsTest` 7 条，验取值链路在真 WebView 里的行为
（中文标题含 `·` 往返、`innerText` 跳过 `display:none`、`about:blank` 不崩）。

```
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk   # -t 不能省
adb shell am instrument -w -r -e class com.dsh.remote.PageProbeJsTest \\
    com.dsh.remote.test/androidx.test.runner.AndroidJUnitRunner
```

CI 见 `.github/workflows/ci.yml`：`assembleDebug` + `testDebugUnitTest`（`--rerun-tasks`）+ `lintDebug`。
lint 当前基线 **0 error / 22 warning**（warnings 不挡合并）。

## 装完就能连：自动找电脑

装机后的第一体验以前是「请扫码或手输地址」。现在多了一步自动发现：

| 顺序 | 依据 | 用户要做什么 |
|---|---|---|
| 1 | 手机里最后使用过的连接 | 什么也不用做 |
| 2 | 构建时注入的 `dsh.lanUrl`/`dsh.lanPin`（只在本机自编译时存在） | 什么也不用做 |
| 3 | **扫同一 Wi-Fi 的 /24 找 dsh-pocket** | 电脑免 PIN 时**什么也不用做，直接进主界面**；要 PIN 时输一次 8 位数字 |
| 4 | 都不行 → 扫码 / 手输 | 去电脑前扫二维码 |

扫到之后分两种情况：

- **电脑侧关掉了「局域网要 PIN」（`lanAuthEnabled=false`）**：裸 GET 这台电脑会直接下发
  `Set-Cookie: dsh-auth-…`，App 扫到这种响应就**直接连主界面，一次都不用输**。
  判据只能是**响应头里有没有 `Set-Cookie: dsh-auth-`** —— 状态码都是 200，
  正文长度 4210/3969/522 都见过，正文里的 `DSH Pocket` 两张页都有。
- **电脑侧保留 PIN（默认）**：PIN 是**进程级**的钥匙（`~/.dsh/dsh-pocket/token-lan`），
  未认证时没有任何接口能读到；服务端也没有 mDNS/SSDP 之类的发现（`lib` 下 js 零命中）。
  这时扫描解决「电脑在哪」，但解决不了「PIN 是多少」—— 只能手输一次 8 位数字。

代价是：关掉局域网 PIN 后，**同一 Wi-Fi 内任何设备**访问 `http://<电脑IP>:3081/` 都不用密码
就能看到会话与文件。家里 Wi-Fi 可信才行；不可信就把它改回 `true`，App 会自动退回「扫到 + 输 PIN」。
公网（cloudflared 隧道）永远要 PIN，不受这个开关影响。

几条实现上的死规矩（都有单测钉着）：

- **钉死 /24**，不按真实掩码展开：/16 是 65,534 个地址，手机上跑不完。
- **判据只能看正文**（含 `DSH Pocket` / `DeepSeek Harness`），
  **不能看响应长度** —— 同一个验证页实测出现过 4210 B 与 3969 B 两种长度。
- **判「免不免 PIN」只能看响应头**里有没有 `Set-Cookie: dsh-auth-`：正文里出现
  `Set-Cookie:` 字样不算（有反面单测钉着），响应头与正文被拆成两个 TCP 段时要等头到齐再判。
- **多台电脑答话时不搬 PIN**：手机侧分不清是哪台，搬过去有可能连到别人家机器上。
  只有「唯一一台答话」且「有带 PIN 的旧档案」时才把 PIN 搬到新 IP。
- **走流量时不扫**：只在 `wlan/ap/eth/rndis` 这类接口上取本机地址，
  扫运营商 NAT 段白等两秒，一台电脑都不会有。

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
8. **返回首页不能展开侧栏。** 收起态下 `.wtg9ga_newSession` 在屏幕外（`left = -207`），但 DOM 的 `click()` **不经过命中测试**，直接点就能回首页。旧实现为了点它先把侧栏展开，用户看到的就是一条黑边横扫屏幕（侧栏滑出再收回）。另外从点击到页面切完实测要**约 2000ms**，等待上限留短了会误判失败、退回那条展开侧栏的老路，等于白改。详见 `AGENTS.md` §6.20。
9. **判同域不能用 `url.contains(host)`。** 那是子串包含：`https://evil.com/?x=<host>`、`https://<host>.evil.com/steal`、`https://evil.com/#<host>` 三种全被判成同域，外部整页留在没有地址栏的 WebView 里，外面还挂着 JS 桥。现在统一走 `HostMatch`（host 精确比对 + 点子域边界）。
10. **`themes.xml` 里的 `windowLightStatusBar` 只在启动那一刻生效。** edge-to-edge 下状态栏底下就是页面本身，页面是深色（实测状态栏区域亮度 `p50=21`）而图标也是深色，时间电量直接看不见。进出页面要各调一次 `applyBarIconTheme`。
11. **不覆盖 `onRenderProcessGone` 的话，渲染进程被回收会把整个 App 带走。** 而渲染进程被清在这台机器上是常态（logcat：`ProcessSceneCleaner: SwipeUpClean: kill procName=…:sandboxed_process0`）。死掉的 WebView 不能复用，`loadUrl` 静默不生效，只能销毁重建。非 root 杀不掉沙箱进程，验证要用 CDP 的 `Page.crash`（`tools/crash-page.cjs`）。
12. **应用分身里也会装同名包。** 桌面上出现 3 个同名图标、点图标弹「选择要使用的应用程序」时，先 `pm list users` 查 900/901 分身用户，再 `pm uninstall --user N <pkg>`。别先怀疑 `am start` 的写法。
13. **启动时侧栏闪一下，是页面的 CSS 过渡，不是我们的代码。** `data-sidebar-collapsed="true"` 首帧就在 DOM 上，但 `transform` 要等 hydration 之后才写上去，中间那 280ms 就是「展开了又收回去」。修法是 document-start 注入一条 `transition:none`，**只禁过渡、不写死位置**。别去改 `DSH_GO_HOME_JS` —— 启动路径根本不调它（只有按返回键才调），改它只会把返回键弄坏。详见 `AGENTS.md` §6.27。
14. **返回键要「一次只退一层」，页面其实有七层。** 旧版只认 `session / home / other` 三档，于是「首页 + 侧栏展开」按返回**直接退出 App**（多退了一步），而「会话知识库面板开着」会把手底下的会话页拉回首页（又少退了一层）。现在按 `panel → overlay → sidebar → session → feature → home` 判，每层只对应一个动作。两个坑：会话页也有 `aria-selected="true"`，所以 `session` 判据必须排在 `feature` 前面；`Escape` 对面板和会话页完全无效（实测 `layerN 0→2→2`），只有抽屉和菜单认它。详见 `AGENTS.md` §6.28。
15. **「装完就能连」不能靠服务发现。** dsh-pocket 服务端 `lib` 下所有 js 里 `mdns|bonjour|discovery|broadcast|multicast|ssdp` **零命中**，它既不广播也不响应发现，手机侧只能自己扫 /24。三条实测结论：① 254 个地址、并发 48、TCP 超时 300ms，**1.86 秒**扫完；② **不能拿响应长度当指纹** —— 同一个「访问验证」页实测出现过 4210 B 与 3969 B 两种长度，判据只能是正文含 `DSH Pocket`；③ PIN 是 dsh-pocket **进程级**的钥匙（`~/.dsh/dsh-pocket/token-lan`），未认证时读不到，所以扫描能解决「电脑在哪」但解决不了「PIN 是多少」。详见 `AGENTS.md` §6.31。
16. **让「装完直接进主界面」不能靠编 PIN，只能靠电脑侧放行。** 全新安装时手机里没有 PIN，也没有接口能读到它；把 PIN 编进公开仓库的 Release 包等于把钥匙发给每个下载的人。唯一干净的做法是电脑侧关掉 `lanAuthEnabled`（dsh-pocket 官方开关，`lib/index.js:336-339` 的 `isProtected` 对局域网返回它；公网永远要 PIN），App 扫到「裸 GET 就下发 `Set-Cookie: dsh-auth-`」的电脑就直接进主界面。代价是同一 Wi-Fi 内任何设备免密可见会话与文件。详见 `AGENTS.md` §6.32。

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

## 给第二台手机装机与收更新

装过一次之后就不必再接电脑了——**用浏览器下载页**，以后每次刷新同一个地址就是新版本。

### 第一次

```powershell
# 1) 构建 release 并发布到 dist/（会自动读 version.properties 的版本号）
node tools\publish-apk.cjs

# 2) 起局域网分发页（保持这个窗口开着）
node tools\serve-apk.cjs
```

第二步会打印本机局域网地址，例如 `http://192.168.50.58:8123/`。
另一台手机连**同一个 Wi-Fi**，浏览器打开这个地址 → 点「下载并安装」。
第一次装需要在浏览器提示里允许一次「安装未知应用」。

### 之后每次更新

```powershell
node tools\publish-apk.cjs --bump patch   # 版本号 +1，重新构建发布
```

手机上刷新下载页（或直接开 `http://<IP>:8123/`），点下载覆盖安装即可。

**覆盖安装不会丢已保存的连接** —— 连接列表在 SharedPreferences 里，只有卸载才会清。
`dist/latest.json` 里有版本号、大小和 SHA-256，手机上想核对就点开 `http://<IP>:8123/version.json`。

### 三条容易踩的前提（都已固化进脚本）

1. **同一个包名只能用同一张证书。** release 现在用 `release/dsh-remote.jks`
   （`CN=DSH Remote`，`SHA-256 12912cf9…`），在 `local.properties` 里配好就会自动用它。
   **换证书 = 手机上那个包再也覆盖不上**，只能卸载重装（连接列表跟着丢）。
   keystore 与密码在 `release/` 下，已 gitignore —— **务必自己备份一份**，
   丢了就再也发不出能覆盖安装的包。
2. **versionCode 只能升不能降。** 现在由 `version.properties` 显式管理——**不要改成 git 提交数**，
   CI 是浅克隆会算成 1，打出来的包比手机上装的还旧，只能卸载。
3. **装 release 而不是 debug。** debug 包体积 7.3 MB（release 1.8 MB）、带 `debuggable`、
   开着 WebView 调试。日常用 release，只有要抓 CDP 时才临时装 debug。

> `dist/` 与 `release/` 都已 gitignore。分发页只服务局域网，没有鉴权，
> 别把这个端口转到公网 —— 里面虽然不含 PIN（PIN 存在每台手机自己的 SharedPreferences 里），
> 但没必要对外暴露你的构建。

## 用 GitHub Release 发版（手机不用连电脑）

上面那套要求电脑开着、两台设备同一 Wi-Fi。走 GitHub 之后，手机只需要**一个固定网址**：

```
https://github.com/Lisa4916/dsh-mobile-app/releases/latest/download/dsh-remote-latest.apk
```

这个地址永远指向最新一个 Release 的同名 asset。存成手机浏览器书签，
以后电脑这边推一个 tag，手机上刷新就是新版。

**这条通道已经跑通了**：仓库 `Lisa4916/dsh-mobile-app`（public），
Release `v0.2.0` 已发布 `dsh-remote-0.2.0-2.apk` / `dsh-remote-latest.apk` / `SHA256SUMS.txt`。
上面那个链接实测 `302 → 302 → 200`，下载 1,930,818 B，
SHA-256 `b10f0153…cd2770f8` 与 `SHA256SUMS.txt` 一致；
`aapt2` 确认 `versionCode='2' versionName='0.2.0'`，签名是 `CN=DSH Remote`。

> 本机 `github.com:443` 的 TLS 有时被拦（`api.github.com` 却正常），这时 `git push` 会挂。
> 发版前先 `git ls-remote origin` 探一下；不通就修代理规则，或改走 Contents API 提交（见 AGENTS §6.30）。

### 一次性准备

**1. 在 GitHub 建一个空仓库**（private 也可以），然后：

```powershell
cd D:\dsh-mobile-app
& 'C:\Program Files\Git\cmd\git.exe' remote add origin https://github.com/<你>/<仓库>.git
& 'C:\Program Files\Git\cmd\git.exe' push -u origin master
```

**2. 把签名材料加到仓库的 Actions secrets**（Settings → Secrets and variables → Actions → New repository secret）。
需要四个，名字必须完全一致：

| Secret | 值 | 从哪来 |
|---|---|---|
| `KEYSTORE_BASE64` | keystore 文件的 base64 | `release/keystore.b64` 的全文（一行，别换行） |
| `KEYSTORE_PASSWORD` | keystore 口令 | `release/password.txt` |
| `KEY_ALIAS` | `dsh-remote` | 固定 |
| `KEY_PASSWORD` | 与 keystore 口令相同 | `release/password.txt` |

生成 base64 的命令（会直接写进 `release/keystore.b64`）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\dsh-mobile-app\release\dsh-remote.jks')) |
    Set-Content D:\dsh-mobile-app\release\keystore.b64 -Encoding ascii -NoNewline
```

> 这一步在 GitHub 网页上做，`gh` CLI 也行。**别把 keystore 或密码提交进仓库** ——
> 拿到了就能签一个同证书的包覆盖安装到你手机上。

**3. 打开 Actions**：仓库的 Actions 页面首次会要求允许 workflow，点一下即可。

### 每次发版

```powershell
cd D:\dsh-mobile-app
node tools\publish-release.cjs --bump patch     # 版本 +1 并提示你先提交
& 'C:\Program Files\Git\cmd\git.exe' add -A
& 'C:\Program Files\Git\cmd\git.exe' commit -m "chore(release): 版本升到 0.2.1"
node tools\publish-release.cjs --no-bump        # 打 tag 并推送
```

第二条命令（`publish-release.cjs --no-bump`）推的是 **tag**，不推代码 ——
所以 tag 一定对应一个已经提交的状态，事后能回答「这个版本到底是哪份代码」。

推送后 [release.yml](.github/workflows/release.yml) 会：
校验 tag 与 `version.properties` 是否一致（不一致直接失败）→ 用 secrets 签 release 包 →
`apksigner verify` 复核 → 建 Release 并挂上 APK（稳定名 + `dsh-remote-latest.apk` + `SHA256SUMS.txt`）。

### 手机上收更新

浏览器打开那个固定地址 → 下载 → 覆盖安装。**不会丢已保存的连接**。

想确认拿到的是哪一版：Release 标题就是 `DSH 手机遥控 0.2.1`，
或打开 `https://github.com/<owner>/<repo>/releases/latest` 看正文里的版本号与 SHA-256。

### 两条边界

- **公开仓库要注意**：Release 的 asset 是公开可下的（private 仓库的 Release 也要登录才能下）。
  这个包里不含 PIN，但含你的包名与签名 —— 不想公开就把仓库设成 private。
- **Release 只发 release 包**，不带 `debuggable`。要抓 CDP 调试还是本机 `adb install` debug 包。

## 验证证据

| 项 | 结果 |
|---|---|
| 单元测试 | `tests=189 failures=0 errors=0 skipped=0`（12 个测试类） |
| APK | `app-debug.apk` 7,312,868 B / `app-release.apk` 1,930,946 B |
| 装完直进 | release 包全新安装清数据后冷启动 `TotalTime: 522`，直接落 DSH 主界面，无 PIN 屏（`build-artifacts/v05-rel-first.png`） |
| 返回互逆 | `tools/verify-back-layers.cjs` 7 场景全过（面板 / 菜单 / 抽屉 / 会话 / 功能视图 / 首页各按一次只退一层） |
| 真机 instrumented | `PageProbeJsTest` 7 条 `OK (7 tests)`（`8PCE7LJB99VG7TRO`，Android 15） |
| lint | 0 error / 22 warning |
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
| `eval-page.cjs` | 调页面最短路径：`node eval-page.cjs <cdpPort> "<js>"` 或 `--file`，调 DOM 逻辑首选 |
| `probe-sessions.cjs` | 打开侧栏并列出会话条目，用于「进会话→按返回」的重放 |
| `probe-sidebar.cjs` | 列出按钮几何与 `aria-label`，页面改版后重新定位选择器 |
| `record-back.cjs` | 触发返回 + CDP 连拍 + DOM 采样，抓 1 秒内中间态；**验证返回动效是否闪屏就看它** |
| `crash-page.cjs` | 用 CDP `Page.crash` 让渲染进程真崩，验证 `onRenderProcessGone` 兜底（非 root 的 `pkill` 杀不掉沙箱进程） |
| `probe-startup.cjs` | 冷启动逐帧采样侧栏位置，判「启动时闪不闪」。能在 CDP 连上之前的时间窗里靠边等边连抢到采样点 |
| `probe-frame-attrs.cjs` | document-start 装 MutationObserver，抓首帧 `data-sidebar-collapsed` 与侧栏 `transform`，证明「属性先到、样式后到」 |
| `probe-sidebar-anim.cjs` | 逐帧记 `getAnimations()` + `transitionrun`，区分「CSS 过渡」与「JS 直接跳」（修法完全不同） |
| `verify-no-sidebar-flash.cjs` | 注入去过渡样式后 reload 复测，验证侧栏修法有效 |
| `probe-layer.cjs` | 把页面构造到 7 种层叠状态，逐一打印页面自报的层（panel/overlay/sidebar/session/feature/home），改判据前后都跑 |
| `verify-back-layers.cjs` | 7 个场景各按一次真实返回键，断言「只退一层」。**「返回是否与进入互逆」的唯一判据** |
| `publish-apk.cjs` | 构建 release 并发布到 `dist/`（APK + `latest.json` + 自包含下载页）；`--bump patch` 先把版本号 +1 |
| `serve-apk.cjs` | 把 `dist/` 发布成局域网下载页（默认 8123），另一台手机浏览器打开即可装机与收更新 |
| `publish-release.cjs` | `node tools/publish-release.cjs --bump patch` 升版本并提示提交；`--no-bump` 打 tag 并推送，触发 `release.yml` 建 GitHub Release |

`_` 前缀的是早期一次性探针（`_probe-cur.cjs`、`_probe-page.cjs`、`_probe-storage.cjs`、`_tabs.cjs`、`_test-reset.cjs`），留作参考，不进主流程。

CDP 转发要点：`cat /proc/net/unix | grep webview_devtools_remote` 会返回两条，必须选**不带 `browser_` 前缀**的那条。

## 待办（下一档 B）

- 体检剩余四项：删掉零使用的权限（`POST_NOTIFICATIONS` / `ACCESS_NETWORK_STATE`）与 9 条无用资源、
  release 构建补齐（`proguard-rules.pro` 缺失 + 无签名）、长按删除加确认、收敛 39 处中文字面量与 8 处硬编码颜色
- `androidTest` 覆盖仍不全：cookie 清除→重导航、键盘 insets、扫码链路只有手跑脚本
  （同域判定已在第 14 步补成 17 条 JVM 单测）
- `MainActivity` 仍有 955 行：`buildUi()` 约 128 行代码造 UI（无 layout XML），可拆 `HomeView` / `WebPanel`
- 隧道地址自动读回（quick tunnel 每次变，现在要手动重扫；走 dsh-pocket 的 `pocket.status` RPC）
- 前台服务保活（现在靠 `svc power stayon true`，不该长期开）
- 任务完成通知（DSH 的 SSE 完成事件）
- 文件/拍照附件通道
- 局域网自动发现（现在是扫固定二维码或填地址）
- 多电脑快速切换（数据结构已支持，UI 已有列表，缺一键切）

## 依赖现状

`dsh-pocket` 2.12.0 必须保持运行（它提供反代与认证）。PIN 在 `~/.dsh/dsh-pocket/token-lan`，
**不要把它写进仓库**——需要把它内置成首次启动地址时，填进 `local.properties`（已 gitignore）。
