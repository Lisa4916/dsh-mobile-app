package com.dsh.remote

/**
 * 自愈执行时需要打交道的「外部世界」。
 *
 * 抽成接口的唯一目的是**让编排逻辑能被纯 JVM 单测覆盖**：真正的实现要碰
 * `CookieManager`、`WebView.loadUrl`、`Toast`，这些在本地单测里都是空壳，
 * 断言不到任何东西。把它们挡在接口后面，[RecoveryExecutor] 就只剩下
 * 「什么状态 → 干什么事」的顺序问题，而那正是以前最容易被写错的部分。
 *
 * 接口方法都收 `url` 参数而不是从闭包读 Activity 字段：执行时的目标必须显式传入，
 * 不能让「探测时的 URL」和「动手时的 URL」有机会不一致。
 */
internal interface RecoveryEnvironment {
    /** 删除所有 `dsh-auth-*`（上游会话），保留局域网 PIN 会话。 */
    fun clearUpstreamCookies(url: String)

    /** 删除 `dsh_pocket_token`（局域网 PIN 会话）。**调用前必须确认 URL 带 `?token=`**。 */
    fun clearPocketCookie(url: String)

    /** 用给定 URL 重新导航（实现方负责切回主线程）。 */
    fun navigate(url: String)

    /** 给用户一句人话（Toast）。 */
    fun notifyUser(message: String)

    /** 诊断日志。 */
    fun log(message: String)
}

/**
 * 一次探测的结局。
 *
 * 存在的意义是**可断言**：以前这段逻辑嵌在 `WebView.evaluateJavascript` 的回调里，
 * 想验证「PIN 页 + URL 没有 token 时不许清 cookie」只能上真机看页面表现 ——
 * 而那正是删错一次就要重装 App 的操作。现在它是返回值，单测直接比。
 */
internal enum class RecoveryOutcome {
    /** 页面正常：闸门已复位，下次坏还能自动修。 */
    HEALTHY,

    /** 还没开始探测（没有当前连接，或正处在动手后的静默期）。 */
    SKIPPED,

    /** 故障已确认，但本轮的次数或退避不允许再动手 —— 停下来等用户。 */
    ALREADY_HEALED,

    /** 修不了（URL 里没有 token）：只提示，**没碰任何 cookie**。 */
    ASKED_USER,

    /** 清了 `dsh-auth-*` 并用带 `dsh-pocket-retry=1` 的地址重新导航。 */
    CLEARED_UPSTREAM,

    /** 清了 `dsh_pocket_token` 并用带 `?token=` 的地址重新导航。 */
    CLEARED_POCKET,
}

/**
 * 「探测完之后做什么」的唯一执行者。
 *
 * 分两层：决策在 [RecoveryPlanner]（纯函数，已有 14 条单测），执行在这里。
 * 这个类只负责三件以前散在 Activity 里、容易写错的事：
 *
 *  1. **顺序**：先判健康再判动手，健康时必须无条件调 `onHealthy()` —— 否则闸门永远
 *     以为还在同一轮故障里，用户下次还得手动重启 App。
 *  2. **闸门记账**：只有真的要动手才 `onActed()`；`ASK_USER` 也算一次动手
 *     （否则每次 onPageFinished 都弹一次 Toast）。
 *  3. **清哪一类 cookie 绝不混淆**：`CLEAR_POCKET_COOKIE` 和 `CLEAR_UPSTREAM_COOKIE`
 *     走不同分支，混一次就把用户锁在验证页外。
 *
 * 真实验证（Redmi 8PCE7LJB99VG7TRO，公网隧道 / 局域网各一次）：
 * ```
 * 1. GET /                                    → 访问验证页（HEAL_PROBE_JS 判 '2'）
 * 2. GET /?token=<PIN>&dsh-pocket-retry=1     ← 本类产出的自愈重连
 * 3. GET /                                    → 200 DeepSeek Harness
 * ```
 */
