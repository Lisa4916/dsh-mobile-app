---
title: 点击注入的三层可信度：DOM click / 坐标点击 / system 级事件
type: lesson
tags: android,webview,自动化,点击,monkey,miui,adb,实测,踩坑
confidence: 0.95
group: 调试
---
> 适用环境：Android 真机（MIUI/HyperOS 实测 V816，Android 15）+ WebView 外壳 App。web 页面自动化、E2E 验证、UI 回归都适用。
> 最后验证：2026-11，本项目曾因搞错这一层追查了一个根本不存在的缺陷。

## 一句话结论

**要验证「点了按钮之后发生什么」，先确认你的点击真的落到了按钮上。** 三种注入方式的生效条件完全不同，混用会得到假阴性。

| 方式 | 是否经过命中测试 | 屏外/被遮挡元素 | 被系统拦截的风险 | 本项目结论 |
|---|---|---|---|---|
| DOM `element.click()` | **否** | **照样生效** | 无 | 页面内自动化首选 |
| 坐标点击（`Input.dispatchMouseEvent` / `adb input tap`） | **是** | 点不到 | **MIUI 会拒绝注入且不报错** | 不可靠，别用来做判据 |
| system 级事件（`monkey -f` / `sendevent`） | 是 | 点不到 | `monkey` 可用；`sendevent` 需 root | 需要真实触摸时用这个 |

## 一、DOM `click()` 不经过命中测试（推翻过一条旧结论）

元素被 `transform: translateX(-217px)` 移到视口外、或 `pointer-events: none`、或被其他元素覆盖时，**`element.click()` 依然会派发 click 并触发监听器**。它派发的是合成事件，浏览器不做事先的命中测试。

会被屏外位置挡住的只有「坐标点击」，因为坐标点击走的是真实命中测试。

本项目曾据此写下「侧栏收起时按钮 `left=-199`，click 静默无效，必须先展开侧栏」——**这条结论是错的**。当时用坐标点击验证，屏外坐标当然点不到，把「坐标点不到」误当成了「click 无效」，代价是每次返回主页都闪一次侧栏，且这个「修复」被写进了知识库。

判据：直接 `document.querySelector(sel).click()`，然后轮询页面状态变化。若状态没变，问题在等待时间或选择器，不在可见性。

## 二、`adb shell input tap` 在 MIUI 上会被拒绝（且不报错）

logcat 铁证（`input tap 540 613` 之后）：

```
W MIUIInput: Input event injection from package: null action ACTION_DOWN
D InputManager: injectMotionEvent: 6369-{action=ACTION_DOWN, id[0]=0, x[0]=540.0, y[0]=613.0, pointerCount=1, eventTime=5312532, deviceId=7}
W InputManager: Input event injection from pid 6369 failed.
D MiSightJni: MiSight: ... '{"detail":"input event inject fail"}'
```

`input tap` 的退出码仍然是 0，**命令行上看不出任何异常**。逐一试过、全部无效：`input tap`、`input touchscreen tap`、`input swipe x y x y+1 80`、`input motionevent DOWN/UP`、`sendevent /dev/input/event6`（后者 `Permission denied`）。

`input keyevent` 是有效的（`KEYCODE_HOME`、`KEYCODE_BACK` 都能用）——这一点最容易骗人：**「adb 能用」不代表「触摸能用」**。

## 三、需要真实触摸时的可靠做法：`monkey -f`

```
type= raw events
count= 2
speed= 1.0
start data >>
DispatchPointer(0,0,0,<x>,<y>,0,0,0,0,0,0,0)
DispatchPointer(0,0,1,<x>,<y>,0,0,0,0,0,0,0)
```

写进 `/data/local/tmp/tap.txt`（用 base64 送进去，避免换行被吞）：

```powershell
adb shell "echo <base64> | base64 -d > /data/local/tmp/tap.txt"
adb shell monkey -p <包名> -f /data/local/tmp/tap.txt -v 6
```

**判据只看 `Events injected` 非 0。** 末尾的 `Dropped: keys=0 pointers=1` 在正常生效时也会出现，不能当失败判据。

注意 `monkey` 会先发一个 LAUNCHER Intent 把 App 带回前台，所以用它点击前 App 必须已经停在目标界面，否则会把界面重置掉再点。

`tools/tap.cjs` 封装了这套流程，`Events injected` 为 0 时 exit 2。

## 四、坐标换算：CSS px ≠ 物理像素

`adb input tap` 与 `Input.dispatchMouseEvent` 要的是**物理像素**，而页面里量到的是 **CSS px**。

```
physical = cssPx × (屏幕宽 / window.innerWidth)
```

实测 1080 / 393 ≈ 2.748。先 `console.log(window.innerWidth, window.devicePixelRatio)` 再算，不要背常数。

`adb shell uiautomator dump` 给的 bounds 是**物理像素**，可以直接喂给 `monkey`；CDP 里 `getBoundingClientRect()` 给的是 CSS px，要换算。

## 五、`element.focus()` 不唤起软键盘（同源问题）

CDP 里调 `input.focus()`，`document.activeElement` 会变，但系统 IME 不弹。Android WebView 只在**真实触摸事件**里才触发键盘（防自动弹键盘骚扰）。想验键盘避让，必须用 `monkey -f` 真的点在输入框上。

## 六、排查顺序（遇到「点了没反应」时按这个顺序走，别跳）

1. logcat 里搜 `injectMotionEvent` / `injection ... failed` —— 先排除注入被拒；
2. `adb shell uiautomator dump` 确认控件存在、bounds 覆盖目标位置、`clickable="true"`；
3. 改用 DOM `click()` 试一次 —— 若这一步成功，说明问题在点击注入，不在页面逻辑；
4. 再查等待时间与选择器。
