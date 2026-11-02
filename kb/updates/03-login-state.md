---
id: eb3c513a
title: WebView 登录态自愈：端口变更后遗留 cookie 导致 401 白屏
type: lesson
tags: android,webview,webview外壳,cookie,自愈,端口,实测
confidence: 0.92
group: 外壳
---
> 适用环境：Android WebView 外壳（dsh-mobile-app 项目实测，Android 14 / 15）。凡依赖 cookie 鉴权的 WebView 外壳都适用。
> 最后验证：2026-11。本文只讲「端口变了」这一种故障；完整的三态判据与两种清理范围见《WebView 握手自愈闸门》。

## 现象

DSH 服务重启后 `dsh web` 的监听端口会变（实测 54282 → 17169）。WebView 里遗留的 `dsh-auth-*` cookie 的 authority 仍写着旧端口，服务端校验不过 → 白屏或 401。

## 根因

cookie 内容与旧端口绑定（authority 是 `127.0.0.1:17169` 这种带端口的完整形式，不是只写 host），但 App 侧「是否已登录」的判据如果只看 cookie 是否存在，端口一变判据就失效，自愈不会被触发。

更要紧的一层：中间层 `proxy.mjs` 只要看到请求头里带 `dsh-auth-*` 就**永不**补 launch token。于是僵尸 cookie 会让上游稳定 401，而且这条路径不注入 token → 限流计数不涨 → **永远等不到 503**。等 503 才动手的自愈判据必然失效，必须直接认 401 正文。

## 正确做法

这一类故障（握手坏）的处理是：

1. 清掉 `dsh-auth-*`（**不动** `dsh_pocket_token`——那是 PIN 会话，清了用户就被踢回登录页）；
2. 用原 URL 加 `dsh-pocket-retry=1` 重导航（retry 顺带清握手计数，避免撞 503）；
3. 用 `HandshakeHealGate` 做探测节流：最多 3 次退避重试（5s → 10s → 封顶 30s）。

> **注意别把这条推广到所有故障**：如果页面停在「访问验证」并且 URL 里带着 `?token=`，那**必须**清 `dsh_pocket_token`，否则永远拿不到新 cookie（`maybeSeedAuthCookie` 首行就 `return`）。两种故障清的东西相反，见《WebView 握手自愈闸门》的对照表。

## 判据与证据

- 真机 E2E：注入指向旧端口的失效 cookie → **250ms 后触发自愈，1853ms 恢复主界面，PIN 会话保住**。
- logcat 原文（11:58:35.392）：`DshRemote: handshake broken, clearing ONLY dsh-auth-* and retrying` —— 证明自愈确实动手清理，而不是页面自己恢复。
- 单测：`HandshakeHealGateTest` 10 + `RecoveryPlannerTest` 14 + `RecoveryExecutorTest` 12 + `CookieNamesTest` 10（用 `--rerun-tasks` 强制重跑以排除缓存假通过）。早期版本这里写的是 `EndpointTest 12 + HandshakeHealGateTest 10 = 22`，那是拆分前的旧基线。

## 两个验证陷阱

1. **E2E 脚本判据偏软**：脚本把 `OTHER` / `EMPTY` 中间态也算作「见到故障」，只看脚本输出会误判成自愈已发生。必须用 CDP 抓请求序列或 logcat 独立交叉验证。
2. **pid 变化不等于崩溃**：16262 → 16803 是 MIUI 的 `am_kill ... SwipeUpClean` 系统清理后台，不要当成自愈引发崩溃去排查。
