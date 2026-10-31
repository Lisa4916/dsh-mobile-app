# 上下文锚点（会话 dsh-mobile-app）

> 因 `compress` / `acp_status` 在本会话不可用（代理报 unknown plugin conversation），
> 改用落盘摘要。后续上下文若被截断，先读本文件恢复状态。

## 一、用户目标演进

1. 「DeepSeek Harness 手机版」→ 想在手机上操作本机 DSH、与本机同步。
2. 「GitHub 上有开源项目」→ explorer 后锁定社区方案。
3. 「手机已连本机，安装」→ 走 dsh-mobile 原生 App 路线。
4. 「这个插件不好用」→ dsh-mobile 的 `loaded.kind` 设计导致局域网网关必须重启才生效。
5. 「彻底卸载」→ 已全部清除（见下）。
6. 「做个手机软件远程控制本机 DSH 要多久」→ 给出 A/B/C 三档估算。
7. **「执行」→ 当前任务：做 A 档外壳 App**（WebView 打开 3081，扫码即连）。

## 二、A 档方案（已定）

```
手机 App（WebView，自研）
   │ http://192.168.50.58:3081/?token=<PIN>
   ▼
dsh-pocket 反向代理 3081（已跑着）
   ▼
本机 dsh web 54282（同一份会话/文件/工具）
```

理由：不重实现 DSH 前端；复用 dsh-pocket 已移植的 dsh-web-mobile 窄屏布局；不装 CA、不重启 DSH、不五步配对。

## 三、工程位置与命名

- 工程根：`D:\dsh-mobile-app`（独立，与 `D:\mobile-android\netacc-android` 无关）
- 包名：`com.dsh.remote`
- 已建目录：`app/src/main/java/com/dsh/remote`、`res/{values,xml,drawable,mipmap-anydpi-v26}`

## 四、构建环境（实测）

| 项 | 值 |
|---|---|
| JDK | `D:\AndroidDev\jdk17`（Temurin 17.0.20.1） |
| SDK | `D:\AndroidDev\sdk` |
| build-tools | 35.0.0 / 36.0.0 / 37.0.0 |
| platforms | android-35 / android-37.0 |
| adb | `D:\AndroidDev\sdk\platform-tools\adb.exe`（1.0.41 / 37.0.1） |
| Gradle | `C:\Users\yaoqi\.gradle\wrapper\dists\gradle-9.4.1-bin\arn2x92ynaizyzdaamcbpbhtj\gradle-9.4.1\bin\gradle.bat`（不在 PATH） |
| ANDROID_HOME / JAVA_HOME | 均未设，每次构建需显式导出 |
| 参考版本 | AGP 8.7.3 + Kotlin 2.0.21 + Compose plugin 2.0.21 + BOM 2024.10.01 |

构建命令模板（bash 语义，实际用 pwsh 需换写法）：

```
export JAVA_HOME='/d/AndroidDev/jdk17'
export ANDROID_HOME='/d/AndroidDev/sdk'
cd /d/dsh-mobile-app
"$GRADLE_BAT" --no-daemon --console=plain :app:assembleDebug
```

坑（继承自 netacc-android 的 AGENTS.md）：
- Gradle 解压必须在短路径 `/tmp/gradle-short`，长路径会丢 `bin/` 目录（Windows 260 字符限制）。
- `~/.gradle/init.d/aliyun-mirrors.gradle` 会与 settings repositories 冲突，需隔离 `GRADLE_USER_HOME`。

## 五、真机与通道（可用）

| 项 | 值 |
|---|---|
| 机型 | Redmi 23054RA19C（Note 12T Pro） |
| 系统 | Android 15 / SDK 35 / arm64-v8a |
| adb 序列号 | `8PCE7LJB99VG7TRO` |
| 本机 WLAN | 192.168.50.58（网络类别 Public） |
| 3081 代理 | LISTENING `0.0.0.0:3081`，PID 8128 |
| 局域网 PIN | `60111186`（`~/.dsh/dsh-pocket/token-lan`） |
| 手机入口 | `http://192.168.50.58:3081/?token=60111186`（实测 200，完整界面） |
| 防火墙 | `DSH Pocket 3081 (LAN)` 等 5 条规则**已在彻底卸载时删除**，3081 需重新放行或依赖现网测试 |

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

- 工程建成并真机跑通，包名 `com.dsh.remote`，APK 9,710,467 B。
- 启动即自动连接（`autoconnect()`），直接落在 DSH 主界面；靠 document-start 脚本清 `localStorage['dsh.sessions.current']`，避免恢复上次对话。
- 顶部返回键已移除（会压住 DSH 自己的侧边栏按钮），回列表靠系统返回键退到底。
- 键盘避让改为「WebView 不缩 + 页面 rAF 自驱」，实测弹出 11ms/帧、177ms 全程，收起逐帧。

## 九、下一步待办

1. **远程连接（公网隧道）** —— 用户 m01025 提出，尚未决策。阻塞点：cloudflared 会撞本机 Clash/mihomo 的 sing-tun（error 1033）；备选 cpolar。
2. 前台服务保活（现在测试期靠 `svc power stayon true`，不该长期开）。
3. 任务完成通知、文件/拍照附件、局域网自动发现、多电脑一键切换。
