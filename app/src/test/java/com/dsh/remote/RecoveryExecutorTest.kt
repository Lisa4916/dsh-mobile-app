package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 自愈编排的测试。
 *
 * 这里的每条用例都对应一个**会伤害用户的错误**，不是为覆盖率：
 *  - 把 `dsh_pocket_token` 在 URL 没 token 时清掉 → 用户被永久锁在「访问验证」页外；
 *  - 把 `dsh-auth-*` 和 pocket cookie 清反 → 要么白屏，要么回到验证页；
 *  - 页面健康时不复位闸门 → 下一次故障修不动，用户只能杀 App；
 *  - 无限重试 → 失败页自己触发刷新风暴。
 *
 * 以前这些判断嵌在 `WebView.evaluateJavascript` 的回调里，只能上真机看页面表现才能验证；
 * 现在它是返回值，可以直接断言。
 */
class RecoveryExecutorTest {

    /** 可控时钟：让退避与静默期边界可以被精确断言，而不是靠 sleep。 */
    private class FakeClock(var t: Long = 1_000L) : () -> Long {
        override fun invoke(): Long = t
        fun advance(ms: Long) { t += ms }
    }

    /** 记录所有副作用，用来断言「到底碰了什么」。 */
    private class FakeEnv : RecoveryEnvironment {
        val clearedUpstream = mutableListOf<String>()
        val clearedPocket = mutableListOf<String>()
        val navigations = mutableListOf<String>()
        val notifications = mutableListOf<String>()
        val logs = mutableListOf<String>()

        override fun clearUpstreamCookies(url: String) { clearedUpstream += url }
        override fun clearPocketCookie(url: String) { clearedPocket += url }
        override fun navigate(url: String) { navigations += url }
        override fun notifyUser(message: String) { notifications += message }
        override fun log(message: String) { logs += message }

        /** 除日志外的所有副作用次数 —— 用来断言「什么都没做」。 */
        fun sideEffectCount(): Int =
            clearedUpstream.size + clearedPocket.size + navigations.size + notifications.size
    }

    private fun executor(clock: FakeClock, env: FakeEnv) =
        RecoveryExecutor(gate = HandshakeHealGate(clock), env = env)

    // 真实入口：局域网带 token；公网隧道同样带 token
    private val urlWithToken = "http://192.168.1.9:3081/?token=12345678"
    private val urlWithoutToken = "http://192.168.1.9:3081/"

    // ------------------------------------------------------------ 正常路径

