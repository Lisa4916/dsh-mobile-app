---
id: f71d31a1
title: ADB + CDP 真机调试：当截图和录屏都不可信时怎么测
type: procedure
tags: adb,cdp,调试,android,真机,webview,monkey
confidence: 0.92
group: 调试
---
> 适用环境：Windows 主机 + Android 真机（MIUI/HyperOS V816、Android 15、WebView 131；另一台 Moto XT2335-3 / Android 14 / WebView 117），WebView 应用。
> 最后验证：2026-11

## 核心判断

**截图会骗人，录屏可能根本不能用，uiautomator + CDP 才是真凭据。**
更强的一条：**连「点击有没有生效」都要先验证**——否则你会追查一个不存在的缺陷。点击注入的三层可信度见《点击注入的三层可信度》。

## 一、屏幕录制：先测能不能用，别假设

`adb shell screenrecord` 在部分机型（实测 MTK 平台）**彻底不可用**：

- 现象：退出码 235，落盘 0 字节；
- logcat 证据：`c2.mtk.avc.encoder` 编码器起不来，`Qinput: 0, DQinput: 0 success out of 0 tries`、`D ScreenRecord: failed`；
- 结论：这不是命令写错了，是硬件编码器不可用。**不要在录屏上浪费时间。**

`adb exec-out screencap -p` 单帧约 **1.5 秒**，无法用于动画分析。

**唯一能抓帧的路子是 CDP 的 `Page.captureScreenshot`。**

### 截图落盘的格式坑（PowerShell 专属）

```powershell
adb exec-out screencap -p > shot.png          # ❌ 得到 20 万字节的坏图
```

PowerShell 的 `>` 重定向会做文本编码转换，**把 PNG 里的 `0x0A` 变成 `0x0D 0x0A`**，文件大小虚增、magic 之后全是坏的，看图工具报 `Unsupported or malformed image data`。

正确做法（走 `pull`，二进制原样搬运）：

```powershell
adb shell screencap -p /sdcard/shot.png
adb pull /sdcard/shot.png .\shot.png
```

判据：`Get-Content shot.png -AsByteStream -TotalCount 4` 应是 `137 80 78 71`。

## 二、CDP 连接（WebView 远程调试）

### 前提

App 内必须开了 `WebView.setWebContentsDebuggingEnabled(true)`（本项目只在 `BuildConfig.DEBUG` 下开）。

### 转发端口

```
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

**坑：`<pid>` 每次重装 App 都变**（进程被杀重建也会变）。查当前名字：

```powershell
adb shell pidof com.dsh.remote
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

要**过滤掉带 `browser_` 前缀的那条**（那是别的 WebView），取 `webview_devtools_remote_<数字>`。每次重装后必须重新 `adb forward`，否则连不上，且报错信息不会告诉你名字变了。

`adb forward` 不清理会堆积，换端口前先 `adb forward --remove-all`。

### 拿页面 WebSocket 地址

```
GET http://127.0.0.1:9222/json
```

返回数组，取 `type == "page"` 的那一项的 `webSocketDebuggerUrl`。注意地址里的 host 可能是 `localhost`，Node 的 `ws` 连 `localhost` 在 IPv6 优先的机器上会失败，**换成 `127.0.0.1`**。

`Invoke-WebRequest` 打 `/json` 有时会超时（设 15s 也不够），用 Node 脚本走更稳。

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
| `adb exec-out screencap -p` | 低（1.5s/帧、可能全黑、PowerShell 会毁 PNG） | 只做最终留档 |
| `adb shell screenrecord` | 视机型，实测为 0 | 不要依赖 |
| `adb shell uiautomator dump` | **高** | 控件树、物理像素坐标、文本、可见性 |
| CDP `Runtime.evaluate` + `Page.captureScreenshot` | **最高** | DOM、样式、逐帧、JS 状态、请求序列 |

抓「点击到底有没有发出请求」用 `Network.requestWillBeSent` 过滤 `type == "Document"`，比看画面可靠得多（本项目 `tools/watch-net.cjs`）。

## 五、截图「全黑」的四种不同原因（别再重复踩）

