---
title: 架构分层：什么时候该拆、拆到什么粒度
type: decision
tags: 架构,mvvm,modularization,viewmodel,单测
confidence: 0.9
group: 架构
---
「要不要上 MVVM / 要不要模块化」这类问题，网上给的答案通常是「最佳实践都这么做」。但本项目（一个不到两千行的 WebView 外壳）实测下来，结论要具体得多：**拆的判据不是代码量，而是「这段逻辑判错了会怎样」和「它能不能在 JVM 里被测」。**

## 一、拆的依据：可测性与不可逆后果

一个 `Activity` 涨到 900 行不可怕，可怕的是**里面混着两类东西**：

- 一类是「必须有 Android 才能做」的：View 树构造、WindowInsets 回调、WebView 生命周期。
- 另一类是「其实是纯逻辑」的：URL 解析、cookie 该删哪一类、页面状态判成什么、失败后怎么退避。

第二类留在 Activity 里的唯一后果是：**它只能靠真机试错来验证**。而真机试错有两个致命缺陷 —— 慢，以及不可穷举。

本项目的拆分顺序完全由这条驱动：

| 抽出什么 | 触发它的事件 |
|---|---|
| `Endpoint`（URL 解析 + 类型推断） | `android.net.Uri` 在 JVM 单测里是 stub，测试根本跑不起来 |
| `RecoveryPlanner`（该不该清 cookie、清哪一种） | 判错会让用户**永久锁在验证页外**，不能靠试 |
| `HandshakeHealGate`（退避与预算） | 时序逻辑，真机上无法稳定复现「第 4 次请求」 |
| `PageProbe`（页面状态判据） | 判错会删用户数据；且状态组合本身是纯枚举 |
| `CookieNames`（删哪一类） | 同一段逻辑曾在 Activity 里写了两遍，两处不一致 |
| `ConnectionRepository` + `AutoConnect` | 「启动时连哪个」是个三态决策，值得穷举 |

抽完之后 `MainActivity` 仍有 ~950 行，但剩下的确实都必须是 Android。**这才是拆分的正确终点**：不是「Activity 一定要短」，而是「Activity 里不该有能被单测的东西」。

## 二、注入副作用，而不是注入 Android

抽纯逻辑类时最常见的半途而废是：类抽出来了，但里面还在 `Log.i(...)`、还在直接 `webView.loadUrl(...)`、还在 `System.currentTimeMillis()`。这样测试照样写不了。

正确做法是**把副作用做成接口**：

```kotlin
interface RecoveryEnvironment {
    fun clearUpstreamCookies(url: String)
    fun clearPocketCookie(url: String)
    fun navigate(url: String)
    fun notifyUser(message: String)
    fun log(message: String)
}
```

于是 `RecoveryExecutor` 变成「输入探针结果 → 输出一个枚举 + 若干次 env 调用」，测试里塞一个 `FakeEnv` 记录调用，就能断言：

- 清的是哪一类 cookie（而不是「有没有清」）
- `ASK_USER` 分支**一次 cookie 都没碰**
- 同一轮故障里 Toast 只弹一次
- 退避窗口内第二次调用被挡

四条里后三条全是「本不该发生的事」，这才是真正防回归的部分。

### 三个注入点，优先级从高到低

1. **时间**：`System.currentTimeMillis()` → 构造参数 `now: () -> Long`。否则退避逻辑要么测不了，要么测试得真等 30 秒。
2. **日志**：`android.util.Log` → 接口。它在 JVM 单测里是 stub，会让整个类不可测。
3. **解析器**：`android.net.Uri` → `java.net.URI`。这条不是洁癖，是硬需求。

## 三、什么时候才轮到模块化

`Guide to Android app modularization` 的出发点是「代码库变大了之后，可维护性、可读性、整体质量会下降」。它解决的是**多人/多特性并行**的问题：编译隔离、按特性分模块、可复用给多个 App。

对一个单人维护、两千行的外壳 App，拆成 `:feature:xxx` 多模块的收益接近零，成本是把 Gradle 配置复杂度翻几倍。判据应当是：

- 有没有**第二个 App** 要复用这些模块？（没有就先别拆）
- 有没有**多个特性并行开发**，需要编译隔离？（没有就先别拆）
- 有没有**构建慢到影响迭代**？（本项目全量 25 秒，没到）

真正值得先做的不是模块化，而是**包内分层清晰**：`ui` / `domain`（纯逻辑）/ `data`（持久化）/ `integration`（外部依赖契约）。这在单模块内就能做到，且随时可以升级成模块。

## 四、MVVM 与 ViewModel：本项目为什么没用

不是反对 MVVM，是**它解决的那个问题本项目不存在**：

- `ViewModel` 的核心价值是「配置变更时不丢状态」。本项目用 manifest 的 `configChanges` 直接阻止 Activity 重建，这个需求被绕过了。
- `LiveData`/`StateFlow` 的价值是「数据变了 UI 自动刷」。本项目 UI 是代码构造的、状态只有「列表 / WebView / 加载中」三态，手写切换比引入一套响应式更短。
- 代价是：**没法用 `SavedStateHandle` 处理进程死亡**。现在靠的是「状态都在 SharedPreferences 里，重建后重新读」，够用但不如 `SavedStateHandle` 精确。

如果哪天要做的事变成「多个页面共享登录态与连接状态」，那时候上 ViewModel + `StateFlow` 是对的；现在上就是纯开销。

## 五、一句话判据

> 想知道该不该拆，就看这段逻辑**现在能不能在两秒内验证**。不能，就拆它。

模块化、MVVM、Clean Architecture 都是手段，它们的目标都是「让验证变便宜」。如果拆完之后验证成本没降，那就是拆错了层。