    @Test
    fun healthyPage_doesNothing_andLeavesGateUnlocked() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        // 先制造一次「已动手」，再让页面恢复健康：这一步是闸门复位的唯一开关
        assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))
        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS)
        val before = env.sideEffectCount()

        assertEquals(RecoveryOutcome.HEALTHY, ex.handleProbeResult("0", urlWithToken))
        assertEquals("健康时不该有任何副作用", before, env.sideEffectCount())
        assertFalse(
            "页面健康后必须复位闸门，否则下一次故障会因额度用尽而修不动",
            ex.needsHealthyConfirmation(),
        )
    }

    @Test
    fun unknownProbe_isTreatedAsHealthy_andTouchesNothing() {
        val env = FakeEnv()
        val ex = executor(FakeClock(), env)

        // 没法识别的返回值（null、空串、意外的数字）一律不动手
        assertEquals(RecoveryOutcome.HEALTHY, ex.handleProbeResult(null, urlWithToken))
        assertEquals(RecoveryOutcome.HEALTHY, ex.handleProbeResult("", urlWithToken))
        assertEquals(RecoveryOutcome.HEALTHY, ex.handleProbeResult("\"7\"", urlWithToken))
        assertEquals(0, env.sideEffectCount())
    }

    @Test
    fun blankUrl_isSkipped() {
        val env = FakeEnv()
        val ex = executor(FakeClock(), env)

        assertEquals(RecoveryOutcome.SKIPPED, ex.handleProbeResult("2", null))
        assertEquals(RecoveryOutcome.SKIPPED, ex.handleProbeResult("2", "   "))
        assertEquals(0, env.sideEffectCount())
    }

    // --------------------------------------------------- PIN 页：两类分支

    @Test
    fun pinPageWithToken_clearsPocketCookie_andRetriesWithToken() {
        val env = FakeEnv()
        val ex = executor(FakeClock(), env)

        assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))

        assertEquals("必须清的是 pocket cookie（残留的失效值会挡住新 cookie）",
            listOf(urlWithToken), env.clearedPocket)
        assertTrue("绝不能在清 pocket 的同时去清上游 cookie", env.clearedUpstream.isEmpty())
        assertEquals(1, env.navigations.size)
        val retry = env.navigations.single()
        assertTrue("重连地址必须保住 ?token=", retry.contains("token=12345678"))
        assertTrue("必须带上 dsh-pocket-retry=1 清掉握手失败计数", retry.contains("dsh-pocket-retry=1"))
        assertEquals(listOf("已重新建立与电脑的连接"), env.notifications)
    }

    @Test
    fun pinPageWithoutToken_asksUser_andTouchesNoCookie() {
        val env = FakeEnv()
        val ex = executor(FakeClock(), env)

        assertEquals(RecoveryOutcome.ASKED_USER, ex.handleProbeResult("2", urlWithoutToken))

        assertTrue("URL 没有 token 时清 pocket cookie 会把用户永久锁在验证页外",
            env.clearedPocket.isEmpty())
        assertTrue("也不该去清上游 cookie —— 这不是 401 故障", env.clearedUpstream.isEmpty())
        assertTrue("更不能导航", env.navigations.isEmpty())
        assertEquals(1, env.notifications.size)
        assertTrue("提示要告诉用户怎么办", env.notifications.single().contains("token"))
    }

    @Test
    fun askUser_countsAsAnAct_soToastDoesNotRepeatOnEveryLoad() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        ex.handleProbeResult("2", urlWithoutToken)
        assertEquals(1, env.notifications.size)

        // 同一轮故障里页面反复回调：不该每次都弹一次 Toast
        clock.advance(1)
        assertEquals(RecoveryOutcome.ALREADY_HEALED, ex.handleProbeResult("2", urlWithoutToken))
        assertEquals("提示只弹一次", 1, env.notifications.size)
    }

    // --------------------------------------------------- 上游 401 分支

    @Test
    fun handshakeBroken_clearsUpstreamCookiesOnly() {
        val env = FakeEnv()
        val ex = executor(FakeClock(), env)

        assertEquals(RecoveryOutcome.CLEARED_UPSTREAM, ex.handleProbeResult("1", urlWithToken))

        assertEquals(listOf(urlWithToken), env.clearedUpstream)
        assertTrue("401 故障不该动 pocket cookie —— 清了就回到验证页", env.clearedPocket.isEmpty())
        assertTrue(env.navigations.single().contains("dsh-pocket-retry=1"))
    }

    // ------------------------------------------------------- 闸门与节流

    @Test
    fun afterActing_backoffBlocksImmediateSecondAct() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))
        val actsAfterFirst = env.navigations.size

        // 退避未满 → 不许再动手（否则就是刷新风暴）
        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS - 1)
        assertEquals(RecoveryOutcome.ALREADY_HEALED, ex.handleProbeResult("2", urlWithToken))
        assertEquals("退避期内不许再导航", actsAfterFirst, env.navigations.size)

        // 退避期满 → 允许第二次重试（一次没成不代表这条路不通）
        clock.advance(1)
        assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))
        assertEquals(actsAfterFirst + 1, env.navigations.size)
    }

    @Test
    fun actBudget_isCappedPerIncident() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        repeat(HandshakeHealGate.MAX_ACT_PER_INCIDENT) {
            assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))
            clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        }
        assertEquals(HandshakeHealGate.MAX_ACT_PER_INCIDENT, env.navigations.size)

        // 额度用尽后等再久也不动手
        clock.advance(HandshakeHealGate.MAX_BACKOFF_MS * 10)
        assertEquals(RecoveryOutcome.ALREADY_HEALED, ex.handleProbeResult("2", urlWithToken))
        assertEquals("额度用尽后不能再导航", HandshakeHealGate.MAX_ACT_PER_INCIDENT, env.navigations.size)
    }

    @Test
    fun shouldProbe_rejectsBlankUrl_andRespectsQuietWindow() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        assertFalse("没有当前连接就不该求值 JS", ex.shouldProbe(null))
        assertFalse(ex.shouldProbe("  "))
        assertTrue(ex.shouldProbe(urlWithToken))

        ex.handleProbeResult("2", urlWithToken)
        assertFalse("刚动过手的静默期内不该再探（页面还是过渡稿）",
            ex.shouldProbe(urlWithToken))

        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS)
        assertTrue("静默期一过必须能探，否则永远收不到「已恢复」", ex.shouldProbe(urlWithToken))
    }

    @Test
    fun reset_clearsGateSoNewConnectionGetsFreshBudget() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        repeat(HandshakeHealGate.MAX_ACT_PER_INCIDENT) {
            ex.handleProbeResult("2", urlWithToken)
            clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        }
        assertEquals(RecoveryOutcome.ALREADY_HEALED, ex.handleProbeResult("2", urlWithToken))

        // 换一台电脑：额度必须重新给
        ex.reset()
        assertEquals(RecoveryOutcome.CLEARED_POCKET, ex.handleProbeResult("2", urlWithToken))
    }

    @Test
    fun needsHealthyConfirmation_tracksIncidentState() {
        val env = FakeEnv()
        val clock = FakeClock()
        val ex = executor(clock, env)

        assertFalse("还没动过手，不需要确认", ex.needsHealthyConfirmation())
        ex.handleProbeResult("2", urlWithToken)
        assertTrue("动过手就得补一次健康确认，否则闸门停在故障周期里",
            ex.needsHealthyConfirmation())
        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS)
        ex.handleProbeResult("0", urlWithToken)
        assertFalse(ex.needsHealthyConfirmation())
    }
}
