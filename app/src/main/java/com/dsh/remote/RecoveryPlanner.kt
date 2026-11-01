package com.dsh.remote

/**
 * 页面当前处在什么状态 —— 由 `HEAL_PROBE_JS` 的求值结果翻译而来。
 *
 * 为什么要单独一层枚举而不是直接在 Activity 里比字符串：判断错了就会**删用户的 cookie**，
 * 删错一次用户只能重装 App。把它做成纯 JVM 类型，才能用单测把每个分支钉住。
 */
internal enum class PageState {
    /** 正常主界面 / 握手过渡页：不动手。 */
    HEALTHY,

    /** dsh web 上游 401：`dsh-auth-*` 里带着旧端口的 launch token，要清掉重来。 */
    HANDSHAKE_BROKEN,

    /** dsh-pocket 的「访问验证」页：局域网会话 cookie 失效了。 */
    PIN_REQUIRED,

    /** 求值失败或页面还没渲染：拿不准，一律不动手。 */
    UNKNOWN,
    ;

    companion object {
        /** 把 `evaluateJavascript` 的原始返回值（带引号）翻成状态。 */
        fun fromProbe(raw: String?): PageState {
            return when (raw?.trim()?.trim('"')?.trim()) {
                "0" -> HEALTHY
                "1" -> HANDSHAKE_BROKEN
                "2" -> PIN_REQUIRED
                else -> UNKNOWN
            }
        }
    }
}

/** 探测完之后该做什么。 */
internal enum class RecoveryAction {
    /** 页面没问题，或拿不准：什么都不做。 */
    NONE,

    /** 只清 `dsh-auth-*`（上游会话），保留局域网 PIN 会话。 */
    CLEAR_UPSTREAM_COOKIE,

    /** 清掉失效的 `dsh_pocket_token`，再用 URL 里的 `?token=` 重新导航。 */
    CLEAR_POCKET_COOKIE,

    /** 修不了（URL 里没有 token），提示用户重新扫码或粘贴带 token 的地址。 */
    ASK_USER,
}

/**
 * 「页面坏了该怎么修」的决策中心。
 *
 * ## 为什么需要它
 *
 * 真机上报的故障是「打开 App 又要我输 PIN，可地址里明明带着 token」。
 * 根因在 dsh-pocket 一侧（`lib/proxy.mjs:509-525`，`maybeSeedAuthCookie`）：
 *
 * ```js
 * function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
 *   if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;   // ← 就在这里
 *   ...
 * }
 * ```
 *
 * 只要请求里还带着**一个哪怕早已失效**的 `dsh_pocket_token`，代理就不肯下发新的。
 * 于是链路变成：`GET /?token=PIN` 认证通过 → 过渡页「正在进入」→
 * 下一跳 `GET /` 带着那个坏 cookie → 认证失败 → 「访问验证」页。
 * 用户看到的就是「token 在地址栏里，却还要我输密码」。
 *
 * 实测对照（本机 3081，用不同 `cf-connecting-ip` 换掉握手计数做隔离）：
 *
 * ```
 * 基线  无 cookie      + /?token=PIN → 200 seed=True  → GET / → 200 len=47868 DeepSeek Harness
 * 故障  残留坏 cookie  + /?token=PIN → 200 seed=False → GET / → 200 len=3969  DSH Pocket · 访问验证
 * 修复  清 cookie 后   + /?token=PIN → 200 seed=True  → GET / → 200 len=47868 DeepSeek Harness
 * ```
 *
 * ## 铁律
 *
 * **只有在 URL 里确实还带着 `?token=` 时，才允许清 `dsh_pocket_token`。**
 * 没有 token 就清掉，等于把用户永久锁在验证页外面——那个页面没有密码可填，
 * 用户早就忘了当初的 PIN。这种情况下宁可什么都不做，让用户重新扫码。
 */
internal object RecoveryPlanner {

    /** 决策主函数：给定页面状态与入口 URL，返回该执行的动作。 */
    fun plan(state: PageState, url: String?): RecoveryAction = when (state) {
        PageState.HEALTHY, PageState.UNKNOWN -> RecoveryAction.NONE
        PageState.HANDSHAKE_BROKEN -> RecoveryAction.CLEAR_UPSTREAM_COOKIE
        PageState.PIN_REQUIRED ->
            if (hasPinToken(url)) RecoveryAction.CLEAR_POCKET_COOKIE else RecoveryAction.ASK_USER
    }

    /**
     * URL 的 query 里是否带着非空的 `token`。
     *
     * 自己解析而不用 `Uri.getQueryParameter`：这一层要能被纯 JVM 单测覆盖，
     * `android.net.Uri` 在单测里是空实现。顺带也避免把 fragment 里的 `token=` 误判成 query。
     */
    fun hasPinToken(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val query = url.substringAfter('?', "").substringBefore('#')
        if (query.isEmpty()) return false
        return query.split('&').any { pair ->
            val name = pair.substringBefore('=')
            name == "token" && pair.substringAfter('=', "").isNotEmpty()
        }
    }

    /**
     * 给 URL 加上 `dsh-pocket-retry=1`（**幂等**）。
     *
     * 该参数在 dsh-pocket 侧会清掉握手失败计数（`proxy.mjs:928`），否则短时间内重连几次
     * 就会撞上 503「无法完成登录握手」，自愈反而把用户挡在门外。
     *
     * 注意要插在 `#` 之前：直接拼在末尾时，`?dsh-pocket-retry=1` 会落进 fragment，
     * 服务端根本收不到。
     */
    fun withRetry(url: String?): String? {
        if (url.isNullOrBlank()) return null
        if (url.contains("dsh-pocket-retry=1")) return url
        val hashAt = url.indexOf('#')
        val head = if (hashAt >= 0) url.substring(0, hashAt) else url
        val tail = if (hashAt >= 0) url.substring(hashAt) else ""
        val sep = if (head.contains('?')) "&" else "?"
        return head + sep + "dsh-pocket-retry=1" + tail
    }
}
