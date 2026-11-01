package com.dsh.remote

/**
 * 握手自愈的闸门：决定「要不要探测」和「能不能动手」。
 *
 * 背景：dsh web 每次重启都会改端口（实测 54282 → 17169）。WebView 里那条 `dsh-auth-*`
 * cookie 带着旧端口，而 dsh-pocket 一旦看到请求带 cookie 就**不再**补 launch token
 * （proxy.mjs:606）—— 于是上游稳定 401，页面只剩 "dsh web authentication required"。
 * 用户侧表现就是「App 打开白屏 / 进不去」，重装、换网络都没用。
 *
 * 自愈动作是「只清 dsh-auth-* + 带 dsh-pocket-retry=1 重载」。它代价不小（会打断页面、
 * 丢掉当前会话状态），所以要节制，但**绝不能只试一次**：
 *
 *  - 探测（mayProbe）：便宜，但要节流。页面加载期 onPageFinished / onReceivedTitle
 *    会连打好几次，每次都求值 JS 没必要。
 *  - 动手（mayAct）：同一故障周期内允许 MAY_ACT_INCIDENT 次，之间间隔逐次拉长
 *    （退避）。为什么不能「一次就永久放弃」：第一次动手可能刚好赶上 cookie 还没落盘、
 *    或者重载时又带上了旧 cookie，一次没成并不代表这条路不通 —— 真机上就复现过
 *    「第一次动手后页面仍停在 401，然后彻底不再重试」。用户能做的只有杀掉 App，
 *    等于自愈白写了。
 *  - 恢复（onHealthy）：页面一旦正常就完全解锁，下次 DSH 重启又坏时还能自动修。
 *
 * 时钟通过构造参数注入，纯 JVM 单测才能确定性地断言节流与退避边界。
 */
internal class HandshakeHealGate(
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    /**
     * 「是否发生过」用显式标志，不能用 0L 当哨兵值。
     * 早期版本拿 lastProbeAt = 0L 表示「从未探测」，只要时钟现值小于 PROBE_INTERVAL_MS
     * 就会把首次探测判成节流内 —— 表现是「装好之后一次自愈都不触发」。
     */
    private var probed = false
    private var lastProbeAt = 0L

    /** 本次故障周期内已动手次数。页面恢复健康（onHealthy）或换连接（reset）时归零。 */
    private var actsInIncident = 0
    private var lastActAt = 0L
    private var actedEver = false

    /**
     * 探测许可。
     *
     * 节流规则刻意做得很窄：只有在「刚动过手、页面很可能还在过渡稿」的窗口里才拒绝探测，
     * 其余时候一律放行。为什么不能粗粒度节流：
     * 自愈成功后的那次 onPageFinished 若刚好落在节流窗口里，就探不到「页面已正常」，
     * onHealthy 永远不会被调用，闸门停在「本故障周期已动手 1 次」，
     * 下一次故障便要多等一个退避期才肯再动手 —— 真机上表现为「第一、三次能修，第二次修不动」。
     * 探测只是一次 JS 求值，多探几次的成本远小于漏判。
     */
    fun mayProbe(): Boolean {
        val t = now()
        if (actedEver && actsInIncident > 0 && t - lastActAt < PROBE_QUIET_AFTER_ACT_MS) {
            return false
        }
        probed = true
        lastProbeAt = t
        return true
    }

    /**
     * 页面已确认健康：结束当前故障周期。
     *
     * 这是「下一次还能自动修」的唯一开关。调用方应在探测返回健康时无条件调用，
     * 不要被任何节流挡住 —— 见 mayProbe 的注释。
     */
    fun onHealthy() {
        actsInIncident = 0
    }

    /** 动手许可：本故障周期次数未用尽，且距上次动手已过对应退避时间。 */
    fun mayAct(): Boolean {
        if (actsInIncident >= MAX_ACT_PER_INCIDENT) return false
        if (!actedEver) return true
        return now() - lastActAt >= backoffFor(actsInIncident)
    }

    /** 记录一次动手。 */
    fun onActed() {
        actsInIncident += 1
        actedEver = true
        lastActAt = now()
    }

    /**
     * 是否需要补一次「健康确认」探测。
     *
     * 场景：刚动过手，页面还在过渡稿，这次 onPageFinished 里的探测被静默期挡掉。
     * 若就此收工，闸门永远不知道页面后来恢复了，actsInIncident 不复位，
     * 下一次故障就得多等一个退避期 —— 用户看到的是「有时能修、有时修不动」。
     */
    fun needsHealthyConfirmation(): Boolean = actedEver && actsInIncident > 0

    /** 切换到新的连接时重置全部状态。 */
    fun reset() {
        probed = false
        lastProbeAt = 0L
        actsInIncident = 0
        lastActAt = 0L
        actedEver = false
    }

    /** 第 n 次动手之后要等的退避时间：首次 5s，之后翻倍，封顶 30s。 */
    private fun backoffFor(actsDone: Int): Long {
        val base = ACT_DEBOUNCE_MS
        val multiplied = base shl (actsDone - 1).coerceAtLeast(0)
        return multiplied.coerceAtMost(MAX_BACKOFF_MS)
    }

    companion object {
        /**
         * 动手后的探测静默期。实测自愈后约 0.7~1.6 秒进主界面，取 1200ms：
         * 足够躲开「正在进入」过渡稿，又不会太晚而错过「已恢复」的判定
         * （早期取 2000ms 时，1378ms 才进主界面，正好被挡住，导致下一次故障修不动）。
         */
        const val PROBE_QUIET_AFTER_ACT_MS = 1_200L

        /** 首次动手后的静默期：给重载与握手留时间，别把过渡页当成又一次故障。 */
        const val ACT_DEBOUNCE_MS = 5_000L

        /** 单次退避的上限。 */
        const val MAX_BACKOFF_MS = 30_000L

        /**
         * 一个故障周期最多自动动手几次。
         * 取 3 而不是 1：一次没成的原因很多（cookie 尚未落盘、重载又带旧值），
         * 直接放弃会把用户逼到「只能手动杀 App」；取 3 也远不足以造成刷新风暴。
         */
        const val MAX_ACT_PER_INCIDENT = 3
    }
}