1. **屏幕睡眠**：`dumpsys power | Select-String 'mWakefulness'`，若是 `Asleep` 先 `adb shell input keyevent KEYCODE_WAKEUP`。
2. **通知栏抢焦点**：`dumpsys window | Select-String 'mCurrentFocus'`，出现 `NotificationShade` 就是下拉通知栏还开着。
3. **WebView 渲染时序**：页面刚 load 完还没画第一帧。等 500ms 再截。
4. **App 在后台**：`mCurrentFocus` 不是自己的包名。**这条最容易漏**：用 `input keyevent KEYCODE_BACK` 在首页再退一次会直接把 App 退到桌面，之后所有 `input tap` 都点在桌面上（截图会拍到壁纸）。每次点击前必须用 `dumpsys activity | Select-String topResumedActivity` 确认前台。

**可靠判据**：`uiautomator dump` 的控件树里有目标 WebView 节点且 bounds 覆盖全屏 + CDP 的 `chromium CONSOLE` 日志里能看到页面自己的输出（带来源 URL），两者同时成立才算「页面真的渲染了」。

## 六、`adb shell input` 的两个陷阱

### 陷阱 1：`input text` 在中文输入法下吞字符

- 现象：`adb shell input text "http://192.168.1.1:3081"` 实际输入成 `p://`。
- 根因：`input text` 逐字符模拟按键，中文输入法的候选/联想状态会吃掉部分字符。
- **正确做法**：不要让 adb 往输入框打字。**在 App 里做一个按钮，地址由代码写进去。** 或者在页面里用 CDP `Runtime.evaluate` 直接设 `input.value` 再派发 `input` 事件。

### 陷阱 2：`input tap` 的坐标系

- 现象：按 CSS 坐标点，永远差一截，点不中。
- 根因：`input tap` 要的是**物理像素**，而你在页面里量到的是 **CSS px**。
- **换算**：`physical = cssPx × (1080 / window.innerWidth)`。实测 1080/393 ≈ 2.748。

> **更严重的坑**：MIUI 上 `input tap` / `input swipe` 会被系统拒绝注入，**退出码仍是 0**。要真实触摸必须用 `monkey -f`。详见《点击注入的三层可信度》。

## 七、`element.focus()` 不会唤起系统键盘

- 现象：CDP 里调用 `input.focus()`，`document.activeElement` 变了，但键盘不弹。
- 根因：Android WebView 只在**真实触摸事件**里才触发 IME（防自动弹键盘骚扰用户）。
- **正确做法**：用 `monkey -f` 在输入框真实坐标点一下（不要用 `input tap`，见上）。

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

**关键：保留「变化前一帧」**，否则算不出这一跳的起始时刻，只能看到变化点。

更省事的做法是 CDP `Page.captureScreenshot` 连拍 + 每帧取一次 DOM 采样（本项目 `tools/record-back.cjs`），能抓到 1 秒内的中间态——侧栏闪屏就是这样定位的。

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
- 反复创建/销毁 WebView 的测试会让渲染进程崩溃（`INSTRUMENTATION_RESULT: shortMsg=Process crashed`）。instrumented 测试里要么复用同一个 WebView，要么每个用例之间显式销毁并等待。

## 坑：应用分身导致 `adb install -r` 后启动弹三个同名应用

**适用环境**：Moto XT2335-3，Android 14 / SDK 34；设备已开启应用分身（User 0 / 900 / 901）。

- **现象**：`adb install -r` 后启动 App，弹「选择要使用的应用程序」，列出三个同名「DSH 手机遥控」，App 起不来。
- **根因**：`adb install -r` 默认把包装到所有用户（含分身 User 900/901），系统把三个实例都当成可启动入口。
- **正确做法**：先清掉分身里的实例，再只装机主：
```powershell
adb shell pm list users                         # 确认 0/900/901
adb shell pm uninstall --user 900 <包名>
adb shell pm uninstall --user 901 <包名>
adb install -r --user 0 app-debug.apk
```
- **判据**：`adb shell pm list packages --user 900 | Select-String <包名>` 应无输出；清理后启动直接进 App，不再弹选择框。

## 坑：装测试 APK 报 `INSTALL_FAILED_USER_RESTRICTED`

```
adb install -r -t app-debug-androidTest.apk
```

`-t` 不能省——测试 APK 带 `testOnly` 标记，MIUI 默认拒绝安装。

## 无线调试回退（实测走不通）

`adb pair` 返回 `Successfully paired` 只证明配对完成，不证明设备可达。实测：配对成功后重扫 10000–65535 只看到一个端口，`adb connect` 始终 `offline`，`adb mdns services` 始终空；此时改走 USB 一次通过。

判据是 `adb devices` 里出现 `device`（不是 `offline`），不要只看配对成功。
