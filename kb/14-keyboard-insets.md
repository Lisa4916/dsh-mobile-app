# WindowInsets 与输入法键盘避让：为什么 WebView 的键盘动画必须由页面驱动

> 适用环境：Android 15 / SDK 35，Redmi Note 12T Pro（density 2.748，屏幕 1080×2460），键盘高度约 885 设备像素 / 322 CSS px。
> 最后验证：2026-10，含逐帧实测数据。

## 这是本文最重要的一条（与直觉相反）

**原生侧逐帧压缩 WebView 高度，页面拿到的尺寸变化不是逐帧的，而是约每 108ms 一批提交。** 结果就是"键盘在动，界面一顿一顿地追，速度只有键盘的一半"。

正确分工：**WebView 保持全屏不动，键盘避让（页面内容上移）由页面自己的 `requestAnimationFrame` 补间完成。**

## 症状

用户的原话是"键盘与界面移动速度不同步"。视觉上：键盘平滑滑上来，页面内容跳着往上追，中途有留白一闪。

## 根因（定量证据，别再猜）

用同一面墙的 `Date.now()` 同时记录原生和页面两侧：

```
原生侧（在 applyKeyboardHeight 里打点）
  bottomMargin: 15 → 885，共 53 次更新，跨度 456ms，约每 7ms 一次   ✅ 逐帧

页面侧（rAF 每帧记 window.innerHeight）
  innerHeight: 895 → 573，共 19 个变化点，跨度 897ms               ❌ 两倍时长
  变化点间隔：约 108~120ms 一跳，每跳 60~110px
```

两次采样的**起始时刻只差 6ms**（几乎同时开始），所以不是"延迟启动"，而是**页面侧的尺寸变化被批处理了**。

## 判据：怎么确认是这个问题

1. 页面里装采样器，rAF **每帧**记录 `{wall: Date.now(), innerH, composerTop}`，只保留变化帧 + 变化前一帧；
2. 原生侧在设尺寸的函数里打 `Log.i("DshSync", "apply h=$h wall=${System.currentTimeMillis()}")`；
3. `adb logcat -c` 清空 → 触发键盘 → 等 2.5s → 分别取两边数据；
4. 用正则从 logcat **消息体**里取 wall 时间（不要依赖 logcat 行首时间戳格式，格式会变）：

```
/apply h=(\d+) wall=(\d+) up=(\d+)/
```

5. 两边跨度相差接近 2 倍 → 就是这个根因。

## 对照实验：证明页面自驱是逐帧的

在同一页面里用 rAF 从 573 拉到 251（即 -322）：

```
帧间隔中位数 20ms，最小 7ms，最大 48ms
composerTop 单调上移：是
全程无回弹
```

**结论：页面自驱能做到 7~20ms 一帧，原生压 WebView 只能给到 108ms。** 所以方向要反过来。

### 注意一个陷阱

实验 1 里改 `html.style.paddingBottom` 从 0 到 322px，`composerTop` 只上移了 **161px**（不是 322）。因为 `#root` 的高度没变，padding 只带动了一半。
改 `#root.style.height`（573 → 251）才得到完整位移。

**判据**：静态验证 `root.height = innerHeight - 322` 时 `composerTop` 的 Δ 应当等于原生压 WebView 高度时的 Δ（实测都是 -161，比例 1:1）。等比例才说明页面侧复制原生行为不会产生额外布局差异。

## 正确实现

### 原生侧：只认终值，推一次

