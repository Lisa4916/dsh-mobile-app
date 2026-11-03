# ADB + CDP 真机调试：当截图和录屏都不可信时怎么测

> 适用环境：Windows 主机 + Android 真机（实测 Redmi Note 12T Pro / Android 15 / SDK 35），WebView 应用。
> 最后验证：2026-10

## 核心判断

**截图会骗人，录屏可能根本不能用，uiautomator + CDP 才是真凭据。**

## 一、屏幕录制：先测能不能用，别假设

`adb shell screenrecord` 在部分机型（实测 MTK 平台）**彻底不可用**：

- 现象：退出码 235，落盘 0 字节；
- logcat 证据：`c2.mtk.avc.encoder` 编码器起不来，`Qinput: 0, DQinput: 0 success out of 0 tries`、`D ScreenRecord: failed`；
- 结论：这不是命令写错了，是硬件编码器不可用。**不要在录屏上浪费时间。**

`adb exec-out screencap -p` 单帧约 **1.5 秒**，无法用于动画分析。

**唯一能抓帧的路子是 CDP 的 `Page.captureScreenshot`。**

## 二、CDP 连接（WebView 远程调试）

### 前提

App 内必须开了 `WebView.setWebContentsDebuggingEnabled(true)`。

### 转发端口

```
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

**坑：`<pid>` 每次重装 App 都变。** 查当前名字：

```powershell
adb shell cat /proc/net/unix | Select-String 'webview_devtools_remote'
```

要**过滤掉带 `browser_` 前缀的那条**（那是别的 WebView），取 `webview_devtools_remote_<数字>`。

每次重装后必须重新 `adb forward`，否则连不上，且报错信息不会告诉你名字变了。

### 拿页面 WebSocket 地址

```
GET http://127.0.0.1:9222/json
```

返回数组，取 `type == "page"` 的那一项的 `webSocketDebuggerUrl`。注意地址里的 host 可能是 `localhost`，Node 的 `ws` 连 `localhost` 在 IPv6 优先的机器上会失败，**换成 `127.0.0.1`**。

## 三、零依赖 CDP 客户端（自写 WebSocket）

本项目 `tools/*.cjs` 全部是零依赖 Node 脚本：手写 WebSocket 握手 + 帧解析，不装 puppeteer。理由：真机上装 puppeteer 要下 Chromium，体积和耗时都不划算。

要点：

```javascript
// 握手时 Host 必须与 URL 的 host:port 一致
const key = crypto.randomBytes(16).toString('base64');
// Sec-WebSocket-Key: <key>

// 客户端发的帧必须加掩码（mask），否则服务端直接断开
// 帧头：FIN|opcode(0x1 文本) + 0x80|len，后跟 4 字节 mask，payload 逐字节 ^ mask
```

收帧时要处理**分片**（opcode 0x0 续帧）和大 payload（`len == 126` 时读 2 字节长度，`len == 127` 时读 8 字节）。

## 四、四种取证据的手法及其可信度

| 手法 | 可信度 | 用途 |
|---|---|---|
| `adb exec-out screencap -p` | 低（1.5s/帧、可能全黑） | 只做最终留档 |
| `adb shell screenrecord` | 视机型，实测为 0 | 不要依赖 |
| `adb shell uiautomator dump` | **高** | 控件树、坐标、文本、可见性 |
| CDP `Runtime.evaluate` + `Page.captureScreenshot` | **最高** | DOM、样式、逐帧、JS 状态 |

## 五、截图"全黑"的四种不同原因（别再重复踩）

1. **屏幕睡眠**：`dumpsys power | Select-String 'mWakefulness'`，若是 `Asleep` 先 `adb shell input keyevent KEYCODE_WAKEUP`。
2. **通知栏抢焦点**：`dumpsys window | Select-String 'mCurrentFocus'`，出现 `NotificationShade` 就是下拉通知栏还开着，`input keyevent KEYCODE_BACK` 关掉。
3. **WebView 渲染时序**：页面刚 load 完还没画第一帧。等 500ms 再截。
4. **App 在后台**：`mCurrentFocus` 不是自己的包名。

**可靠判据**：`adb shell uiautomator dump` 出来的控件树里有目标 WebView 节点且 bounds 覆盖全屏 + CDP 的 `chromium CONSOLE` 日志里能看到页面自己的输出（带来源 URL），两者同时成立才算"页面真的渲染了"。

## 六、`adb shell input` 的两个陷阱

### 陷阱 1：`input text` 在中文输入法下吞字符

- 现象：`adb shell input text "http://192.168.1.1:3081"` 实际输入成 `p://`。
- 根因：`input text` 逐字符模拟按键，中文输入法的候选/联想状态会吃掉部分字符。
- **正确做法**：不要让 adb 往输入框打字。**在 App 里做一个按钮，地址由代码写进去。** 或者在页面里用 CDP `Runtime.evaluate` 直接设 `input.value` 再派发 `input` 事件。

### 陷阱 2：`input tap` 的坐标系

- 现象：按 CSS 坐标点，永远差一截，点不中。
- 根因：`input tap` 要的是**物理像素**，而你在页面里量到的是 **CSS px**。
- **换算**：`physical = cssPx × (1080 / window.innerWidth)`。实测 1080/393 ≈ 2.748。
- 判据：先在页面里 `console.log(window.innerWidth, window.devicePixelRatio)`，再算。

## 七、`element.focus()` 不会唤起系统键盘

- 现象：CDP 里调用 `input.focus()`，`document.activeElement` 变了，但键盘不弹。
- 根因：Android WebView 只在**真实触摸事件**里才触发 IME（防自动弹键盘骚扰用户）。
- **正确做法**：用 `adb shell input tap` 在输入框真实位置点一下。坐标换算见上。

## 八、逐帧采集页面的标准脚本骨架

```javascript
// 装采样器
window.__samples = [];
let prev = null;
(function loop() {
  const cur = { wall: Date.now(), innerH: window.innerHeight, composerTop: /* 目标元素 */ };
  if (!prev || cur.innerH !== prev.innerH || cur.composerTop !== prev.composerTop) {
    window.__samples.push(prev ? {...prev, before: true} : null, cur);  // 保留变化前一帧
  }
  prev = cur;
  requestAnimationFrame(loop);
})();
```

**关键：保留"变化前一帧"**，否则算不出这一跳的起始时刻，只能看到变化点。

## 九、动画缩放必须确认是 1

```powershell
adb shell settings get global animator_duration_scale
adb shell settings get global transition_animation_scale
adb shell settings get global window_animation_scale
```

三项都必须是 `1`（或 `null`）。做逐帧测量前如果动过（比如为了看清楚临时设成 10），**测完必须复原**，否则后面所有数据都是错的。

## 十、真机稳定性

- `adb shell svc power stayon true` 保持屏幕常亮；测完 `false` 复原。
- 用 `dumpsys power | Select-String 'mStayOn'` 确认。
