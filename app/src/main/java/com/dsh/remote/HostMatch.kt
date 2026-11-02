package com.dsh.remote

/**
 * 「这个跳转还在自己那台电脑里吗」——决定 URL 留在 WebView 还是交给系统浏览器。
 *
 * 为什么单独抽出来：原来这判断只有一行
 * `url.contains(endpointHost, ignoreCase = true)`，
 * 用的是**子串包含**。实测四种情况三种判错（全部留在 WebView 里）：
 *
 * | URL                                          | 旧判定   | 应为     |
 * |----------------------------------------------|----------|----------|
 * | `https://<host>/page`                        | 同域 ✅  | 同域     |
 * | `https://evil.com/?x=<host>`                 | 同域 ❌  | 外链     |
 * | `https://<host>.evil.com/steal`              | 同域 ❌  | 外链     |
 * | `https://evil.com/#<host>`                   | 同域 ❌  | 外链     |
 *
 * 后果不是「显示丑」：外部页面被留在没有地址栏的 WebView 里，用户看起来和 DSH 一模一样，
 * 而 WebView 上挂着 `dshNative` JS 桥（[WebViewFactory.JS_BRIDGE_NAME]）。
 *
 * 抽成纯 JVM 对象是为了能写单测——这类判断错一次就是安全缺口，不能靠真机试。
 * 注意实现里**只用 `java.net.URI`，不用 `android.net.Uri`**：后者在单测里是空实现
 * （`Uri.parse` 返回的 `host` 永远是 null），一用就没法测了。
 */
internal object HostMatch {

    /**
     * [target] 是否与 [allowedHost] 是同一台主机。
     *
     * 判定规则（从严）：
     * 1. 两边都要能解析出 host，否则 false（宁可按外链处理）。
     * 2. host 大小写不敏感、去掉末尾点（`example.com.` 与 `example.com` 等价）。
     * 3. 要求**精确相等**或**以 `.` + allowedHost 结尾**——后者允许子域名（如
     *    quick tunnel 换了子域），但 `evilexample.com` 这种只是后缀相同的**不算**。
     */
    fun isSameHost(target: String?, allowedHost: String?): Boolean {
        val allow = normalize(allowedHost) ?: return false
        val host = normalize(Endpoint.hostOf(target ?: return false)) ?: return false
        if (host == allow) return true
        // 子域名：必须以 ".allow" 结尾，且 .allow 前面还有东西
        return host.endsWith(".$allow")
    }

    /**
     * 是否该交给系统浏览器。
     *
     * 只拦 http/https：`mailto:` / `intent:` / `tel:` 之类不属于「外链网页」，
     * 交给系统反而更自然（旧实现也是这个口径，这里保持不变以免改变既有行为）。
     */
    fun shouldOpenExternally(target: String?, allowedHost: String?): Boolean {
        val url = target?.trim().orEmpty()
        val isWeb = url.startsWith("http://", ignoreCase = true) ||
            url.startsWith("https://", ignoreCase = true)
        if (!isWeb) return false
        return !isSameHost(url, allowedHost)
    }

    /** host 归一化：trim、转小写、去 IPv6 方括号、去末尾点。解析不出返回 null。 */
    private fun normalize(host: String?): String? {
        val h = host?.trim()?.lowercase() ?: return null
        if (h.isEmpty()) return null
        return h.removePrefix("[").removeSuffix("]").trimEnd('.').ifEmpty { null }
    }
}
