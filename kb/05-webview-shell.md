# WebView 外壳 + JS 桥：把 Web 应用包成手机 App

> 适用环境：Android 15 / SDK 35，WebView（Chromium）版本随系统。实测于 Redmi Note 12T Pro。
> 最后验证：2026-10

## 什么时候该选 WebView 外壳

**先做判断，再写代码。** 只有当被包的那一方**已经提供了自己的移动端适配和认证入口**时，外壳才成立。

三条依据（缺一条就不要走外壳）：

1. 目标站点已经有成熟的移动端布局，不需要重新实现 UI；
2. 已有官方或社区提供的移动端适配方案可以直接复用（例如别人做的移动端 CSS 移植）；
3. 认证已经由该页面自己的 token/cookie 机制解决，不需要你在 App 里重做登录。

反例（会白干）：直接去打包一个只提供桌面 UI 的应用，然后指望 WebView 帮你"自动适配"。WebView 不做响应式，它只是浏览器。

## 核心结构

```
手机 App (WebView)
   └─> 中间层（反向代理 / 端口转发）
         └─> 目标服务
```

三层分开的价值：中间层挂了可以单独排查，不用重装 App；目标服务换端口时只改中间层。

## 关键设置：WebView 初始化

```kotlin
val wv = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.databaseEnabled = true
    settings.setSupportZoom(false)          // 关缩放，避免双指误触
    settings.builtInZoomControls = false
    settings.mediaPlaybackRequiresUserGesture = false
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    setBackgroundColor(0xFF151517.toInt()) // 与页面底色一致，防止白闪
    layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
}

webViewClient = object : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
        // 外链走系统浏览器，内链留在 WebView
        val host = req.url.host ?: return false
        return if (host in ALLOWED_HOSTS) false else {
            context.startActivity(Intent(Intent.ACTION_VIEW, req.url)); true
        }
    }
}

webChromeClient = object : WebChromeClient() {
    override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        Log.i("chromium", "[${m.messageLevel()}] ${m.message()} @ ${m.sourceId()}:${m.lineNumber()}")
        return true                     // 返回 true 抑制系统重复打印
    }
}
```

## 坑 1（与直觉相反）：`setJavaScriptEnabled` 之外的开关都是次要的

排查"页面白屏"时，人会本能地去加各种 settings 开关。实测：**只有 `javaScriptEnabled` 和 `domStorageEnabled` 是真必需的**，其余开关加减都不影响那个页面能不能渲染。白屏要往别处查（见下面的坑 2、坑 3）。

## 坑 2：底色不一致 → 白闪

- **现象**：页面加载瞬间闪一下白，暗色主题下特别刺眼。
- **根因**：WebView 默认底色是白色，`#root` 渲染出来之前的那几帧露的是它。
- **正确做法**：三处一起设成同一个暗色：主题的 `android:windowBackground`、WebView 的 `setBackgroundColor`、页面 `html` 的 background。只改一处没用。

## 坑 3：`document-start` 注入被首页重置

- **现象**：用 `evaluateJavascript` 在 `onPageStarted` 里注入的 hook，页面加载完后调不到。
- **根因**：`onPageStarted` 时 document 还没建完，注入的全局变量随后被页面自己的脚本覆盖，或者注入落在旧 document 上。
- **判据**：注入后立刻读回：`evaluateJavascript("typeof window.__myHook")`，返回 `"undefined"` 就是没注进去。
- **正确做法**：改在 `onPageFinished` 注入，并让注入函数**幂等**。**例外**：要拦截“页面渲染完成后立刻发生”的事件（如自动聚焦输入框、自动弹键盘），`onPageFinished` 已经太晚，必须 document-start 注入（实测：等 onPageFinished 注入时页面已聚焦完，键盘区已让位）——开头先判断 `if (window.__myHook) return;`。这样多次触发不会重复注册事件监听导致重复执行。

## 坑 4：JS 桥的单位是设备像素还是 CSS px

- **现象**：从原生传给页面的尺寸值，页面拿来算布局时大得离谱（例如 885 而不是 322）。
- **根因**：`@JavascriptInterface` 方法原样返回 int 时是**设备像素**，页面的 `innerHeight` / CSS 尺寸是 **CSS px**，两者差一个 `density`（实测机型 2.748）。
- **正确做法**：在 JS 桥里就换算，不把换算责任丢给页面：

```kotlin
@JavascriptInterface
fun keyboardHeight(): Float = host.currentKeyboardHeight / host.resources.displayMetrics.density
```

- **判据**：在页面上打 `window.devicePixelRatio`，与桥里用的 density 对比，应当相等。

## 坑 5：JS 桥方法签名变更不会报编译错

