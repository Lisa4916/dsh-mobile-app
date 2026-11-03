# PROJECT-CHARTER.md — dsh-mobile-app 立项书

> **这份文件回答一个问题：新会话/新窗口接手时，怎么在 5 分钟里知道「这是什么、做到哪了、下一步该干什么」。**
> 事实细节不在这里 —— 构建看 `AGENTS.md`，实测证据看 `PROGRESS.md`，对外说明看 `README.md`。
> 本文只给**定义、边界、里程碑、验收口径、接手路径**，并且随里程碑推进而更新。

| 项 | 值 |
|---|---|
| 项目名 | DSH 手机遥控（`dsh-mobile-app`，包名 `com.dsh.remote`） |
| 立项日期 | 2026-11-01（首个提交 `1a78b7a`） |
| 状态 | **A 档已交付**（真机可用、可发版）；B 档待排期 |
| 当前版本 | `0.5.0` / `versionCode=5`（Release `v0.5.0` 已发布） |
| 仓库 | `D:\dsh-mobile-app`，远端 `https://github.com/Lisa4916/dsh-mobile-app`（public，`master`） |
| 规模 | 35 个 `.kt`（main 19 / 4125 行 + test 15 / 2240 行，另 androidTest 1 / 181 行）+ 62 个 `tools/` 脚本（提交数见 `git log`，不在此写死） |
| 单测基线 | **`tests=261 failures=0 errors=0`**（16 个测试类）；lint **0 error / 22 warning** |
| 上游依赖 | `dsh-pocket` 2.12.0（反代 :3081 + 认证 + 公网隧道），非本仓库 |

---

## 一、一句话与问题定义

**把电脑上正在跑的 DeepSeek Harness 装进手机：同一份会话、同一批文件、同一套工具，出门也能连。**

要解决的真实问题（按用户原话的演进顺序）：

| # | 用户说的 | 翻译成工程目标 |
|---|---|---|
| 1 | 「做个手机软件远程控制本机 DSH」 | WebView 外壳打开 dsh-pocket 的已认证页面 |
| 2 | 「这个插件不好用」 | 不重写前端；复用 dsh-pocket 已移植的窄屏布局 |
| 3 | 「软件下载后需要手动连接或者扫码连接」 | **装完就能连**：自动扫局域网 + 免 PIN 识别 |
| 4 | 「在外面连接使用手机网络，也没有 wifi 啊」 | **只插流量也能连**：自动抓公网地址 + 连不上立刻回落 |
| 5 | 「如何在其他窗口调用此项目」 | 交接可复现：项目根、入口文件、交接卡 |

**判断一个需求该不该做的唯一标准**：它是否让「手机打开就是电脑上的那个 DSH」这件事更稳、更快、更少需要人去猜。

---

## 二、非目标（立项时定下，别推翻）

| 不做 | 依据 |
|---|---|
| **不重写 DSH 前端** | `/`、`/api/*`、`/api/events` 全 401，`/sse` 404；自研要先做 token→cookie 握手再实现 `events.mux` WebSocket。成熟项目 `saya-ch/dsh-mobile` 同样选择「直接打开插件提供的已认证页面」 |
| **不改 `dsh-pocket`** | 它是外部组件，本仓库只消费它的页面。耦合面登记在 `INTEGRATION.md`，升级时按清单验 |
| **不引入 Compose** | UI 量很小（列表 + WebView + 扫码页），命令式 View 能精确控 WebView 与 insets |
| **不做 root / 不改系统** | 键盘避让全走 WindowInsets + 页面 CSS |
| **不在仓库里放真实 IP / PIN / 调试截图** | 仓库是 public；`BuildConfig.LAN_HOST/PIN` 由 `local.properties`（已 gitignore）注入 |

---

## 三、能力边界：三件事各自独立，缺一就得人动手

这是本项目最容易被误解的地方 —— 「能连」不是一件事，是**三件互相独立的能力**：

| 能力 | 机制 | 缺了会怎样 | 对应步骤 |
|---|---|---|---|
| **找到电脑** | 扫同一 Wi-Fi 的 /24（254 地址并发，实测 1.86 s） | 列表页「没找到电脑」，只能扫码/手输 | 第 22 步 |
| **不需要 PIN** | 认响应头 `Set-Cookie: dsh-auth-`（`lanAuthEnabled=false` 时） | 停在「输 PIN」屏，要人去电脑前看 | 第 23 步 |
| **拿到公网地址** | `pocket.status` RPC 自动读回隧道地址 | **永远只有局域网那条，出门必连不上** | 第 24 步 |

三件事的判据都必须是**实测事实**，不是推断：

- 「找到电脑」不能看响应长度（同一验证页实测 4210 / 3969 B 都出现过），只能看正文含 `DSH Pocket`；
- 「免不免 PIN」只能看响应头（状态码都是 200，正文里出现 `Set-Cookie:` 字样不算）；
- 「公网地址」的字段在 `result.value` 里，不在顶层。

