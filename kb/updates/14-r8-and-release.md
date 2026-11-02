---
title: R8 与发布配置：从「能 debug 就行」到可交付
type: procedure
tags: r8,proguard,release,签名,minify,发布
confidence: 0.93
group: 构建
---
Debug 包能跑不等于能交付。从「自己手机上能开」到「能发出去」之间，有几项是必须补的，而且**其中一项会在你不注意的时候把构建搞成不可复现**。

## 一、先看现状：release 可能根本构建不出来

常见的一堆半成品状态：

```kotlin
release {
    isMinifyEnabled = false
    proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
}
```

而 `proguard-rules.pro` **文件并不存在**。这不一定立刻报错（文件缺失时 AGP 的行为随版本而变），但只要哪天把 `isMinifyEnabled` 打开就会失败 —— 而且是在「准备发布」这个最不该出问题的时候。

检查顺序：

1. `proguard-rules.pro` 在不在？
2. 有没有 `signingConfigs`？keystore 在哪？密码从哪来（不能进仓库）？
3. `release` 的 `isMinifyEnabled` 是不是 `false`？
4. `buildTypes` 里有没有 `debuggable` / `applicationIdSuffix` 之类的差异没对齐。

## 二、R8 的真实价值：不止是瘦身

R8 常被理解成「压缩体积的工具」，其实它更大的价值是**优化**：在 full mode 下做方法内联、类合并、常量折叠、无用代码裁剪。Google 自己在 2025 年的性能专题里把「打开 R8 optimizer full mode」列为**投入产出比最高的一项性能改动**。

但打开它的代价必须提前知道：

- **Stack trace 全变**。混淆后 `MyDataModel` 变成 `a`，崩溃日志直接不可读。必须同时产出 `mapping.txt` 并且**归档**（每个发布版本一份），否则线上崩溃没法定位。
- **反射 / 序列化炸**。JSON 反序列化、`Class.forName`、`@SerializedName`、Kotlin data class 的部分反射用法，都可能在混淆后失效。典型症状是「debug 好好的，release 一解析数据就崩」。
- **资源收缩要单独确认**。`shrinkResources` 与代码收缩是两步，且 AGP 8.12 起有「优化版资源收缩」（`android.r8.optimizedResourceShrinking=true`），它把资源当成代码引用图的一部分，能删掉以前删不掉的。

### 哪些东西必须 keep

一份最小清单（按踩坑概率排序）：

```
反射用到的类（JSON 模型、DI 注入点）
@JavascriptInterface 注解的方法      ← WebView 桥，混淆后 JS 就调不到了
原生方法（JNI）
Parcelable / Serializable 的字段名
枚举的 values()/valueOf()
```

**`@JavascriptInterface` 这条特别容易漏**，因为它是「字符串约定」：Java 侧的方法名要被 JS 侧按名字调，R8 不知道这层关系，会把 `keyboardHeight` 改成 `a`。症状是 release 包里桥完全不工作，debug 里一切正常。

## 三、签名与密钥

- keystore **绝不进仓库**（`.gitignore` 里就要挡住 `*.jks` / `*.keystore`）。
- 密码从 `local.properties` 或 CI secret 读，写法跟其他构建参数一致：先在脚本里 `findProperty` 再 fallback 到 `local.properties`，两条路都没有就**明确报错**而不是静默用空密码。
- 用了 Play App Signing 的话，本地只有 upload key，**upload key 一旦上传过 bundle 就定了**，想换只能走 reset 流程。所以第一次上传前就要想清楚。
- 自签 debug 包给测试同事装没问题，但**不能拿它当发布包**：debug 包 `debuggable=true`，任何人都能 attach 调试器读内存。

## 四、`minifyEnabled = true` 之后的验证动作

发布前必须做，顺序不能反：

1. `assembleRelease` 能过。
2. **装上 release 包真机跑一遍主链路**（不是只看它能启动）。
3. 重点复查那些「靠字符串约定」的地方：JS 桥、反射反序列化、`Intent` action、`ContentProvider` authority。
4. 保留 `mapping.txt`，并人为制造一次崩溃确认能还原出可读堆栈。

## 五、lint 基线

一个健康的项目不该长期背着几十条 warning。但也别一上来就全修 —— 正确做法是**先把现状固化成基线**：

```kotlin
lint {
    baseline = file("lint-baseline.xml")
    abortOnError = true          // 新引入的 error 必须挡住
    checkAllWarnings = true
}
```

基线里记的是「历史遗留，先不管」，之后**新增**的问题会被挡住。这样 CI 才有意义：`abortOnError = false` 等于把 lint 变成一个只会打印日志的装饰品。

本项目的实测基线是 `0 error / 29 warning`（`SetTextI18n` 10、`UnusedResources` 9、`GradleDependency` 3、`MonochromeLauncherIcon` 2，其余各 1）。这类 warning 的处理优先级：**`SetTextI18n`（文案硬编码）与 `UnusedResources`（无用资源）最高**，因为它们直接对应「以后要改文案/换语言」和「包体里塞了没用的东西」。