- **现象**：改了 Kotlin 侧返回类型（`Int` → `Float`）后页面行为诡异，但 Gradle 完全没报错。
- **根因**：JS 桥是运行时字符串匹配，没有类型契约。Kotlin 编译不了错，页面拿到 `undefined` 也不会抛到原生。
- **正确做法**：**每次改 JS 桥签名后，在页面里手动验证一次**：

```javascript
// 在 CDP 里跑
console.log(typeof window.dshNative.keyboardHeight, window.dshNative.keyboardHeight());
```

## 调试前提：开 WebView 调试

```kotlin
if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
```

不开这个，`chrome://inspect` 和 CDP 全都看不到页面（详见《ADB + CDP 真机调试》一篇）。

## 坑 6（与直觉相反）：SPA 在 WebView 里没有「历史层」，返回导航必须问页面自己

> 实测环境：Motorola 机型（launcher `com.motorola.launcher3/…CustomizationPanelLauncher`，`dpr`≈2.075），2026-11-01。

- **现象**：在会话页按返回，按键返回行为正确，但侧滑手势直接退出 App，两条路径表现不一致。
- **根因 1**：侧滑手势返回由 `OnBackPressedDispatcher` 派发，**根本不产生 KEYCODE_BACK**，所以 `onKeyDown` 对手势完全失效。必须改用 `onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { … })`。
- **根因 2**：被包的 DSH 是纯 SPA，进会话后 `location.href` 与 `history.length` 都不变（实测进会话前后是同一个值），WebView 历史栈里没有「会话」这一层。`canGoBack()` 指的全是页面级重载，用它做后退只会整页刷新并回到同一个会话。
- **正确做法**：问**页面自己**当前在哪一级——`webView.evaluateJavascript(WebViewFactory.DSH_LOCATION_JS)` 读回 `"session"` / `"home"`（注意 `raw?.trim('"')`，`evaluateJavascript` 的结果是带引号的 JSON 字符串），再按层级决策：

```kotlin
when (where) {
    "session" -> { backSteps++; webView.evaluateJavascript(WebViewFactory.DSH_GO_HOME_JS, null) }
    "home"    -> finish()          // 已是开始界面 → 退出 App
    else      -> if (backSteps > 0) finish()
                 else webView.evaluateJavascript(WebViewFactory.DSH_GO_HOME_JS, null)
}
```

- **目标链路**：会话页 → 开始界面（会话列表/首页）→ **退出 App**。最后一步是退出 App，不是回落到 App 自己的连接列表页。
- **兜底**：页面状态认不出（还在加载）时用 `backSteps` 计数——已经退过一级就 `finish()`，否则先把页面拉回开始界面当保险，否则会卡在重载里反复转圈。
- **判据（真机双路径各测一遍）**：会话页返回后 `where=home` 且前台仍是 `com.dsh.remote/.MainActivity`；在开始界面再返回，`mCurrentFocus` 变成 launcher 窗口。按键（`adb shell input keyevent KEYCODE_BACK`）与手势（左边缘内滑）都必须走同一条路径。
- **附带**：快速连按 3 次返回 → 正常走到桌面、无崩溃无卡死；Activity 被系统回收重建后仍能正确判定为 `home`，注入的 document-start 脚本依旧生效。

## 启动密码是误会：App 没有启动锁

> 适用环境：dsh-mobile-app（WebView 外壳 + dsh-pocket 页面），Android 15 / SDK 35。
> 最后验证：2026-10

- 需求走向：用户先提「软件启动时需要密码」，随后明确撤回「软件启动不需要密码」。**撤回后不要加任何本地启动校验**，代码保持不动。
- 事实依据：`MainActivity.onCreate()` 里是 `autoconnect()` 直接取 `store.lastUsed()` 连过去，没有任何密码/PIN 的本地校验分支。

### 判据：看到的「输 PIN / 访问密码」页不是原生锁

- **现象**：冷启动后页面停在「访问验证 / 访问密码」。
- **根因**：WebView 里的局域网会话 cookie `dsh_pocket_token` 丢了，页面自己退回 dsh-pocket 的访问验证页。**这是页面侧登录态问题，不是 App 启动锁。**
- **排查入口分叉**：怀疑启动锁 → 查 `MainActivity`；看到密码页 → 查 WebView 的 `CookieManager` 与页面登录态持久化（目标：扫码/PIN 输一次后长期免输）。
- **旁证（与直觉相反）**：`HEAL_PROBE_JS` 里已经为这个页面单独留了判据——`访问密码` / `访问验证` 一律返回 `'0'`，不当作握手故障去清 cookie。说明这个页面历史上出现过，遇到时不要误判成 JS 桥故障而去清登录态。
