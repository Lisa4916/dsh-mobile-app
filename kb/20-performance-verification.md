# 性能验证：Baseline Profile 与 Macrobenchmark 什么时候值得做

性能优化最容易被做成「凭感觉调」。真正能拿数字说话的工具有两个：**Baseline Profile**（让 ART 提前编译热点代码）和 **Macrobenchmark**（在真机上量启动与滚动）。但对一个几百毫秒量级的外壳 App，它们值不值得做要算清楚。

## 一、Baseline Profile 到底解决什么

不装 Baseline Profile 时，App 首次启动的代码路径大部分走「解释执行 + JIT」，等热起来才编译。Baseline Profile 是把「哪些方法在启动/首屏路径上」这份清单随 APK 发出去，让 ART 在安装时 AOT 编译它们。

官方给的数量级是**首启快约 30%**。社区实测样本（Now in Android，Pixel 7）：冷启动 `229.0ms`（有 Baseline Profile）对 `324.8ms`（无编译）—— 差 95ms。

判断要不要做：

- 启动耗时在 **几百毫秒以上**、且首屏有明显可见延迟 → 值得做。
- 启动本来就 100ms 以内、首屏是一个立刻显示的空壳 → 收益可能小于它带来的构建复杂度。

## 二、Macrobenchmark 才是「验证」那一半

Baseline Profile 的价值必须靠 Macrobenchmark 量出来，否则你无法回答「到底改善了没有」。它提供 `CompilationMode` 来对比不同编译状态：

```kotlin
@Test
fun startup() = benchmarkRule.measureRepeated(
    packageName = "com.example.app",
    metrics = listOf(StartupTimingMetric()),
    compilationMode = CompilationMode.Partial(),   // ← 换成 None / Full 做对照
    iterations = 10,
) {
    startActivityAndWait()
}
```

关键纪律：

- **必须在真机上跑**，模拟器的 I/O 与 CPU 完全不可比。
- **必须多次迭代取中位数**，单次数字没有意义。
- **必须保留对照组**（`CompilationMode.None()`），否则你不知道提升是不是来自预热。

## 三、这个项目为什么暂时不做

诚实的结论比「最佳实践都建议做」有用：

- 本项目冷启动实测 `LaunchState: COLD / TotalTime: 820ms`，其中绝大部分是 **WebView 起来 + 远程页面首屏**，不是自家 Kotlin 代码。Baseline Profile 只能优化后者。
- 真正的大头在网络上：局域网约 8 秒、公网 18~25 秒出主界面。优化 95ms 的代码执行毫无体感。
- 这里该做的是**进度反馈**（顶部进度条已经在做）和**失败兜底**，不是编译优化。

一个可以立刻用的判据：

> 把「用户感知到的等待」拆开，看自己代码占多少。占比小于 20% 的时候，先别动编译优化。

## 四、Jank 的定位思路

滚动卡顿不要凭手感。可用的层次：

1. **Perfetto / Systrace**：看主线程每个帧的耗时构成，定位是谁在阻塞。这是唯一能给出「为什么掉帧」的工具。
2. **`adb shell dumpsys gfxinfo <pkg> framestats`**：拿到每一帧的时间戳，算 jank 率。
3. **Chrome DevTools 的 Performance 面板**（WebView 场景）：如果卡的是页面里的事，`adb forward` 到 `webview_devtools_remote_<pid>`，直接录性能trace。

WebView 外壳类的特殊之处：**卡顿可能来自三层中的任意一层** —— 页面自己的 JS/布局、Chromium 的合成、还是原生层在 `onDraw` 里干了重活。先分层定位，再谈优化。

还有一种「看起来像性能问题，其实不是」的情况：**页面被整个重建**。本项目就遇到过一次，滑动返回时侧边栏滑出又收回，视觉上像掉帧，实际是多执行了一步 UI 动作。判据不是帧率，是「DOM 有没有被重建」——`Network.requestWillBeSent` 里有没有新的 Document 请求，比任何性能数字都直接。

## 五、给非性能任务的人一条底线

如果你这次不是专门做性能，只要守住三条就不会欠下大债：

1. **别在主线程做 I/O**（读文件、解析大 JSON）。
2. **别在滚动路径上做布局测量**（`wrap_content` 嵌套 + 动态改高度是最常见来源）。
3. **别让一个动作触发多次重建**（`loadUrl` 同一 URL、重复 `applyList`）。

三条都比「加个 Baseline Profile」更能影响真实体感。
