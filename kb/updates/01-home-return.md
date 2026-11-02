---
id: d7618755
title: 滑动返回/回主页：用页面内轻量视图切换替代 location.reload()
type: lesson
tags: android,webview,webview外壳,返回导航,侧栏,dom,实测,踩坑
confidence: 0.95
group: 外壳
---
> 适用环境：dsh-mobile-app 的 WebView 外壳 + DSH 内置页面（Android 15 / SDK 35，Chromium 117 与 131 都验过）。页面元素的 hash 类名（`mOxcpG_*`、`wtg9ga_*`）随页面版本变化，失效时用 §「怎么重新定位」里的探测脚本重新找。
> 最后验证：2026-11，按键 ×3 + 手势 ×3 全部 `sideL` 恒为 `-217`、零 `Document` 请求。

## 现象与根因（三层，越往下越贵）

回主页曾经走过两条错路，都记在这里，因为它们的失败方式完全不同：

1. **`location.reload()`**（最早版本）——功能上回到了 home，但会重跑 DSH 整个启动流程：插件重新加载、首屏重绘。视觉上等于退出软件再重进，用户一眼看得出来。这是典型「假修复」。
2. **「先展开侧栏，再点侧栏里的新会话」**（第二版，曾经被认为是唯一可行路径）——不重载了，但每次返回都有一条黑边横扫屏幕：侧栏整条滑出再收回。真机连拍实测的中间态是 `sideL: -308 → 0 → -216`，即侧栏确实完全展开过一次。

第 2 条的错误根源在**一条错误的注释**：旧记录写着「侧栏收起时按钮 `left=-199`（屏幕外），`click()` 静默无效，必须先展开侧栏让按钮进入屏幕」。这条结论是**错的**，见下节。

## 关键事实：屏外元素 `element.click()` 照样生效

DOM 的 `element.click()` 派发的是合成事件，**不经过命中测试（hit-testing）**，元素是否在视口内、是否被遮挡、是否 `pointer-events: none`，都不影响它收到 click。会被屏外位置挡住的只有「坐标点击」（`Input.dispatchMouseEvent`、`adb input tap`）——它们走的是真实命中测试。

旧结论就是把这个混淆了：当时用坐标点击验证，屏外坐标当然点不到，于是误判成「click 无效」。

实测判据（`tools/eval-page.cjs`，连跑 3 轮）：
- 侧栏 `scrollLeft`/`transform` 全程不动，`wtg9ga_fading → wtg9ga_collapsed` 之间 `left` 恒为 `-217`；
- 页面内挂的 `window.__probeMark` 存活 → 页面没有重载；
- home 出现（hero 文案到位）。

**所以正确做法就是直接 `document.querySelector('.wtg9ga_newSession').click()`，一步到位、无中间态。**

## 实现要点（三条硬约束，改之前先读）

`DSH_GO_HOME_JS` 现在的结构：入口先判是否已在 home → `direct()` 直接点屏外按钮 → 每 40ms 轮询 `reachedHome()` → 超时转 `fallback()`（旧的两步路径）封顶。

### 约束 1：`reachedHome()` 必须先排除会话页

会话页的 DOM 里**仍然留着 home 的文案**（`探索未至之境` 在字符索引 9633、`描述你想要构建的内容` 在 9661 都命中）。所以如果把 hero 判据放在最前面，进会话页后第一次探测就返回 true → 函数立刻 return → **返回键完全没反应**。

必须先判 tab：

```js
var tabs = b.indexOf('对话') !== -1 && b.indexOf('轨迹') !== -1;
if (tabs) return false;              // 会话页，先排除
if (b.indexOf('探索未至之境') !== -1) return true;
if (b.indexOf('描述你想要构建的内容') !== -1) return true;
if (b.indexOf('发消息或创建任务') !== -1) return true;
if (b.indexOf('选择一个工作区开始') !== -1) return true;
return false;
```

`DSH_LOCATION_JS` 之所以一直是对的，就是因为它本来就先判 tab。两处判据必须同构。

### 约束 2：`DIRECT_MS` 必须 ≥ 2400

真机实测：直接点屏外按钮，到页面切完（`reachedHome()` 为真）需要**约 1996ms**（54 次 25ms 轮询）。原来的 `DIRECT_MS = 900` 会在页面还没切完时就判超时，然后走 `fallback()` 展开侧栏——**等于白改，用户看到的还是闪屏**。

留够余量后 `DIRECT_MS = 2400`、`FALLBACK_MS = 2600`。这个数字是量出来的，别凭感觉调小。

### 约束 3：入口先判已在 home

`if (reachedHome()) { window.__dshGoingHome = false; return; }`——否则在 home 上再触发一次「回 home」会白闪一次。

## 怎么验证（不要用截图判断）

```powershell
adb shell am start -n com.dsh.remote/.MainActivity
adb shell pidof com.dsh.remote            # 取 pid
adb forward tcp:9240 localabstract:webview_devtools_remote_<pid>
node tools/record-back.cjs 9240 16 80     # 16 帧 / 80ms / 存 build-artifacts/back-frames
```

判据是三件事同时成立：

1. 每一帧的 `sideL` 都是 `-217`（**出现一次 `0` 就说明走回了展开侧栏的老路**）；
2. `tabs` 由 `true` 变 `false`；
3. 末尾打印 `Document 请求: 无（页面未重载）`。

三件事缺一条都不算通过。只看「画面回到了首页」会漏掉闪屏。

## 怎么重新定位入口（页面改版后）

`tools/probe-sidebar.cjs` 列所有按钮的几何与 `aria-label`；`tools/probe-back-nav.cjs --state` 打当前位置/侧栏类名/按钮列表。找到「新会话」按钮的 hash 类名后替换 `.wtg9ga_newSession`。该 hash 来自 DSH 的 CSS Modules，页面发版就会变。

## 已知遗留

理论上不如直接调 DSH 内部的 `clearMain()` 干净，但 `clearMain` 依赖的 `selection` 是模块私有变量、没挂 `window`，App 侧够不着，因此只能走 UI 路径。当前路径实测稳定，且不再有中间态。

`requestAnimationFrame` 不能用在过渡里（页面不可见/窗口过渡期间 rAF 会被暂停），这里的轮询必须用 `setTimeout`——这条结论未变，仍然有效。