```kotlin
ViewCompat.setWindowInsetsAnimationCallback(root,
    object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onPrepare(animation: WindowInsetsAnimationCompat) {
            if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                imeAnimating = true
                keyboardCommitted = false
            }
        }
        // 关键：onProgress 一条都不用。它给的是动画中间态，
        // 每收一个新目标页面就重启补间，页面永远在追移动目标。
        override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>) = insets

        override fun onEnd(animation: WindowInsetsAnimationCompat) {
            if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                imeAnimating = false
                keyboardCommitted = false
                ViewCompat.getRootWindowInsets(root)?.let { applyKeyboardInsets(it, animated = false) }
            }
        }
    })

ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
    applyKeyboardInsets(insets, animated = imeAnimating)   // 这条路径给终值
    insets
}

private fun applyKeyboardInsets(insets: WindowInsetsCompat, animated: Boolean) {
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val keyboard = (ime.bottom - bars.bottom).coerceAtLeast(0)

    if (bars.top != lastBarsTop) {                       // 状态栏高度变化另走一路
        lastBarsTop = bars.top
        progress.updateLayoutParams<FrameLayout.LayoutParams> { topMargin = bars.top }
    }

    if (keyboard == targetKeyboardHeight) return

    if (animated) {
        if (keyboardCommitted) return                    // 第一帧认定后锁定
        if (abs(keyboard - targetKeyboardHeight) <= KEYBOARD_SNAP_THRESHOLD) return
        keyboardCommitted = true
    }
    targetKeyboardHeight = keyboard
    dispatchKeyboard(keyboard)
}
```

`KEYBOARD_SNAP_THRESHOLD = 90`：逐帧真实增量最大 47px，而串入的终值一帧是 322px，取 90 留一倍余量。

### 原生侧：不给 WebView 设 bottomMargin

```kotlin
private fun applyKeyboardHeight(height: Int) {
    // WebView 全程满屏，不参与键盘避让
    listRoot.updateLayoutParams<FrameLayout.LayoutParams> { bottomMargin = height }  // 只有列表页需要
}
```

### 原生侧：推到页面的值必须换成 CSS px

```kotlin
private fun notifyPageKeyboard(keyboardPx: Int) {
    if (webView.visibility != View.VISIBLE) return
    val cssPx = keyboardPx / resources.displayMetrics.density      // ← 漏了这句布局必崩
    webView.evaluateJavascript(
        "window.__dshNativeKeyboard && window.__dshNativeKeyboard($cssPx)", null)
}
```

### 页面侧：rAF 补间

```javascript
window.__dshNativeKeyboard = function (h) {
  const root = document.getElementById('root');
  const want = Math.max(0, window.innerHeight - h);   // h 已经是 CSS px
  if (want === targetH) return;
  // 动画中途被打断时，从当前真实高度续接，不要从旧目标跳回去
  fromH = animating ? root.getBoundingClientRect().height : curH;
  targetH = want; animating = true; startT = 0;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(step);
};

const DUR = 300;
const ease = t => 1 - Math.pow(1 - t, 5);   // decelerate_quint，见下

function step(now) {
  if (!startT) startT = now;
  const t = Math.min(1, (now - startT) / DUR);
  const h = fromH + (targetH - fromH) * ease(t);
  root.style.height = h.toFixed(1) + 'px';
  curH = h;
  if (t < 1) rafId = requestAnimationFrame(step);
  else { animating = false; curH = targetH; root.style.height = targetH.toFixed(1) + 'px'; }
}
```

## 曲线和时长从哪来（照抄系统的，别自己调）

1. 系统 WindowManager 的 `ime` 动画用 style `0x01030056`；
2. 它指向 `input_method_enter.xml`，`duration="300"`；
3. 插值器是 `decelerate_quint`，factor `2.5`；
4. 标准插值公式（Android 的 `PathInterpolator`）：`f(t) = 1 - (1 - t)^5`。

所以 `DUR = 300`、`ease = 1 - (1-t)^5` 不是拍脑袋，是与系统动画同曲线。

## 实测结果（修复后）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 页面变化帧数 | 19（108ms 一跳） | 22（逐帧） |
| 帧间隔中位数 | 108ms | **8~11ms** |
| 全程时长 | 897ms | **177~195ms** |
| 单调性 | 有回弹 | 单调无回弹 |

收起方向（BACK 键）同样验证：`rootH 574 → 895`，10 个变化点逐帧，页面收到 `h=0`。

## 踩过的坑（都是真的踩过）

### 坑 A：以为 `onProgress` 是终值

有一段代码把 `onProgress` 的中间态直接下发给页面，追踪到的调用序列是：

```
h=321.8（正确终值）
h=0（突降，页面从零重来）
h=34.2 → 67.3 → 101.5 → 149.5 → 190.2 → 223.6 → 257.1 → 292 → 321.8
```

页面每收一个新目标就重启补间，永远追不上。**`onProgress` 一次都不能用。**

