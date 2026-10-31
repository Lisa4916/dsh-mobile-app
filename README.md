# dsh-mobile-app — DSH 手机遥控

自研 Android 外壳 App：把电脑上的 DeepSeek Harness 搬到手机，同一份会话、同一批文件。

## 现状（2026-11-01 实测）

**已在真机跑通。** 手机截图显示的是电脑上正在进行的同一段对话，含流式输出、工具卡片、子智能体状态。

## 架构

```
手机 App（WebView 外壳）
   │ http://192.168.50.58:3081/?token=<PIN>
   ▼
dsh-pocket 反向代理 3081（已装、已跑，未改动）
   ▼
本机 dsh web（同一进程 54282）
```

选这个架构而不是原生重写，依据是：

1. DSH web 的所有路径都 401，要直连必须自己做 token→cookie 握手 + `events.mux` WebSocket。
2. 连成熟项目 `saya-ch/dsh-mobile` 都明确写着「直接打开插件提供的已认证 HTTPS 页面，不打包另一套 DSH 前端」。
3. `dsh-pocket` 已移植 `dsh-web-mobile` 的窄屏布局，移动端体验现成。

## 源码

| 文件 | 职责 |
|---|---|
| `Endpoint.kt` | 连接档案数据模型 + 序列化 + URL 解析（纯 JDK） |
| `EndpointStore` | SharedPreferences 持久化，行式序列化 |
| `MainActivity.kt` | 连接列表 + 全屏 WebView + 扫码/手输/填入示例 + 键盘避让编排 |
| `ScanActivity.kt` | CameraX 预览 + ZXing 解码，只认真 http(s) 结果 |
| `WebViewFactory.kt` | WebView 配置的唯一出口（JS/DOM Storage/同域跳转/错误回调/document-start 首页重置/键盘 hook） |
| `WebBridge.kt` | `@JavascriptInterface` 桥：`keyboardHeight()`（CSS px）、`isNativeShell()` |
| `EndpointTest.kt` | 12 条单测：解析、序列化往返、脏数据容错、id 稳定性 |

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

## 关键决策与踩过的坑

1. **`android.net.Uri` 在 JVM 单测里是 stub。** 第一次跑测试 3 条失败，全是 `Uri.parse` 抛 `Stub!`。改用 `java.net.URI`，`Endpoint` 变纯 JDK 可测。（这条在 netacc-android 的 AGENTS.md 记过，我这次又踩了一遍。）
2. **Gradle 9.4.1 与 AGP 8.7.3 不兼容**，用工程自带 wrapper（8.9），JDK 17。
3. **`adb shell input text` 在中文输入法下不可靠**，`http` 和 `://` 会被吞成 `p://`。所以 App 里加了「填入本机示例」按钮，由代码写地址，不经过输入法。
4. **截图会误导。** 三次全黑/看不到 App：一次是屏幕睡眠（`isSleeping=true`），一次是通知栏被拉下来抢焦点，一次是 WebView 渲染时序。真正的判据是 `uiautomator dump` —— 控件树里只剩 WebView（铺满全屏）和返回按钮，说明已进入 WebView 模式。
5. **网络断开的真实证据在 chromium CONSOLE**：`ResizeObserver loop completed` 的来源是 `http://192.168.50.58:3081/`，证明 DSH 的 React 前端在 WebView 里完整运行。

## 构建

```powershell
$env:JAVA_HOME='D:\AndroidDev\jdk17'
$env:ANDROID_HOME='D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'
Set-Location 'D:\dsh-mobile-app'
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    --no-daemon --console=plain -g 'D:\dsh-mobile-app\.gradle-home' :app:assembleDebug
```

`-g` 隔离 GRADLE_USER_HOME，避开 `~/.gradle/init.d/aliyun-mirrors.gradle` 与 settings repositories 的冲突。

## 验证证据

| 项 | 结果 |
|---|---|
| 单元测试 | `tests=12 failures=0 errors=0` |
| APK | `app-debug.apk` 9,710,467 B |
| 安装 | `package:/data/app/.../com.dsh.remote.../base.apk` |
| 版本 | versionName=0.1.0 |
| 真机截图 | 显示电脑上同一段对话（`深度求索中，用时 39分27秒`） |
| WebView 控件 | `uiautomator dump` 显示 WebView 铺满 1080×2460 |
| 键盘弹出 | 帧间隔中位数 11ms，全程 177ms，单调无回弹 |
| 键盘收起 | rootH 574→895，composerTop 324→484，逐帧 |

## 调试工具链（`tools/`）

真机上的屏幕录制在本机是坏的（`screenrecord` 退出码 235、落盘 0 字节，MTK `c2.mtk.avc.encoder` 起不来；`screencap` 单帧 1.5s，也采不到 300ms 动画）。所以全部测量走 **CDP**：

| 脚本 | 用途 |
|---|---|
| `cdp-forward.cjs` | 重建 `adb forward tcp:9222`（App 每次重装 socket 名都变，必须重跑） |
| `measure-smooth.cjs` | 两阶段测键盘弹出：先 BACK 收干净，再 tap，逐帧输出 composerTop 与帧间隔，给 PASS/FAIL |
| `verify-collapse.cjs` | 单独测收起方向（漏发 h=0 会让 `#root` 卡在矮高度） |
| `trace-keyboard-calls.cjs` | 包一层 `__dshNativeKeyboard`，打出每次入参 + `#root` 实际高度，用于定位「谁在改回去」 |
| `measure-sync.cjs` | 同钟对齐原生 `bottomMargin` 与页面 `innerHeight`（当初定案靠它） |
| `test-page-drive.cjs` | 对照实验：页面 rAF 自驱能否逐帧 |
| `probe-bg.cjs` / `probe-composer.cjs` | 探页面背景色 / composer 祖先链的 transition 与 flex 属性 |
| `tap-composer.cjs` | 取 composer CSS 坐标 + adb tap，含密度换算（CSS px × 1080/innerWidth） |

CDP 转发要点：`cat /proc/net/unix | grep webview_devtools_remote` 会返回两条，必须选**不带 `browser_` 前缀**的那条。

## 待办（下一档 B）

- 前台服务保活（现在靠 `svc power stayon true`，不该长期开）
- 任务完成通知（DSH 的 SSE 完成事件）
- 文件/拍照附件通道
- 局域网自动发现（现在是扫固定二维码或填地址）
- 多电脑快速切换（数据结构已支持，UI 已有列表，缺一键切）

## 依赖现状

`dsh-pocket` 2.12.0 必须保持运行（它提供 3081 代理与认证）。PIN 在 `~/.dsh/dsh-pocket/token-lan`，当前 `60111186`。
