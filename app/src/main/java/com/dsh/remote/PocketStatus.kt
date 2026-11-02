package com.dsh.remote

/**
 * 从 dsh-pocket 的状态 RPC 里挑出「出门也能用的地址」。**纯 JVM，可单测。**
 *
 * ## 为什么需要
 *
 * dsh-pocket 同时提供两个入口：
 * - **局域网** `http://<电脑内网IP>:3081` —— 只有同一个 Wi-Fi 下能用；
 * - **公网隧道** `https://<随机名>.trycloudflare.com` —— 手机走流量也能用。
 *
 * 手机侧过去只知道局域网那一个（扫网段扫出来的），所以一旦离开家就必然连不上，
 * 而这台手机的实际情况就是**长期只插流量卡**。用户要的是「在外面也能连」，
 * 那就必须把公网地址也拿到手上。
 *
 * ## 地址从哪来
 *
 * dsh-pocket 有 RPC 通道 `/dsh-pocket/<method>`（见服务端 `lib/web-rpc.js`），
 * `pocket.status` 的返回里带：
 *
 * ```json
 * {"proxyPort":3081,"lanUrl":"http://192.168.50.58:3081","tunnelRunning":true,
 *  "tunnelUrl":"https://tunnel-a.trycloudflare.com",
 *  "accessToken":"87654321","lanToken":"12345678","lanAuthEnabled":false}
 * ```
 *
 * 实测要点（2026-11-03）：
 * - **必须带 cookie**：裸 POST 恒 `401 Unauthorized`，body 是 `unauthorized`；
 * - cookie 就是正常 GET `/` 之后下发的 `dsh-auth-*`，WebView 里已经有了；
 * - `tunnelRunning=false` 时 `tunnelUrl` 可能仍留着一个**过期**地址，
 *   所以判据是「`tunnelRunning` 为真 **且** url 能解析」两个都满足。
 *
 * ## 为什么不引 JSON 库
 *
 * 单元测试跑在纯 JVM 上，`org.json` 在这里是空实现（Android SDK 的 jar 只有签名）。
 * 为了能单测这个解析，就只做「按键取值」这一件事，够用且没有依赖。
 * 想换成真正的 JSON 解析器时，只要保持 [parse] 的入参与返回不变即可。
 */
internal object PocketStatus {

    /** RPC 路径前缀（服务端 `lib/web-rpc.js` 的 `RPC_PREFIX`）。 */
    const val RPC_PATH = "/dsh-pocket/pocket.status"

    /**
     * 一次状态查询的结果。
     *
     * @param tunnelUrl 公网隧道地址，可能为空字符串（没开隧道）。
     * @param lanUrl 局域网地址，例如 `http://192.168.50.58:3081`。
     * @param tunnelRunning 隧道进程是否在跑。**这个为假时 tunnelUrl 不可信。**
     * @param accessToken 公网 PIN。只有 `lanAuthEnabled=false` 时局域网才免 PIN，
     *   公网**永远**要 PIN，所以拼公网地址时必须带上它。
     */
    data class Snapshot(
        val tunnelUrl: String?,
        val lanUrl: String?,
        val tunnelRunning: Boolean,
        val accessToken: String?,
    )

    /**
     * 从 RPC 响应正文里取字段。
     *
     * 返回 null 表示「这不是一个能用的响应」——不是 JSON 对象、或者根本不是 pocket 的回复。
     * 判据故意宽松：只要是 `{` 开头且能取到 `proxyPort` 或 `lanUrl` 之一就算。
     * 宽松是有意的：这里唯一的用途是「能不能多拿到一个能连的地址」，
     * 解析失败最坏也就是继续用局域网，不该因为格式微调就整体失效。
     */
    fun parse(body: String?): Snapshot? {
        val text = body?.trim().orEmpty()
        if (!text.startsWith("{")) return null
        // **字段不在顶层**。服务端信封是
        // `{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{…字段…}}}`
        // 实测（2026-11-03）第一版直接在顶层取键，结果永远取不到，
        // 日志只有一句 `pocket.status: no usable public address`，看起来像「隧道没开」。
        // 这里先剥掉信封；也兼容字段直接在顶层的老格式。
        val scope = payloadScope(text) ?: text
        val lanUrl = rawString(scope, "lanUrl")
        val proxyPort = rawNumber(scope, "proxyPort")
        if (lanUrl == null && proxyPort == null) return null
        return Snapshot(
            tunnelUrl = rawString(scope, "tunnelUrl"),
            lanUrl = lanUrl,
            tunnelRunning = rawBoolean(scope, "tunnelRunning") == true,
            accessToken = rawString(scope, "accessToken"),
        )
    }

