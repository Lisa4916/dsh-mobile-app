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
- **正确做法**：改在 `onPageFinished` 注入，并让注入函数**幂等**——开头先判断 `if (window.__myHook) return;`。这样多次触发不会重复注册事件监听导致重复执行。

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
