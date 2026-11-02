---
title: Android 16 强制 edge-to-edge 与 predictive back：WebView 外壳的完整迁移面
type: procedure
tags: android 16,edge-to-edge,predictive back,windowinsets,webview,targetsdk 36
confidence: 0.95
group: 外壳
---
`targetSdk 36` 有两个变更对 WebView 外壳类是**成对出现**的，而且都在「不报错、只是行为变了」这一档。分开做会来回返工，一起做一次到位。

## 一、edge-to-edge 不再可选

Android 15 时 `targetSdk 35` 还能靠 `R.attr.windowOptOutEdgeToEdgeEnforcement = true` 退出强制铺满；到 `targetSdk 36` 这个属性被 **deprecated 且 disabled**，没有退路。

最坑的地方在于**升级时的自测会骗人**：

> 你把 targetSdk 提到 36，在 Android 15 的真机上验，`windowOptOutEdgeToEdgeEnforcement` 仍然有效，看起来一切正常；换到 Android 16 的机器上，同一个 APK 立刻铺满全屏。

所以 edge-to-edge 的验收**必须有一台 Android 16 的设备**，Android 15 上通过不算数。

### 需要复查的 UI 部位

`WindowInsets` 没处理对，症状是「控件被状态栏/导航栏盖住」或「底部按钮顶到手势区」：

- 顶部标题栏 / 工具栏
- 底部导航栏、底部固定按钮、FloatingActionButton
- 表单与列表的上下留白
- Dialog 与 BottomSheet
- **WebView 本身**（见下）

### WebView 的两条路

区分「页面是我们的」还是「页面是别人的」，方案完全不同：

1. **页面是我们自己的** → 可以改页面：注入 CSS `env(safe-area-inset-*)`，或把 inset 通过 JS 桥告诉页面，让页面自己做 padding。好处是内容可以延伸到状态栏下方（沉浸式），坏处是要维护两套。
2. **页面是第三方的**（本项目就是这种）→ 只能**给 WebView 外面套一层容器，把 `WindowInsets.safeDrawing` 作为 padding 施加在容器上**。不要去改页面，第三方页面改不动，改了下次升级就没了。

### WebView 的背景色必须对齐

edge-to-edge 之后，WebView 没铺满的地方会露出窗口背景。本项目把窗口背景设成跟页面 `body` 实测一致的 `#151517`，就是为了避免**转场时闪白**。做法：先量页面 `getComputedStyle(document.body).backgroundColor`，再把这个值写进 `themes.xml` 的 `android:windowBackground`。写死一个「看起来差不多」的深色不够 —— 差一点点就会在转场那一帧看出来。

### 状态栏前景必须跟着页面底色动态切

`android:windowLightStatusBar` 是**静态值，只在启动那一刻生效**。edge-to-edge 之后状态栏底下就是页面本身，页面深色而图标也是深色 → 时间电量看不见。

正确做法是页面进出各调一次：

```kotlin
WindowCompat.getInsetsController(window, window.decorView).apply {
    isAppearanceLightStatusBars = !darkBackground
    isAppearanceLightNavigationBars = !darkBackground
}
```

判据不要靠眼睛：截图取状态栏那一条的亮度，深色页面应当出现明显的亮像素（本项目实测修复前 `p99=21`、修复后 `p99=255`，白底列表页 `p50=255`）。

## 二、predictive back 默认开启

`targetSdk 36` 且在 Android 16 上运行时，**predictive back 的系统动画默认开启**，而且 `onBackPressed()` 不再被调用、`KEYCODE_BACK` 也不再分发。

对 WebView 外壳的影响：

- 现有的 `OnBackPressedDispatcher` + `OnBackPressedCallback` 写法**基本可以继续用** —— AndroidX Activity 已经把它桥接到平台的 OnBackInvoked 回调了。
- 但如果代码里还在 `override fun onBackPressed()`，会在 Android 16 上**静默失效**（返回键没反应）。本项目早期就是 `OnBackPressedDispatcher`，所以没受影响；这不是运气，是因为走了 AndroidX 而不是平台 API。
- 要拿到手势进度的预览效果，需要额外实现 `handleOnBackStarted` / `handleOnBackProgressed` / `handleOnBackCancelled`。
- 临时退回：`android:enableOnBackInvokedCallback="false"`，但这是缓冲，不是方案。

### WebView 里的返回语义要自己定义清楚

平台的返回 ≠ 页面的返回。外壳类 App 必须把「返回」翻译成三档语义，且**判据要基于页面内容而不是浏览历史**：

```
WebView 不可见      → 退出 App
在会话页            → 回首页
在首页              → 退出 App
其它（页面跳转中）  → 回首页
```

别指望 `webView.canGoBack()`，单页应用（SPA）里它基本没用 —— 整个 App 只有一次真的导航，之后都是前端路由，`canGoBack()` 永远是 false。

## 三、一次做对的动作清单

1. 先把 `compileSdk` 提到 36 编译，确认不改行为。
2. 再提 `targetSdk 36`，装到 **Android 16 真机/模拟器**上。
3. 逐条对照行为变更清单（`adb shell am compat` 可逐条开关），记录哪些命中。
4. WebView 外层套 `safeDrawing` padding 的容器；窗口背景色对齐页面实测色。
5. 状态栏/导航栏前景改成页面进出各切一次。
6. 确认返回键走的是 `OnBackPressedDispatcher` 而不是 `override onBackPressed()`。
7. 返回语义按「不可见 / 会话页 / 首页」三档写，判据用页面正文而不是 `canGoBack()`。