    /**
     * 从状态里推出「公网档案」。拿不到完整信息就返回 null。
     *
     * 三条硬约束：
     * 1. **`tunnelRunning` 必须为真** —— 关掉隧道后 `tunnelUrl` 仍留在 JSON 里，
     *    照抄会得到一个 530 的死地址（实测旧 quick tunnel 就是这样变成 530 的）；
     * 2. url 必须是 `https://`，且主机以 `.trycloudflare.com` 结尾 —— 防止把
     *    设置里填的乱七八糟的东西当地址（服务端只做透传，不做校验）；
     * 3. **带上 `accessToken`** —— 公网入口永远要 PIN，不带就是验证页，白连一次。
     */
    fun publicEndpoint(body: String?, now: Long): Endpoint? {
        val snap = parse(body) ?: return null
        if (!snap.tunnelRunning) return null
        val base = snap.tunnelUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() } ?: return null
        if (!base.startsWith("https://", ignoreCase = true)) return null
        if (Endpoint.parseUri(base) == null) return null
        val host = Endpoint.hostOf(base) ?: return null
        if (!host.endsWith(".trycloudflare.com", ignoreCase = true)) return null
        val url = BootstrapUrl.build(base, snap.accessToken) ?: return null
        return Endpoint(
            id = EndpointStore.idFor(LABEL, url),
            label = LABEL,
            url = url,
            lastUsedAt = 0L,
        )
    }

    /** 公网档案在列表里显示的名字。 */
    const val LABEL = "公网隧道"

    // ---- 极简取值：只认**顶层**键，不做转义还原（这些值里不会出现转义字符） ----
    //
    // 为什么要判层深：响应里 `tunnelState` 之类的嵌套对象也可能带同名键，
    // 直接 `indexOf("\"tunnelUrl\"")` 会把内层那个当顶上层的值（单测里钉住了）。
    // 于是先扫一遍拿到「顶层键 → 值起始下标」，再按需读取。

    /**
     * 剥掉 RPC 信封，返回真正装着字段的那层对象（含花括号）。
     *
     * 服务端的实际形状是：
     * ```json
     * {"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"lanUrl":…}}}
     * ```
     * 字段全在 `result.value` 里。取不到信封时返回 null，由调用方退回「整段就是负载」的老格式。
     */
    private fun payloadScope(json: String): String? {
        val resultAt = topLevelKeys(json)["result"] ?: return null
        if (resultAt >= json.length || json[resultAt] != '{') return null
        val resultEnd = endOfObject(json, resultAt)
        if (resultEnd < 0) return null
        val resultObj = json.substring(resultAt, resultEnd + 1)
        val valueAt = topLevelKeys(resultObj)["value"] ?: return null
        if (valueAt >= resultObj.length || resultObj[valueAt] != '{') return null
        val valueEnd = endOfObject(resultObj, valueAt)
        if (valueEnd < 0) return null
        return resultObj.substring(valueAt, valueEnd + 1)
    }

    /** 与 `start` 处 `{` 配对的那个 `}` 的下标（跳过字符串字面量里的括号）。 */
    private fun endOfObject(json: String, start: Int): Int {
        var depth = 0
        var i = start
        while (i < json.length) {
            when (json[i]) {
                '"' -> {
                    val end = endOfString(json, i)
                    if (end < 0) return -1
                    i = end + 1
                    continue
                }
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return i
                }
            }
            i++
        }
        return -1
    }

    /** 找出 `json` 里处于**顶层**（层深 = 1）的键，返回 `键 → 值起始下标`。 */
    private fun topLevelKeys(json: String): Map<String, Int> {
        val out = HashMap<String, Int>()
        var depth = 0
        var i = 0
        var pendingKey: String? = null
        while (i < json.length) {
            val c = json[i]
            when {
                c == '"' -> {
                    val end = endOfString(json, i)
                    if (end < 0) return out
                    val raw = json.substring(i + 1, end)
                    // 键后面紧跟冒号才算键，否则是字符串值。
                    val next = json.indexOfFirstAfter(end + 1) { !it.isWhitespace() }
                    if (next >= 0 && json[next] == ':' && depth == 1) {
                        pendingKey = raw
                        val valueStart = json.indexOfFirstAfter(next + 1) { !it.isWhitespace() }
                        if (pendingKey != null && valueStart >= 0) out[pendingKey!!] = valueStart
                    }
                    i = end + 1
                }
                c == '{' || c == '[' -> { depth++; i++ }
                c == '}' || c == ']' -> { depth--; i++ }
                else -> i++
            }
        }
        return out
    }

    private inline fun String.indexOfFirstAfter(from: Int, predicate: (Char) -> Boolean): Int {
        var i = from
        while (i < length) {
            if (predicate(this[i])) return i
            i++
        }
        return -1
    }

    /** 字符串字面量的结束引号下标（支持 `\"`）。 */
    private fun endOfString(json: String, start: Int): Int {
        var i = start + 1
        while (i < json.length) {
            when (json[i]) {
                '\\' -> i += 2
                '"' -> return i
                else -> i++
            }
        }
        return -1
    }

    private fun rawString(json: String, key: String): String? {
        val at = topLevelKeys(json)[key] ?: return null
        if (at >= json.length || json[at] != '"') return null
        val end = endOfString(json, at)
        if (end < 0) return null
        return json.substring(at + 1, end)
    }

    private fun rawNumber(json: String, key: String): Int? {
        val at = topLevelKeys(json)[key] ?: return null
        val sb = StringBuilder()
        var i = at
        while (i < json.length && sb.length < 6) {
            val c = json[i]
            if (c.isDigit() || (c == '-' && sb.isEmpty())) sb.append(c) else break
            i++
        }
        return sb.toString().toIntOrNull()
    }

    private fun rawBoolean(json: String, key: String): Boolean? {
        val at = topLevelKeys(json)[key] ?: return null
        val rest = json.substring(at)
        return when {
            rest.startsWith("true") -> true
            rest.startsWith("false") -> false
            else -> null
        }
    }
}
