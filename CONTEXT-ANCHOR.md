# CONTEXT-ANCHOR.md — 项目起源与早期决策存档

> **这份文件是历史存档，不是现状。**
> 现状看 `PROGRESS.md`（步骤与实测）与 `AGENTS.md`（构建、路由、踩坑）。
> 本文保留的是「为什么选这条路」的原始记录，其中**第四、五、九节的部分实测数据已经过期**，
> 已在对应位置标注更正。先读更正，再看原文，避免被旧数字带偏。

## 一、用户目标演进

1. 「DeepSeek Harness 手机版」→ 想在手机上操作本机 DSH、与本机同步。
2. 「GitHub 上有开源项目」→ explorer 后锁定社区方案。
3. 「手机已连本机，安装」→ 走 dsh-mobile 原生 App 路线。
4. 「这个插件不好用」→ dsh-mobile 的 `loaded.kind` 设计导致局域网网关必须重启才生效。
5. 「彻底卸载」→ 已全部清除（见第六节）。
6. 「做个手机软件远程控制本机 DSH 要多久」→ 给出 A/B/C 三档估算。
7. **「执行」→ 做 A 档外壳 App**（WebView 打开 dsh-pocket 的已认证页面，扫码即连）。

三档分野（保留原始定义，后续未变）：

| 档 | 内容 | 结局 |
|---|---|---|
| A | WebView 外壳，打开 dsh-pocket 已认证页面 | **已实现并真机跑通** |
| B | A + 前台服务保活 / 任务完成通知(SSE) / 文件拍照附件 / 局域网自动发现 / 多电脑一键切换 | 未开工（见 README「待办」） |
| C | 原生重写 DSH 前端 | 已否决（依据见第七节） |

> 关于当初的工期估算：A/B/C 三档的具体时间数字**没有留存**（当时只记了「给出三档估算」这个结论）。
> 事后实测：A 档主体 4 个提交在 14 小时内完成（2026-11-01 03:02 → 17:15），
> 之后又花了约 14 小时在第 7 步公网隧道、自愈逻辑、以及一个最终被推翻的假 bug 上
> （2026-11-02 08:37 收尾，全程 29 小时 35 分，含睡眠暂停）。

## 二、A 档方案（已定，未变）

```
手机 App（WebView，自研）
   │ http://<电脑IP>:3081/?token=<PIN>      局域网
   │ https://<random>.trycloudflare.com/?token=<PIN>   公网（第 7 步）
   ▼
dsh-pocket 反向代理
   ▼
本机 dsh web（同一份会话/文件/工具）
```

理由：不重实现 DSH 前端；复用 dsh-pocket 已移植的 dsh-web-mobile 窄屏布局；不装 CA、不重启 DSH、不五步配对。

> **更正（原第 20 行）**：原文把入口写死成 `192.168.50.58` 并直接把 PIN 写在文档里。
> 现已改为构建时注入：`local.properties` 的 `dsh.lanUrl` / `dsh.lanPin`，**该文件被 .gitignore 忽略**，
> 本文不再记录具体 IP 与 PIN。详见 `INTEGRATION.md` 与 `BootstrapUrl.kt`。

## 三、工程位置与命名

- 工程根：`D:\dsh-mobile-app`（独立，与 `D:\mobile-android\netacc-android` 无关）
- 包名：`com.dsh.remote`
- 当前版本：`versionName = "0.1.0"` / `versionCode = 1`

## 四、构建环境

| 项 | 值 |
|---|---|
| JDK | `D:\AndroidDev\jdk17`（Temurin 17.x） |
| SDK | `D:\AndroidDev\sdk` |
| build-tools | 35.0.0 / 36.0.0 / 37.0.0 |
| platforms | android-35 / android-37.0 |
| adb | `D:\AndroidDev\sdk\platform-tools\adb.exe` |
| **Gradle** | **必须 8.9**。短路径副本：`C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat`；工程自带 wrapper 也指向 8.9（走腾讯云镜像） |
| ANDROID_HOME / JAVA_HOME | 均未设，**每次构建需显式导出** |
| AGP / Kotlin | 8.7.3 / 2.0.21（compileSdk 35、minSdk 24、targetSdk 35） |

> **更正（原第 44 行）**：原文写 Gradle 用 `gradle-9.4.1`。
> **9.4.1 与 AGP 8.7.3 不兼容**，实测必须 8.9。这条错记录曾让人白折腾一轮。

构建命令（pwsh）：

```powershell
$env:JAVA_HOME='D:\AndroidDev\jdk17'
$env:ANDROID_HOME='D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT='D:\AndroidDev\sdk'
& 'C:\Users\yaoqi\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat' `
    -p D:\dsh-mobile-app :app:assembleDebug :app:testDebugUnitTest
