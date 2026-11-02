package com.dsh.remote

/**
 * 内置连接地址的拼接逻辑（纯 JDK，可单测）。
 *
 * 起因：内置地址原来是硬编码在 [MainActivity] 里的
 * `http://<局域网IP>:3081/?token=<PIN>`。两个问题：
 * 1. **PIN 泄漏**：地址里的 `token=` 就是 dsh-pocket 的局域网访问密码，进仓库就等于公开；
 * 2. **写死 IP**：换网段、换电脑就报废，用户只能删掉重录。
 *
 * 现在改成构建时注入：`local.properties`（已 gitignore）里填 `dsh.lanUrl` 与 `dsh.lanPin`，
 * `app/build.gradle.kts` 把拼好的完整地址塞进 `BuildConfig.DEFAULT_LAN_URL`。
 * 两者任一为空时 `BuildConfig.DEFAULT_LAN_URL` 是空串，App 直接走「扫码 / 手输」引导，
 * 不假装有一个能用的地址。
 *
 * 校验放在 Gradle 侧（见 build.gradle.kts），这里只负责拼。
 */
internal object BootstrapUrl {

    /**
     * 把 [host] 与 [pin] 拼成 App 能直接连接的入口；任一为空则返回 null。
     *
     * 容错点（都踩过）：
     * - `dsh.lanUrl` 可能被填成带 scheme 的完整地址 → 不再重复拼 `http://`；
     * - 可能带尾斜杠或前后空格 → 规范化掉；
     * - 可能残留旧的 `?token=` → 丢掉，只用新 PIN，避免拼出两个 token；
     * - PIN 若含 `&`、`=` 等字符必须编码，否则 query 会被截断。
     */
    fun build(host: String?, pin: String?): String? {
        val h = host?.trim().orEmpty()
        val p = pin?.trim().orEmpty()
        if (h.isEmpty() || p.isEmpty()) return null

        val withScheme = if (h.startsWith("http://") || h.startsWith("https://")) h else "http://$h"

        // 切掉 query 与 fragment，只留 scheme://authority/path
        val cut = withScheme.indexOfFirst { it == '?' || it == '#' }
        val base = (if (cut >= 0) withScheme.substring(0, cut) else withScheme).trimEnd('/')

        // 到这一步还解析不出 host，说明填的东西根本不像地址
        val parsed = Endpoint.parseUri(base)
        if (parsed == null) return null

        return "$base/?token=${encodeQueryValue(p)}"
    }

    /**
     * 只保留 RFC 3986 的非保留字符，其余百分号编码。
     *
     * 不用 `Uri.encode` / `URLEncoder`：前者在 JVM 单测里是 stub，
     * 后者把空格编成 `+`（query 语义不同）。这里只需要一个确定、可测的结果。
     */
    private fun encodeQueryValue(raw: String): String {
        val sb = StringBuilder(raw.length)
        for (byte in raw.toByteArray(Charsets.UTF_8)) {
            val c = byte.toInt() and 0xFF
            val ch = c.toChar()
            if (ch.isLetterOrDigit() && c < 0x80 || ch in "-._~") {
                sb.append(ch)
            } else {
                sb.append('%').append(HEX[c shr 4]).append(HEX[c and 0x0F])
            }
        }
        return sb.toString()
    }

    private const val HEX = "0123456789ABCDEF"
}
