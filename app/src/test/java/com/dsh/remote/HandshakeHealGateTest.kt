package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 握手自愈闸门的状态机测试。
 *
 * 每条用例都对应真机上踩过的坑，不是为补覆盖率：
 *  - 0L 哨兵值让首次探测被当成节流内 → 装好之后一次自愈都不触发；
 *  - 「一次就永久放弃」→ 第一次没修成，页面卡在 401，用户只能杀 App；
 *  - 「无节制重试」→ 失败页自身反复触发，变成刷新风暴。
 */
class HandshakeHealGateTest {

    /** 可控时钟，让节流与退避边界能被精确断言而不是靠 sleep。 */
    private class FakeClock(var t: Long = 1_000L) : () -> Long {
        override fun invoke(): Long = t
        fun advance(ms: Long) { t += ms }
    }

    private fun gate(clock: FakeClock) = HandshakeHealGate(clock)

    @Test
    fun mayProbe_firstCallAlwaysAllowed_evenWithLateEpochClock() {
        // 时钟不是从 0 起算也能立刻探测 —— 旧实现用 0L 哨兵时这里会失败
        val clock = FakeClock(t = 50_000_000L)
        assertTrue(gate(clock).mayProbe())
    }

    @Test
    fun mayProbe_allowedWhenIdle_notThrottledAway() {
        // 未动过手时探测不受节流：正常页面反复加载都必须能探到「健康」，
        // 否则自愈成功后的那次 onPageFinished 会被节流吃掉，「已恢复」永远记录不下来。
        val clock = FakeClock()
        val g = gate(clock)
        repeat(5) {
            assertTrue("空闲状态下每次都应放行（第 ${it + 1} 次）", g.mayProbe())
            clock.advance(10)
        }
    }

    @Test
    fun mayProbe_quietOnlyAfterActing() {
        val clock = FakeClock()
        val g = gate(clock)

        assertTrue(g.mayProbe())
        // 刚动过手 → 静默期内不许探测
        g.mayAct(); g.onActed()
        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS - 1)
        assertFalse("动手后的静默期内应拒绝探测（页面还是过渡稿）", g.mayProbe())

        clock.advance(1)
        assertTrue("静默期一过必须放行，否则探不到「已恢复」", g.mayProbe())
    }

    @Test
    fun mayProbe_quietDoesNotPersistAfterHealthy() {
        val clock = FakeClock()
        val g = gate(clock)

        g.mayAct(); g.onActed()
        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS)
        assertTrue(g.mayProbe())

        // 页面确认健康 → 故障周期结束，下一次探测不该再被静默期限制
        g.onHealthy()
        g.mayAct(); g.onActed()
        clock.advance(HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS)
        assertTrue(g.mayProbe())
    }

    @Test
    fun mayAct_allowsRetryWithBackoff_withinIncident() {
        val clock = FakeClock()
        val g = gate(clock)

        assertTrue("第一次动手应放行", g.mayAct())
        g.onActed()

        // 刚动手，退避未满 → 不许
        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS - 1)
        assertFalse("退避未满应挡住", g.mayAct())

        // 首次退避 5s 满 → 允许第二次（不能因为第一次没成就永久放弃）
        clock.advance(1)
        assertTrue("首次退避满，应允许重试", g.mayAct())
        g.onActed()

        // 第二次之后退避翻倍到 10s
        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS * 2 - 1)
        assertFalse("第二次的退避是 10s，此时还不该放过", g.mayAct())
        clock.advance(1)
        assertTrue("10s 到，允许第三次", g.mayAct())
        g.onActed()
    }

    @Test
    fun mayAct_capsAtMaxPerIncident() {
        val clock = FakeClock()
        val g = gate(clock)

        var allowed = 0
        repeat(HandshakeHealGate.MAX_ACT_PER_INCIDENT) {
            assertTrue("第 ${it + 1} 次仍在额度内", g.mayAct())
            g.onActed()
            clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        }
        assertEquals(HandshakeHealGate.MAX_ACT_PER_INCIDENT, HandshakeHealGate.MAX_ACT_PER_INCIDENT)

        clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        assertFalse(
            "额度用尽后即便等再久也不能动手——否则失败页会自己触发无限刷新",
            g.mayAct(),
        )
    }

    @Test
    fun onHealthy_resetsIncidentBudget() {
        val clock = FakeClock()
        val g = gate(clock)

        repeat(HandshakeHealGate.MAX_ACT_PER_INCIDENT) {
            g.mayAct()
            g.onActed()
            clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        }
        assertFalse("额度已用尽", g.mayAct())

        // 页面恢复正常 —— DSH 下次重启改端口时还必须能再修
        g.onHealthy()
        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS)
        assertTrue("恢复健康后，下一轮故障要能重新自愈", g.mayAct())
    }

    @Test
    fun backoff_growsThenCaps() {
        val clock = FakeClock()
        val g = gate(clock)

        g.mayAct(); g.onActed()                    // 第 1 次
        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS)
        assertTrue(g.mayAct()); g.onActed()         // 第 2 次：等 5s

        clock.advance(HandshakeHealGate.ACT_DEBOUNCE_MS * 2)
        assertTrue(g.mayAct()); g.onActed()         // 第 3 次：等 10s

        // 放远一点，验证不会无限翻倍
        clock.advance(HandshakeHealGate.MAX_BACKOFF_MS)
        assertFalse("第 4 次超出单轮额度", g.mayAct())
    }

    @Test
    fun reset_clearsEverything() {
        val clock = FakeClock()
        val g = gate(clock)

        g.mayProbe()
        g.mayAct()
        g.onActed()

        g.reset()
        assertTrue("reset 后探测应立即可用", g.mayProbe())
        assertTrue("reset 后动手应立即可用", g.mayAct())
    }

    @Test
    fun probeDoesNotConsumeActBudget() {
        val clock = FakeClock()
        val g = gate(clock)

        // 真实序列：正常页面被探测多次（返回 0、不动手），随后真的坏了
        repeat(3) { g.mayProbe() }
        assertTrue(
            "多次探测不能消耗动手额度——旧实现 allow() 在探测前改时间戳正是这个缺陷",
            g.mayAct(),
        )
    }
}