```

坑（沿用）：
- Gradle 解压必须在短路径（Windows 260 字符限制会丢 `bin/`）。
- `~/.gradle/init.d/aliyun-mirrors.gradle` 会与 settings repositories 冲突，需要隔离 `GRADLE_USER_HOME`。

## 五、真机与通道

| 项 | 值 |
|---|---|
| 主力真机 | **motorola XT2335-3**，Android 14 / SDK 34，adb 序列号 `ZY22GHMK5F`，WebView 117.0.5938.60（USB 调试） |
| 备用真机 | **Redmi 23054RA19C（Note 12T Pro）**，Android 15 / SDK 35，adb 序列号 `8PCE7LJB99VG7TRO`。**公网 4G 验收是在这台一次通过的** |
| 本机 WLAN | `192.168.50.58`（具体值已不在文档里复述；构建时注入） |
| 局域网 PIN | 在 `~/.dsh/dsh-pocket/token-lan`，**不在本文记录**，避免随仓库外泄 |
| 公网入口 | quick tunnel，形如 `https://<三词随机>.trycloudflare.com/?token=<公网PIN>`，**每次开启都变**，见 `INTEGRATION.md` §2.6 |

> **更正（原第 65-71 行）**：原文只记了 Redmi 一台、把 3081 的 PID 与 PIN 明文写进文档。
> 现在两台都能用，但**场景不同**：XT2335-3 适合局域网调试（WebView 117 老，靠 `POLYFILL_JS` 兜底）；
> 公网 4G 用 Redmi 一次通过，XT2335-3 在 4G 下页面黑屏并掉过 adb 线。
> PIN 与 PID 这类会变的东西不要写进仓库文档。

## 六、已彻底卸载的 dsh-mobile

| 位置 | 状态 |
|---|---|
| `package.json` dependencies / bundles | 已移除 |
| `node_modules/dsh-mobile` | 已删除 |
| `~/.dsh/mobile-access/`（18 文件，含 CA/私钥） | 已删除 |
| 防火墙规则 5 条 | 已删除 |
| 手机 App `io.github.sayach.dshmobile` | 已卸载（`pm path` 返回空） |
| `D:\DeepSeek Harness\downloads\` 全部临时产物 | 已清空 |

失败根因（值得记住）：dsh-mobile 的 `loaded.kind` 在插件启动那一刻定型；启动时 `setup.json` 为空则为 `unconfigured`，此后 `POST /api/mobile-access/lan/control {"running":true}` 永远回 `409 lan_setup_restart_required`，**只能重启 DSH 才可转 `managed`**。不是配置错误。

## 七、DSH web 接口事实（决定 C 档成本）

- `/`、`/api/`、`/api/sessions`、`/api/events` 全部 401；`/sse` 404。
- 需先 token→cookie 握手，再自行实现 `events.mux` WebSocket 流式订阅。
- 连成熟项目 saya-ch/dsh-mobile 都注明「直接打开插件提供的已认证 HTTPS 页面，不打包另一套 DSH 前端」——这是选 A 档而非 C 档的直接依据。

## 八、已完成（A 档主体）

- 工程建成并真机跑通，包名 `com.dsh.remote`。
- 启动即自动连接（`autoconnect()`），直接落在 DSH 主界面；靠 document-start 脚本清 `localStorage['dsh.sessions.current']`，避免恢复上次对话。
- 顶部返回键已移除（会压住 DSH 自己的侧边栏按钮），回列表靠系统返回键退到底。
- 键盘避让改为「WebView 不缩 + 页面 rAF 自驱」，实测弹出 11ms/帧、177ms 全程，收起逐帧。

> **更正（原第 95 行）**：原文写 APK 9,710,467 B。当前实测 **7,516,844 B**（增量构建），
> 全量 `--rerun-tasks` 约 7,469,704 B。体积差异来自 dex/资源打包顺序，不是回归。

## 九、下一步待办（按现状重写）

原来的第 1 条「远程连接（公网隧道）」**已完成**，且当初记的阻塞理由是错的。

> **更正（原第 102 行）**：原文写「阻塞点：cloudflared 会撞本机 Clash/mihomo 的 sing-tun（error 1033）」。
> 实测**本机根本没有 mihomo/clash 进程、无 TUN 网卡**，cloudflared precheck 全 PASS，
> 公网隧道 200 正常。第 7 步已在 Redmi 真机 4G 下验收通过。旧结论作废。

当前真正的待办见 `PROGRESS.md` 末尾与 `README.md`「待办（下一档 B）」。摘要：

1. **补 `androidTest`**：现在只有 JVM 单测，WebView 同域判定、cookie 清除→重导航、
   键盘 insets、扫码链路全无自动化（靠 `tools/*.cjs` 手跑）。
2. **拆 MainActivity**（911 行 God Activity）：抽出 `RecoveryExecutor` / `ConnectionRepository`，
   让 `healHandshakeIfNeeded()` 可单测。
3. **隧道地址自动读回**：quick tunnel 每次变，现在要手动重扫；走 dsh-pocket 的 `pocket.status` RPC。
4. 前台服务保活（现在测试期靠 `svc power stayon true`，不该长期开）。
5. 任务完成通知、文件/拍照附件、局域网自动发现、多电脑一键切换。