---

## 四、里程碑

### 已交付（A 档，全部真机验证）

| 阶段 | 交付物 | 验收证据 |
|---|---|---|
| M1 骨架 | 连接列表 / 扫码（CameraX+ZXing）/ 手输 / 全屏 WebView | 真机显示电脑上同一段对话 |
| M2 体验 | 键盘避让改页面 rAF 自驱（帧间隔中位数 11ms） | 真机逐帧测量 |
| M3 自愈 | 「访问验证」页自愈（清失效 cookie → 带 retry+token 重连） | CDP 抓到决定性跳转 |
| M4 工程化 | 拆类（9 个纯 JVM 决策类）+ 261 条单测 + CI + lint | `tests=261 failures=0` |
| M5 交互 | 启动不闪侧栏、返回键七层严格互逆 | 逐帧采样 + 7 场景脚本 |
| M6 分发 | 版本号单一来源、局域网分发页、GitHub Release 自动发版 | 4 个 Release 全部实测可下载可覆盖安装 |
| M7 零配置 | 自动扫局域网 → 免 PIN 识别 → 公网地址自动读回 | 真机只走 4G 冷启动直进主界面 |

### 待排期（B 档，按「用户感知收益 ÷ 工作量」排序）

| 优先级 | 事项 | 为什么排这个位置 |
|---|---|---|
| P1 | 前台服务保活 | 现在靠 `svc power stayon true`（亮屏不灭），长期开着费电且不体面；掉后台会断连 |
| P1 | 任务完成通知（DSH 的 SSE 完成事件） | 手机放桌上等结果，现在是「自己回来刷」；这是手机形态最该有的能力 |
| P2 | 文件 / 拍照附件通道 | 手机上拍了照发不进会话，等于半个残废 |
| P2 | 多电脑一键切换 | 数据结构与 UI 都有了，缺「点一下换过去」 |
| P3 | 拆 `MainActivity`（1000+ 行） | `buildUi()` 最长；但拆它是纯重构，没有用户感知收益 |
| P3 | 收敛 39 处中文字面量 + 8 处硬编码颜色 | lint `SetTextI18n` 在报；要连带做 i18n 才值得 |
| P3 | 删除撤销（`Snackbar` 需 material coordinator 布局） | 现在有确认框，撤销是锦上添花 |
| — | `androidTest` 补齐（cookie 清除→重导航、键盘 insets、扫码链路） | 现在靠手跑脚本，回归成本高但不是阻塞项 |

### 明确不做（否决过）

- 原生重写 DSH 前端（依据见第二节）
- 从手机侧直接做 token→cookie 握手（要复刻 dsh-pocket 的认证，等于把它搬进 App）
- 用 mDNS / SSDP 做服务发现（dsh-pocket 侧 `mdns|bonjour|discovery|multicast|ssdp` **零命中**，既没有广播也不响应）

---

## 五、验收口径

**「做好了」的判据只有一条：在一台全新安装的手机上，从图标点开到看见 DSH 主界面，不需要用户做任何输入 —— 除非电脑侧刻意保留 PIN。**

具体到三个可测场景：

| 场景 | 期望 | 判据 |
|---|---|---|
| 家里，Wi-Fi，电脑免 PIN | 点开即主界面 | `uiautomator` 0 个原生文本节点（已在 WebView）；日志 `lan discovery done, found=1` |
| 家里，Wi-Fi，电脑保留 PIN | 列表页 + 扫到电脑，只需输一次 8 位数字 | `lan discovery done, found=1` + PIN 屏 |
| 出门，只有移动数据 | **自己挑到公网那条**，不先等局域网 | 日志 `pocket.status: saved public address …` 出现过；无 Wi-Fi 时 `hopeless=true` 在 1 秒内判死局域网 |

**反面要求**：任何一种「连不上」都不许表现为**黑屏干等**。要么自动换下一条，要么回落列表页并说清原因（`ConnectWatchdog.giveUpMessage`）。

---

## 六、架构与关键文件

```
手机 App（本仓库，WebView 外壳）
   │ 局域网 http://192.168.50.58:3081/?token=<PIN>
   │ 公网   https://<random>.trycloudflare.com/?token=<PIN>
   ▼
dsh-pocket 反代 :3081（外部组件，不改它；认证 + cookie + 注入 launch token）
   ▼
本机 dsh web :<每次启动都变>（Harness 主进程）
```

**分层原则**：有「判断」的地方一律搬出 Activity，做成纯 JVM 对象，于是能被单测覆盖。Activity 里只剩造 UI、WebView 生命周期、`CookieManager`、`Toast`、`evaluateJavascript`。

