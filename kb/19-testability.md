# 单测可测性：把 Android API 挤出纯 JVM 逻辑

> 适用环境：Android 项目 + JUnit4 本地单测（`testDebugUnitTest`，跑在 JVM 上不是设备上）。
> 最后验证：2026-10

## 核心原则

**本地单测跑在 JVM 上，所有 `android.*` 类都是空壳 stub，调方法直接抛 `RuntimeException: Stub!`。** 所以判据很简单：被测类里只要 import 了 `android.*`，它就不可能被本地单测覆盖。

解法不是去装 Robolectric，而是**把 Android API 从核心逻辑里挤出去**。

## 经典踩坑：`android.net.Uri` 在单测里抛 Stub!

```kotlin
// 被测代码
val uri = Uri.parse(input)          // 单测里：java.lang.RuntimeException: Stub!
val host = uri.host
```

- **根因**：`android.net.Uri` 的实现体在 `android.jar` 里是桩，只有 `throw new RuntimeException("Stub!")`。
- **错误修法**：加 Robolectric 或 mockito-inline —— 引入重依赖，且掩盖了"这个类本来不该依赖 Android"的设计问题。
- **正确修法**：换成 `java.net.URI`（纯 JDK）：

```kotlin
class Endpoint private constructor(
    val scheme: String,
    val host: String,
    val port: Int,
    val path: String,
    val token: String?
) {
    val baseUrl: String get() = "$scheme://$host:$port$path"
    val displayUrl: String get() = baseUrl + if (token != null) "?token=$token" else ""

    companion object {
        fun parse(raw: String): Endpoint {
            val uri = java.net.URI(raw.trim())        // ← 纯 JDK，可测
            val scheme = uri.scheme?.lowercase() ?: "http"
            val host = uri.host ?: throw IllegalArgumentException("缺少主机")
            val port = if (uri.port > 0) uri.port else if (scheme == "https") 443 else 80
            val path = uri.path?.takeIf { it.isNotEmpty() } ?: "/"
            val token = uri.query?.split('&')
                ?.firstOrNull { it.startsWith("token=") }
                ?.substringAfter("token=")
            return Endpoint(scheme, host, port, path, token)
        }
    }
}
```

- **判据**：`java.net.URI` 的行为差异要注意——`URI("192.168.1.1:3081")` 会把 `192.168.1.1` 当成 scheme（因为带冒号且前面不是合法 scheme 时……实际上它要求 scheme 以字母开头，所以会抛异常）。**输入要先补 `http://` 再 parse**，并且单测里要有这一条用例。

## 设计手法：三层拆分

```
UI 层（Activity / Fragment）      ← Android API，不写单测
   ↓ 只做转手
领域层（纯 Kotlin data class + 函数）   ← 全部可测
   ↓
平台层（Uri / SharedPreferences / Log）  ← 薄封装，接口化
```

**可测性判据**：领域层文件的 import 列表里不出现 `android`。一条 `grep -r "^import android" domain/` 返回空就是合格的。

## 具体替换表（Android API → 纯 JDK 等价物）

| 想用的 Android API | 换成 | 注意 |
|---|---|---|
| `android.net.Uri` | `java.net.URI` | 行为不完全一致，输入要先补 scheme |
| `android.text.TextUtils.isEmpty` | `s.isNullOrEmpty()` | |
| `android.util.Base64` | `java.util.Base64` | API 26+ 才有，minSdk 低于 26 要自己实现 |
| `android.util.Log` | 注入一个 `Logger` 接口 | 单测里传 `{}` |
| `SystemClock.elapsedRealtime` | 注入 `Clock` 接口 | |
| `Context.getSharedPreferences` | 抽象成 `EndpointStore` 接口 + 内存实现 | |
| `String.format` | 本来就可测 | |

## 分层存储的例子

```kotlin
// 接口（纯 Kotlin）
interface EndpointStore {
    fun load(): Endpoint?
    fun save(endpoint: Endpoint)
    fun clear()
}

// 生产实现（依赖 Android）
class PrefsEndpointStore(context: Context) : EndpointStore { /* SharedPreferences */ }

// 测试实现（纯内存）
class InMemoryEndpointStore : EndpointStore {
    private var current: Endpoint? = null
    override fun load() = current
    override fun save(endpoint: Endpoint) { current = endpoint }
    override fun clear() { current = null }
}
```

这样解析逻辑、默认值回退、token 拼接、URL 规范化这些**真正会出 bug 的部分**全都能单测。

## 测试基线的维护

```powershell
& gradle.bat -p D:\myapp :app:testDebugUnitTest --console=plain -q
Select-String -Path 'D:\myapp\app\build\test-results\testDebugUnitTest\*.xml' -Pattern 'tests=|failures=|errors='
```

期望输出形如 `tests="12" failures="0" errors="0"`。

**把这个数字写进项目的 AGENTS.md / PROGRESS.md 当基线。** 每次改动后数字只能增不能减；减少了说明有测试被删或没跑起来。

## 坑：`testDebugUnitTest` 与 `test` 的区别

- `:app:test` 会跑所有变体的单测，可能触发 `testReleaseUnitTest` 编译失败（release 变体有额外规则如 R8）。
- 日常只用 `:app:testDebugUnitTest`。

## 坑：空断言（`assertEquals(X, X)`）永远为真

```kotlin
assertEquals(MAX_ACT_PER_INCIDENT, MAX_ACT_PER_INCIDENT)   // 常量自比自，恒为真
```

- **现象**：单测报 22 passed / 0 failed，但那条用例什么都没测——它只证明常量等于它自己。
- **根因**：想断言"上限不被突破"，却把受检对象写成了常量本身，而不是被测函数实际产出的计数。
- **正确做法**：断言真实输出，例如实际放行次数：