internal class RecoveryExecutor(
    private val gate: HandshakeHealGate = HandshakeHealGate(),
    private val env: RecoveryEnvironment,
) {

    /** 换连接时清空闸门状态。 */
    fun reset() = gate.reset()

    /**
     * 刚动过手、页面可能还在过渡稿 —— 需要补一次健康确认探测。
     * 不补的话闸门永远收不到「已恢复」，下一次故障会多等一个退避期。
     */
    fun needsHealthyConfirmation(): Boolean = gate.needsHealthyConfirmation()

    /**
     * 是否应该发起一次探测。
     *
     * **有副作用**（`mayProbe()` 会记录探测时间），所以只能在真的打算求值 JS 时调用；
     * 调用方拿到 true 之后必须紧接着求值，中间不能插别的分支。
     */
    fun shouldProbe(currentUrl: String?): Boolean {
        if (currentUrl.isNullOrBlank()) return false
        return gate.mayProbe()
    }

    /**
     * 处理一次探测结果。
     *
     * @param raw `HEAL_PROBE_JS` 的原始返回值（形如 `"0"`，带引号），经
     *   [PageState.fromProbe] 翻译；无法识别一律当 UNKNOWN 处理，即什么都不做。
     * @param currentUrl 探测时那台电脑的入口 URL —— 决策与导航都用它，
     *   保证「判故障用的地址」和「重连用的地址」是同一个。
     */
    fun handleProbeResult(raw: String?, currentUrl: String?): RecoveryOutcome {
        if (currentUrl.isNullOrBlank()) return RecoveryOutcome.SKIPPED

        when (val action = RecoveryPlanner.plan(PageState.fromProbe(raw), currentUrl)) {
            RecoveryAction.NONE -> {
                // 关键：健康就无条件复位。被任何节流挡住都会让下一次故障修不动。
                gate.onHealthy()
                return RecoveryOutcome.HEALTHY
            }

            RecoveryAction.ASK_USER, RecoveryAction.CLEAR_POCKET_COOKIE,
            RecoveryAction.CLEAR_UPSTREAM_COOKIE -> {
                // 故障确认了，但本轮不许再动手：重载后的失败页会再次走到这里，
                // 不拦住就是无限刷新（对 ASK_USER 而言则是不停弹同一句提示）。
                if (!gate.mayAct()) {
                    env.log("page broken($action) but already healed once, waiting for user")
                    return RecoveryOutcome.ALREADY_HEALED
                }
                gate.onActed()

                if (action == RecoveryAction.ASK_USER) {
                    // 地址里没有 token：清掉 pocket cookie 会把用户永久锁在验证页外，
                    // 那个页面没有密码可填。只提示，不动 cookie。
                    env.log("pin page but url has no token, asking user")
                    env.notifyUser("地址里没有 token，请重新扫码或粘贴完整地址")
                    return RecoveryOutcome.ASKED_USER
                }

                val pocket = action == RecoveryAction.CLEAR_POCKET_COOKIE
                if (pocket) {
                    // 残留的失效 dsh_pocket_token 会让 dsh-pocket 拒绝下发新的
                    // （proxy.mjs:509-525 maybeSeedAuthCookie 第一行就 return），
                    // 于是地址里带着 ?token= 也停在「访问验证」页。
                    env.log("pin page with token in url, clearing ${CookieNames.POCKET} and retrying")
                    env.clearPocketCookie(currentUrl)
                } else {
                    env.log("handshake broken, clearing ONLY auth cookies and retrying")
                    env.clearUpstreamCookies(currentUrl)
                }
                val retry = RecoveryPlanner.withRetry(currentUrl) ?: return RecoveryOutcome.ALREADY_HEALED
                env.navigate(retry)
                env.notifyUser("已重新建立与电脑的连接")
                return if (pocket) RecoveryOutcome.CLEARED_POCKET else RecoveryOutcome.CLEARED_UPSTREAM
            }
        }
    }
}
