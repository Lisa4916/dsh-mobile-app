---
title: 启动时侧栏闪一下：DOM 属性先到、样式后到
type: lesson
tags: webview,css,transition,启动,闪烁,cdp,实测
confidence: 0.93
group: 外壳
---

## 现象

冷启动约 3.1 秒时，移动端 frame 的侧栏列从 `left=0`（整个露在屏幕里）用一条
`transform 0.28s cubic-bezier(0.4,0,0.2,1)` 收到 `-209`。那 280ms 就是用户说的「闪一下」。

## 根因：DOM 属性先到、样式后到

用 document-start 装 MutationObserver（`Page.addScriptToEvaluateOnNewDocument`）抓首帧：

```
[  2516ms] first-seen                        collapsed=true colRectL=0    tr=matrix(1,0,0,1,0,0)
[  2945ms] attr:data-mobile-nav-explorer    collapsed=true colRectL=-209 tr=matrix(1,0,0,1,-208.337,0)
```

`data-sidebar-collapsed="true"` 在首帧就已经在 DOM 上了，但页面要等 hydration 之后
才把 `transform` 写上去。中间这段 = 「先展开、再收回去」。

再用逐帧 `getAnimations()` 确认它**不是 JS 直接跳**，而是一次真正的 CSS transition：

```
[  3139ms] left=0    anims=[transform:running]
[  3255ms] transitionrun prop=transform target=<sidebarCol>
[  3463ms] left=-209  anims=[]
```

**这一步不能省。** 「CSS 过渡」和「JS 慢一步直接跳」的修法完全不同：
前者禁 transition 就完事，后者要去改对方的渲染时序（基本不可能）。

## 修法

document-start 注入（必须 document-start，过渡 3139ms 起、3463ms 结束，`onPageFinished` 完全错过）：

```css
[data-mobile-nav="frame"] [class*="_sidebarCol"],
[data-mobile-nav="frame"] [class*="_rightbarCol"] {
  transition: none !important;
  animation: none !important;
}
```

## 四条硬约束

1. **只禁 transition，不写死 transform。** 位置该由页面决定，我们只让它「不带动画地就位」。
   页面以后改侧栏宽度、用户手动展开都不受影响。
2. **选择器不许写死完整类名。** 实测是 `mP3x-q_sidebarCol`，`mP3x-q_` 前缀随构建变化，
   `_sidebarCol` 后缀是稳定语义命名 → 用 `[class*="_sidebarCol"]`。
3. **别去改「回主页」那条 JS。** 启动路径根本不调它（只有按返回键才调），
   而且它入口有 `reachedHome()` 保护。改它只会把返回键弄坏。
4. **document-start 时 `document.documentElement` 可能是 `null`。**
   取父节点要三级回落 `head || documentElement || getElementsByTagName('html')[0]`，
   否则 `appendChild` 抛错会让后面的监听器全部注册不上，表现为「注入了但没生效」（自己踩过）。

## 怎么量

| 脚本 | 用途 |
|---|---|
| `probe-startup.cjs` | 冷启动逐帧采样，判据 `sideL >= -60` 帧数为 0 |
| `probe-frame-attrs.cjs` | 抓首帧属性与几何，证明「属性先到、样式后到」 |
| `probe-sidebar-anim.cjs` | 逐帧 `getAnimations()` + `transitionrun`，区分过渡与直接跳 |
| `verify-no-sidebar-flash.cjs` | 注入去过渡样式后复测 |

两个踩过的坑：
- 冷启动问题发生在 **CDP 连上之前**，必须「边等边连」才能抢到采样点；
  从 `/proc/net/unix` 取 socket 时要匹配 `@?webview_devtools_remote_[0-9]+` 并去掉前导 `@`。
- 采样完不显式 `process.exit(0)`，WebSocket 长连接会让 Node 永不退出，看起来像「脚本卡死」。

## 结论

判据从「1 帧」变成「0 帧」，连跑两轮都是 0；侧栏手动展开、进会话页、按返回键回首页全部不受影响。