### 坑 B：`WindowInsetsAnimationCompat` 没有 `upperBound`

想从 `onPrepare` 拿动画终值，写了 `animation.upperBound`，编译报 `Unresolved reference 'upperBound'`。

用 `javap` 查 `androidx.core:core:1.15.0` 的 `WindowInsetsAnimationCompat`，实际只有：
`getTypeMask / getFraction / getInterpolatedFraction / getInterpolator / getDurationMillis / setFraction / getAlpha / setAlpha`

**没有 `lowerBound` / `upperBound`。** 拿终值只能走 `ViewCompat.getRootWindowInsets(root)`。

### 坑 C：`setCallback` 是 package-private

```kotlin
// 编译不过
WindowInsetsAnimationCompat.setCallback(view, callback)
// 正确
ViewCompat.setWindowInsetsAnimationCallback(view, callback)
```

### 坑 D：忘记了 deltas、`ime.bottom - bars.bottom`

直接拿 `ime.bottom` 当键盘高度，在带手势条/三键导航的机型上会多算一条导航栏的高度。要减掉 `systemBars().bottom`。

## 排查顺序（下次遇到键盘问题照这个走）

1. 先确认系统**有没有**派发 insets 动画：`onPrepare` 里打 `durationMillis` 和 `interpolator`。没有就是别的问题（多半是 `adjustResize` / `windowSoftInputMode` 配错）。
2. 逐帧打自己设的尺寸值。如果每帧之间穿插了一条"终值"，说明有第二个调用路径在灌终值（本次就是 `setOnApplyWindowInsetsListener` 的终值与 `onProgress` 的中间态并发）。
3. 页面侧装 rAF 采样器，同钟对时，量跨度。跨度差 2 倍就是批处理问题。
4. 确认单位（设备像素 vs CSS px）。

## 键盘区为“不存在的键盘”让位：页面自动聚焦是根因

- **现象**：进入会话页后，底部留出一整块键盘区（实测 `#root` 高 **574px**、`--dsh-native-keyboard` = **321px**），但系统键盘根本没有弹出（`mInputShown` = **false**）。
- **判据（三条同时成立才算“假键盘”）**：`document.activeElement` 是输入框（本例为 `GRgSLq_input`）、`#root` 高度已缩到 `innerHeight - 321`、`mInputShown=false`。控件树 bounds 只能证明布局让位，**不能证明键盘存在**。
- **根因**：页面渲染完成后自动把焦点交给输入框。IME 因非真实触摸而不弹出（见《ADB + CDP 真机调试》七），但键盘避让仍按 insets 终值推了 321px。**避让逻辑本身没有错**：真实点击输入框时是 574/321px 且 `mInputShown=true`，收键盘复位 895/0px，反复验证一致。错的是“给谁让位”。
- **正确做法**：在 **document-start** 注入 `FOCUS_GUARD_JS`——非用户触摸引起的输入框聚焦，一律 `blur()` 并清选区。注入时机是关键：等到 `onPageFinished` 再注入已经晚了，那时页面已经聚焦过。（《WebView 外壳 + JS 桥》坑 3 建议在 `onPageFinished` 注入，那是针对 hook 被首页重置的情形；拦截“渲染即刻发生”的事件必须提前到 document-start。）
- **最终语义**（简单比精确可靠）：只要有触摸就放行本次聚焦，触摸后 1.2 秒作废。自动聚焦发生在渲染完成那一刻、手指未接触屏幕，因此会被回退。
- **两次失败的做法，别再试**：
  1. 触摸后 N ms 内放行：窗口短了真实点击被忽略，窗口长了挡不住自动聚焦，找不到可用阈值。
  2. 用 `elementFromPoint` 判断手指是否落在输入框上：对 `adb shell input tap` 的合成触摸不可靠。
- **验证数据**：冷启动 895/空/active 空；重新进入会话 895/空/active 空且 `mInputShown=false`；真实触摸输入框 574/321 且 `mInputShown=true`；点空白复位 895/0。反复 5 次点击切换 4 成 1，那次“失败”实为当时键盘本来开着、点空白把它收起（是正确行为而非回归）。单测 22 个全通过。
