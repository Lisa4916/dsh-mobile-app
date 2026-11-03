# Android 平台版本节奏与 targetSdk 升级窗口

写手机 App 的人最容易被「targetSdk 什么时候必须升」这件事打乱节奏。这里把已经确定的日期和每条硬约束写在前面，作为排期依据。

## 一、已确定的日期

| 时间 | 要求 | 依据 |
|---|---|---|
| 2025-08-31 | 新应用与新版本必须 `targetSdk ≥ 35`（Android 15） | Google Play 现行政策 |
| 2026-08-31 | 新应用与新版本必须 `targetSdk ≥ 36`（Android 16） | 每年 +1 的固定节奏 |
| 2026-11-01 | 上一条的延期申请截止 | 可申请一次延期 |
| 2027-08 | 预期升到 37（Android 17） | 推断，不是承诺 |

`targetSdk` 低于要求的包，Play Console 直接禁止发布到标准轨道；已有的老应用如果 targetSdk 低于设备的 Android 版本，**在新系统设备上可能不展示给新用户**。所以这不是「过几个月再补」的事，是发布闸门。

## 二、版本与 API 对照

```
Android 14  Upside Down Cake  API 34  2023-10-04
Android 15  Vanilla Ice Cream  API 35  2024-09-03
Android 16  Baklava            API 36  2025-06-10
Android 17  Cinnamon Bun       API 37  2026-06-16
```

**踩坑点：`compileSdk` 与 `targetSdk` 要一起看。** 只升 `compileSdk` 能编译新 API，但不代表行为契约变了；只升 `targetSdk` 会在没有任何编译错误的情况下让行为突变。升级顺序永远是：先把 `compileSdk` 提到新版本 → 编译通过、跑一遍测试 → 再提 `targetSdk` → 到新系统的真机/模拟器上按行为变更清单逐条验。

## 三、`targetSdk` 升级时的验证纪律

1. **不要只在一台设备上验。** 本项目就踩过：`targetSdk 35` 在 Android 15 的 Redmi 上一切正常，在 Android 14 的 XT2335-3 上 WebView 只有 117（需要 polyfill）。同一个 APK 在不同 Android 版本上跑的 WebView 内核完全不同。
2. **用 `adb shell am compat` 逐条开关行为变更**，在新系统上先「模拟启用」再决定要不要改代码，而不是盲升。
3. **记录当前状态**：把「当前 targetSdk / compileSdk / AGP / Gradle / JDK 分别是什么、为什么锁在这里」写进 `AGENTS.md`。版本锁定不是洁癖 —— 本项目实测 Gradle 9.4.1 与 AGP 8.7.3 直接不兼容，文档里不写就一定会有人（或未来的自己）踩。

## 四、和本项目直接相关的两条

- `minSdk 24` 意味着要照顾 Android 7.0 起的设备。**WebView 内核版本与 Android 版本不是一回事**：Android 14 上完全可能是 WebView 117。判断某个 Web API 能不能用，看的是 `navigator.userAgent` 里的 Chrome 版本，不是 `Build.VERSION.SDK_INT`。
- 平台行为变更（edge-to-edge 强制、predictive back 默认开启）会**同时**影响原生层与 WebView 里的页面。升级 targetSdk 前先把这两层的影响面分开列清。
