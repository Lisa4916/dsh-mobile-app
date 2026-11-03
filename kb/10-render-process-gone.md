# 渲染进程被回收：WebView 脆弱的真正来源与兜底写法

用 WebView 做外壳的 App，闪退报告里有一大类根因是同一个：**渲染进程被系统回收了，而 App 没有接管**。不覆盖 `onRenderProcessGone` 时，平台的默认行为是**把宿主进程一起杀掉** —— 用户看到的就是「用着用着闪退」。

## 一、为什么会发生

WebView 的页面渲染跑在一个独立的沙箱进程里（`com.google.android.webview:sandboxed_process0:...SandboxedProcessService0:0`）。它在两种情况下会消失：

- **崩溃**：页面里的一段脚本或渲染管线自身出错。
- **被回收**：系统内存紧张时清掉。这一条在国产 ROM 上尤其常见，logcat 里能看到类似
  `ProcessSceneCleaner: SwipeUpClean: kill procName=com.google.android.webview:sandboxed_process0:...`

第二种是「正常的系统行为」，不是 bug，也不是你能通过改代码避免的。你唯一能做的是**它死了之后别跟着一起死**。

## 二、死掉的 WebView 不能复用

这一点必须记住：渲染进程没了之后，那个 `WebView` 实例**永久失效**。

- `loadUrl()` 不抛异常、不报错、不回调 `onReceivedError`，就是什么都不做。
- 页面停在最后一帧，看起来像卡死。
- 各种「重试」逻辑全部失效，因为它们最终都归结为再调一次 `loadUrl`。

唯一出路是销毁这个实例、造一个新的。

## 三、正确写法

```kotlin
override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
    val didCrash = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash()
    host.onRenderProcessGone(didCrash)
    return true          // ← 关键：返回 true 表示「我处理了」，阻止系统杀进程
}
```

三个硬约束：

1. **必须 `return true`。** 返回 `false` 或不覆盖，系统的兜底（杀进程）照样生效，等于没写。
2. **销毁要按 `onDestroy` 的完整顺序做**，不能只 `removeView`：
   ```
   removeView → webViewClient 重置 → webChromeClient = null →
   removeJavascriptInterface(桥名) → stopLoading() →
   loadUrl("about:blank") → removeAllViews() → destroy()
   ```
   `removeJavascriptInterface` 那一步最容易漏：桥对象会被旧实例的 JS 环境持有，不摘掉会在重建后出现「桥还能被调但宿主已经换了」的诡异状态。
3. **新实例的插入位置要对。** 本项目 WebView 上面还叠了一个 2dp 的进度条，新 WebView 必须插在进度条**之前**，否则整页 WebView 会把进度条盖住，用户看不到任何加载反馈。

### 重建之后还要做什么

- **重置自愈闸门**：新的 WebView 是新一轮连接，之前那次故障的「已修过 3 次」预算不该继续算在它头上。
- **恢复状态栏前景**：新页面是深色，图标要跟着切回浅色。
- **重新 `loadUrl` 当前端点的 URL**，而不是 `about:blank` —— 用户期待的是「页面自己回来了」，不是「回到空白页再点一次连接」。
- 如果当前没有端点（用户停在列表页），那就更简单：重建完直接 `showList()`，不要试图加载。

## 四、怎么验证（这条最容易跳过）

`pkill -9 -f sandboxed_process0` 在非 root 设备上只会得到 `Operation not permitted`。**adb 杀不掉沙箱进程**，所以「我手动杀了也没复现」不能作为「不需要写兜底」的理由。

唯一可靠的触发方式是 **CDP 的 `Page.crash`**：

```
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# 连上 DevTools 后发送 Page.crash
```

判据三条，缺一条都不算过：

1. App 的 `pidof` 崩溃前后**不变**（说明宿主进程没被带走）。
2. logcat 出现你自己的那条日志（本项目是 `render process gone (didCrash=true), rebuilding webview`）。
3. 页面**自己**回到了正常界面，没有用户操作。

日志出现两次是正常的：`Page.crash` 会让渲染进程崩两次（第一次重建时旧连接还没完全断）。不要把这个当成「重复回调」的 bug 去修。

## 五、这条经验的一般化

「某个资源没了，框架的默认处理是让整个宿主陪葬」——这类设计在 Android 里不止一处。判断标准很简单：

> 这个回调如果我不实现，框架会替我做一个**牺牲用户体验**的决定吗？

是的话就必须接管。同类的还有 `onLowMemory` / `onTrimMemory`（不实现通常没事，因为默认只是被回收）、`onTaskRemoved`、`onActivityResult` 的取消路径等。
