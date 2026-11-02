---
id: 1d1c339c
title: 全量回归检测清单：模块 / 边界 / 性能与判据来源
type: procedure
tags: android,测试,回归,基线,判据,webview外壳
confidence: 0.9
group: 测试
---
> **用途**：每 4~6 周，或每次改外壳 / 键盘 / 导航 / 自愈后，按这张表复跑一遍，可对比、不靠记忆。
> **适用环境**：Windows 主机 + Android 真机，WebView 外壳 App（dsh-mobile-app）。基线建于 2026-11。

## 一、模块检测（先跑这 5 项，全过才算过关）

| 模块 | 必须验证的组合 | 通过判据 |
|---|---|---|
| 返回导航 | 按键 + 手势 × 会话界面 / 开始界面，共 4 种 | 会话→`home`；开始界面→桌面；**任何一条都不得回到连接列表** |
| 回主页中间态 | 手势一次，CDP 连拍 16 帧 | 每帧侧栏 `sideL` 恒为负（`-217` 是实测值），**出现一次 `0` 即判失败**；末尾 `Document 请求: 无` |
| 自愈正向 | 弄脏 `dsh_pocket_token` → 导航 | 出现 `/?token=<PIN>&dsh-pocket-retry=1` 那一跳，cookie 被重新下发，进主界面 |
| 自愈反向 | 端点 URL 去掉 `?token=` → 再弄脏 | 不出现自愈重连、停在访问验证页、脏 cookie **未被清**（证明不会把用户锁死） |
| 键盘避让 | 冷启动 / 点击输入框 / 复位 | `rootH` 772 → 502 / 270 → 772，`mInputShown` 与页面高度一致 |

> 「自愈反向」这一项容易被跳过，但它是唯一能证明「不会锁死用户」的用例。只跑正向等于没验。

## 二、边界检测（4 项）

1. 连续 3 次故障 → 3/3 PASS，不进死循环（动作预算 3 次，退避 5s→10s→30s 封顶）；
2. 快速连按 3 次返回 → 无崩溃、无重复退出；
3. Activity 重建后 → 注入的 hook 仍生效（前提是注入幂等，见《WebView 外壳 + JS 桥》坑 3）；
4. 断网 → 恢复 → 点重连：能进主界面。**注意点击必须用 `monkey -f` 原始事件**，MIUI 上 `input tap` 会被拒绝注入，用它做验证会得到「点了没反应」的假阴性，见《ADB + CDP 真机调试》第六节。

## 三、性能与测试基线（数值写死，只许不劣化）

| 指标 | 基线（2026-11） |
|---|---|
| 冷启动到主界面可交互 | ~900ms（公网隧道下另计，实测 18~25s 含 TLS + 握手 + 插件加载） |
| TOTAL PSS | 110~120MB（WebView 应用正常区间） |
| 5 次重建后 PSS | 由 123.7MB 回落到 119.6MB |
| 本地单测（JVM） | **118 passed / 0 failed**（`--rerun-tasks` 全量重跑） |
| 真机 instrumented | **OK (7 tests)**（`PageProbeJsTest`） |
| lint | **0 error / 27 warning**（warnings 不挡合并，AGP `abortOnError` 只对 error 生效） |

单测拆分基线（对不上就说明有类被漏跑或新增类没接进 CI）：
`AutoConnectTest 7 / BackNavigationDeciderTest 11 / BootstrapUrlTest 10 / CookieNamesTest 10 / EndpointTest 24 / HandshakeHealGateTest 10 / PageProbeTest 20 / RecoveryExecutorTest 12 / RecoveryPlannerTest 14`。

> 早期版本的基线写的是 `33 passed`，那是拆类之前的数字，**已经作废**。看到 33 就说明文档或环境是旧的。

## 四、判据来源（别用错工具）

- 内存：`adb shell dumpsys meminfo <pkg>` 的 TOTAL PSS，不看「感觉卡」；
- 逐帧 / DOM / JS 状态：CDP 的 `Runtime.evaluate` + `Page.captureScreenshot`，**不要**用 `screencap` 做动画分析（1.5s/帧，且可能全黑）；
- **点击注入**：MIUI 上必须用 `monkey -f` 原始事件脚本，判据看 `Events injected` 非 0；`input tap` / `input swipe` 会被系统拒绝且**不报错**；
- 单测：读 `app/build/test-results/testDebugUnitTest/*.xml` 的 `tests= / failures= / errors=`，不看控制台；
- lint：读 `app/build/reports/lint-results-debug.xml` 的 `<issue severity="...">` 计数；
- 构建：`-q` 无输出且退出码 0 才算通过。

## 五、已修掉的缺陷（记下来防止改回）

- **`DSH_GO_HOME_JS` 用 `location.reload()` 回主页** —— 已修为页面内轻量切换。这是曾经挂在这里最久的一条「已知未解项」，现已解除，见《滑动返回/回主页》。
- **回主页先展开侧栏导致闪屏** —— 已修。真因是「屏外元素 `click()` 静默无效」这个旧结论本身是错的：DOM `click()` 不经过命中测试，屏外也能点；真正缺的是等待上限（实测需 ~1996ms）。
- **自愈只认 401、把 PIN 页当健康** —— 已修为三态判据。
- **自愈在 PIN 页仍保留 `dsh_pocket_token`** —— 已修为「URL 带 token 才清 pocket cookie」。
- `onDestroy` 销毁不完整 → 见《WebView 外壳 + JS 桥》坑 6；
- 导航决策嵌在 Activity 不可测 → 见《单测可测性》；
- JS 桥名被写死两处（抽成 `WebViewFactory.JS_BRIDGE_NAME`）。

## 六、仍然靠手工验证的部分（自动化缺口，别假装已覆盖）

以下四块目前**没有**自动化，全靠 `tools/` 下的脚本手跑，回归时不能省：

1. WebView 同域判定（`shouldOverrideUrlLoading` 放行/外跳）—— 只能在真机点外链看是否跳系统浏览器；
2. cookie 清除 → 重导航的真实链路 —— 单测覆盖了决策，没覆盖 `CookieManager` 的真实行为；
3. 键盘 insets 的逐帧动画 —— CDP 采样可做，但没固化成断言；
4. 扫码（CameraX + ZXing）—— 需要真实摄像头输入，无法在模拟器上稳定复现。

补齐方向：先把 (2) 用 MockWebServer + `androidTest` 覆盖，它是自愈链路里唯一「判错就删用户 cookie」的一环，价值最高。