```kotlin
assertEquals(MAX_ACT_PER_INCIDENT, allowed)   // allowed 由被测逻辑累计
```

- **判据（怎么揪出空断言）**：把断言里的期望值故意改错（如 `MAX_ACT_PER_INCIDENT - 1`）再跑；**仍然通过 → 这条断言是空的**。验证完必须还原。
- **配套**：跑 Gradle 单测加 `--rerun-tasks`，否则可能命中构建缓存，拿到的是上一次的 passed 数字而不是本次结果。

## 坑：恒真断言让用例形同虚设（全绿 ≠ 测过）

- **现象**：`testDebugUnitTest` 报 `tests="22" failures="0" errors="0"`，其中却有用例什么都没验。
- **实例**（dsh-mobile-app）：`HandshakeHealGateTest.kt` 的 `mayAct_capsAtMaxPerIncident` 写成

```kotlin
assertEquals(HandshakeHealGate.MAX_ACT_PER_INCIDENT, HandshakeHealGate.MAX_ACT_PER_INCIDENT)
```

  断言两侧是同一个常量，恒为真。该用例本意是「单次 incident 内放行次数不超过上限」，但从未调用被测函数。
- **根因**：`assertEquals(expected, actual)` 只按位置取值，编译器不检查两侧是否指向同一符号，JUnit 也直接判通过。复制粘贴后漏改 actual 一侧是最常见的来源。
- **判据**：断言两侧出现同一个常量名 / 同一个字面量 / 同一个表达式 → 该断言不可能失败。静态自查（正则反向引用）：

```powershell
Select-String -Path 'app\src\test\**\*.kt' -Pattern 'assertEquals\(\s*(.+?)\s*,\s*\1\s*\)'
```

- **正确做法**：断言被测函数的可观测结果，不用常量自比。上限类逻辑要拉一个真实计数器：

```kotlin
val allowed = runCalls(n = HandshakeHealGate.MAX_ACT_PER_INCIDENT + 1)  // 实际放行次数
assertEquals(HandshakeHealGate.MAX_ACT_PER_INCIDENT, allowed)
```

  期望值用常量，实际值必须来自**调用产生的副作用计数**。
- **与直觉相反**：基线 `tests=22 failures=0` 只能证明用例跑完且没抛异常，**不能证明它们断言了有意义的东西**；恒真断言会让基线虚高。写进 AGENTS.md / PROGRESS.md 的基线数字要配合一条硬要求：每条用例至少有一个会随实现改动而变红的断言。
- **反向验证（写新用例后必做）**：临时把期望值改错（如 `MAX_ACT_PER_INCIDENT + 1`），重跑必须变红；仍是绿就说明这条用例是空的。做过这一步再宣称「测试全绿」。

## 坑：自比自的断言恒真（用例绿但什么都没验证）

- **现象**：用例里出现同一边写两遍的断言，永远通过。实测原样：

```kotlin
assertEquals(HandshakeHealGate.MAX_ACT_PER_INCIDENT, HandshakeHealGate.MAX_ACT_PER_INCIDENT)
```

这条看起来在验证「单次事故的最大动作额度」，实际只证明了常量等于自己。

- **根因**：`assertEquals` 两个实参在编译期就是同一表达式；把实现里的额度上限改错、甚至删掉额度判定逻辑，这条用例依然全绿。
- **判据**：`tests="12" failures="0"` 的基线数字不说明断言有效。机械识别：grep 断言两侧文本相同，例如 `assertEquals\(\w+(\S*), \1\)` 命中即是恒真。
- **正确做法**：断言一侧必须是**用例独立构造的期望值或规范字面量**，不能引用被测常量本身。

```kotlin
assertEquals(3, HandshakeHealGate.MAX_ACT_PER_INCIDENT)   // 规范值写死
assertEquals(expected, gate.evaluate(input))              // expected 由用例自己算
```

- **验证手法（先让它红）**：把被测常量临时改成 `MAX_ACT_PER_INCIDENT - 1` 跑一次 `testDebugUnitTest`，用例必须变红，再改回。改不红的那条断言等于没有断言。
- **与直觉相反**：同文件里的其他断言（如后续的 `assertFalse(...)`）是有效的，所以一条恒真断言通常**不致命但会长期潜伏**，让基线数字虚高、掩盖真实回归。审查断言有效性比数 tests 数量重要。

## 案例：把返回导航的分支决策抽成纯 JVM 类

- **症状**：返回处理的三分支（会话页 / 开始界面 / 页面状态认不出）+ 兜底计数全部内联在 `MainActivity.installBackHandling()` 里，`evaluateJavascript` 回调里做 `when`，一行都测不了。
- **做法**：抽成 `BackNavigationDecider`——纯 Kotlin，输入「页面当前层级 + 已后退步数」，输出动作（退回开始界面 / 退出 App / 兜底回首页）；`MainActivity` 只负责取页面状态（`DSH_LOCATION_JS`）并执行返回的动作。
- **结果**：新增 `BackNavigationDeciderTest` 11 条用例，覆盖 back handling 与 exit-through-home 两条路径；`/app:testDebugUnitTest` BUILD SUCCESSFUL，合计 tests=33 failures=0（EndpointTest 12 + HandshakeHealGateTest 10 + BackNavigationDeciderTest 11）。
- **判据**：被测文件 import 列表里不出现 `android`，就能直接在 JVM 上跑，不需要 Robolectric / mockito-inline。
- **基线维护**：把这个数字写进项目文档当基线，本次由 22 → 33（新增 11 条），只增不减。
