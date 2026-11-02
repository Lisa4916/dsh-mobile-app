---
title: 测试分层：Robolectric、真机 instrumented 与 Gradle Managed Devices 各管什么
type: decision
tags: 测试,robolectric,instrumented,gradle managed devices,ci
confidence: 0.92
group: 测试
---
「该写哪种测试」这个问题在 Android 上有明确的答案边界，因为**不同层的能力上限不一样**，选错层的代价是测试写了但永远是绿的。

## 一、三层的能力边界

| 层 | 跑在哪 | 能测什么 | 不能测什么 |
|---|---|---|---|
| JVM 单测 | 本机 JVM | 纯逻辑、字符串处理、状态机、序列化 | 任何真 Android API |
| Robolectric | 本机 JVM（自动降级 / shadow 实现） | Activity/Fragment 生命周期、View 层级、资源加载、SharedPreferences | **WebView**、系统 UI（edge-to-edge、画中画）、真实渲染 |
| 真机/模拟器 instrumented | 设备 | 真实 WebView、真实 insets、真实渲染、跨进程行为 | 不适合做海量断言（慢、脆） |

**官方对 Robolectric 的表述很直接：依赖 `WebView` 或系统 UI 的用例仍然需要设备测试。** 也就是说，WebView 外壳类 App 里「页面到底被判成什么状态」这件事，Robolectric 给不了可信答案。

## 二、因此的切分原则

判据不是「哪个好测」，而是：**这段逻辑判错了会造成什么后果？**

- 判错只影响显示 → JVM 单测足够。
- 判错会**不可逆地破坏用户数据**（删 cookie、删档案、改配置）→ 必须既有 JVM 单测（穷举分支）**又**有真机验证（确认假设成立）。

本项目就是照这条切的：

1. **判据本体抽成纯函数**（`classify(title, body) -> "0"/"1"/"2"`），跑 20 条 JVM 单测穷举页面形态与优先级。
2. **只把「取值」这一半交给真机** —— `document.title` / `document.body.innerText` 两条 `evaluateJavascript`，7 条 instrumented 用例验证中文、转义、`display:none`、`about:blank`。
3. 于是「判错就删用户 cookie」这件事有了 27 条覆盖，其中 20 条是毫秒级的。

反过来说，第一版把整段判据 JS 塞进 instrumented 测试，结果是 `<no result>` + 渲染进程崩溃 —— 因为它同时需要真机、又有固定延时假设、还反复创建销毁 WebView。**把「需要真机」和「不需要真机」的部分混在一个字符串里，测试成本会变成二者之和。**

## 三、Robolectric 仍然值得用的地方

不是说 Robolectric 没用。它的强项是**生命周期与状态**：

- 配置变更（旋转）后 View 有没有崩。
- `SavedStateHandle` 能不能真的把状态带过进程死亡。
- SharedPreferences 的读写路径。

代价是：`Robolectric` 需要额外的 `@Config` 与 shadow 知识，且**它测的是 shadow 的行为，不是真设备的行为**。凡是「shadow 都能模拟得像」的地方，它省时间；凡是「shadow 猜得不准」的地方（渲染、系统 UI、WebView），它会给你虚假的安全感。

## 四、CI 上跑 instrumented 的两种方式

**Gradle Managed Devices**（推荐给自建 CI）：

```kotlin
android {
    testOptions {
        managedDevices {
            devices {
                maybeCreate("pixel2api34").apply {
                    device = "Pixel 2"
                    apiLevel = 34
                    systemImageSource = "google"
                }
            }
        }
    }
}
```

然后 `./gradlew pixel2api34DebugAndroidTest`。好处是模拟器的创建、启动、销毁、结果收集全部由 Gradle 管，本机跑和 CI 跑是同一条命令，还能自动适配 x86/ARM 宿主。

**GitHub Actions 上用 emulator-runner action**：需要先开 KVM（写 udev 规则让 `/dev/kvm` 对 runner 可读），再跑 `:app:connectedDebugAndroidTest`。

两种都要注意：**第一次跑一定会慢**（要下 system image），所以 `timeout-minutes` 别设太紧；报告要作为 artifact 上传，否则失败时只能看日志。

## 五、一个容易被忽略的坑：`testOnly` 包的安装

`assembleDebugAndroidTest` 产出的测试 APK 带 `testOnly` 标记，普通 `adb install` 会被拒绝（MIUI 上表现为 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`）。

必须加 `-t`：

```
adb install -r -t app-debug-androidTest.apk
```

这个错误信息完全指向不了真正原因（看起来像用户手动点了取消），第一次遇到会查很久。