| 文件 | 职责 |
|---|---|
| `AGENTS.md` | 构建环境、源码地图、**踩坑清单**（§6 起，以小节号为准）、交接卡（§1.5） |
| `PROGRESS.md` | 24 步的「做了什么 + 验证证据」，每步一节 |
| `INTEGRATION.md` | 与 dsh-pocket 的**耦合面清单** + 升级检查清单 |
| `CONTEXT-ANCHOR.md` | 立项初期的方案选择记录（历史存档，部分数字已过期并标注更正） |
| `README.md` | 对外说明：现状、源码表、测试表、构建、发版、待办 |
| `version.properties` | 版本号**唯一事实来源**（Android 只允许 versionCode 不降的覆盖安装） |
| `app/src/main/java/com/dsh/remote/` | 19 个源文件；核心决策类见 `AGENTS.md` §4 源码地图 |
| `tools/` | 62 个零依赖 Node / Python 脚本（CDP 探测、真机点击、发版、知识库、验收、证据采集） |
| `.github/workflows/` | `ci.yml`（推 master 触发）+ `release.yml`（推 `v*` tag 触发，产出 Release 资产） |

---

## 七、开发环境与闸门

```powershell
$env:JAVA_HOME='D:\AndroidDev\jdk17'
$env:ANDROID_HOME='D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'

# 闸门（提交前必过）
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    -p 'D:\dsh-mobile-app' :app:testDebugUnitTest :app:lintDebug

# 装真机（序列号用 tools/device.cjs 现取，别写死）
& 'D:\AndroidDev\sdk\platform-tools\adb.exe' -s <SERIAL> install -r `
    'D:\dsh-mobile-app\app\build\outputs\apk\release\app-release.apk'
```

**闸门三条**：单测 `failures=0`、lint `0 error`、真机上跑一遍改动涉及的那条路径。
**真机验证优先于「代码看起来对」** —— 这个项目所有结论都是从设备上量出来的。

---

## 八、接手方式（新会话 / 新窗口）

`D:\dsh-mobile-app` 有独立 `.git`，是**独立项目根**。DSH 只加载「从 cwd 往上第一个含 `.git` 的目录」
那条链上的 `AGENTS.md`，所以在 `D:\DeepSeek Harness` 开会话**不会**自动带上本项目。

| 做法 | 怎么起 |
|---|---|
| **A（推荐）** | 新会话工作目录直接设为 `D:\dsh-mobile-app` |
| B | 开头说「读 `D:\dsh-mobile-app\AGENTS.md`、`PROGRESS.md`、`PROJECT-CHARTER.md`，继续第 N 步」 |
| C | `cd /d D:\dsh-mobile-app` 后 `dsh headless "…"`（`headless` 取进程 cwd，没有 `--cwd`） |

**可直接粘贴的交接卡**（也存在于 `AGENTS.md` §1.5）：

```
项目：D:\dsh-mobile-app（Android WebView 外壳，包名 com.dsh.remote）
立项书：PROJECT-CHARTER.md（定义/里程碑/验收） 入口：AGENTS.md（构建/踩坑）+ PROGRESS.md（证据）
环境：JAVA_HOME=D:\AndroidDev\jdk17  ANDROID_HOME=D:\AndroidDev\sdk  ANDROID_SDK_ROOT=D:\AndroidDev\sdk
gradle：C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat
基线：tests=261 failures=0；lint 0 error / 22 warning；release APK 1,947,334 B
版本：0.5.0（versionCode=5）；最新 Release v0.5.0
真机：用 tools/device.cjs 现取序列号，别写死
```

---

## 九、风险与依赖

| 风险 | 现状 | 应对 |
|---|---|---|
| `dsh-pocket` 升级导致静默失效 | 当前对照 2.12.0 | 耦合点全登记在 `INTEGRATION.md`，升级后按清单逐条验 |
| quick tunnel 地址每次重开都变 | 已自动读回（第 24 步） | 隧道重启后 App 下次连接会重新抓；列表会显示「快速隧道地址每次重开都会变」 |
| 手机移动数据「已连接但无外网」 | 实机遇到过（`PARTIAL_CONNECTIVITY`，DNS 与 IP 直连都 100% 丢包） | App 侧无法修复，只能靠日志区分「是网络问题还是 App 问题」 |
| `github.com:443` 的 TLS / HTTP2 时通时不通 | 反复出现 | 兜底走 `tools/push-via-api.mjs`（GitHub Data API 逐 blob 推送，内建「树必须与本地一致」的验收） |
| 真实 PIN / 隧道名漏进 public 仓库 | 脱敏过两次，`git grep` 复查无命中 | 每次发版前跑一遍敏感串 `git grep`；占位符必须保留 `.trycloudflare.com` 后缀（否则单测会挂） |

---

## 十、变更控制

- **一步一个会话**：每步「跑闸门 → 更新 `PROGRESS.md` → 提交 → 停」。
- **改边界要写在这里**：新增非目标、改交付口径、放弃某个方向，都回写本文，别只留在对话里。
- **每个里程碑完成时更新第四节**，并把该里程碑的验收证据补进 `PROGRESS.md`。
- 提交信息沿用仓库风格：`type(scope): 中文摘要` + 空行 + 分点正文（中文，折行约 70 字）。
