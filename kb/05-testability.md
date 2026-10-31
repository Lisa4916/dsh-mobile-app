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
