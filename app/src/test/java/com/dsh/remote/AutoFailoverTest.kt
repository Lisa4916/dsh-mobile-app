package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * [AutoFailover] 的选取测试。
 *
 * 这些用例对应的都是真机上的档案形状：一台电脑在局域网与公网各存一条，
 * 在家用局域网、出门用公网。核心断言是「**换一种网络**优先」——
 * 试同类型的下一条只会用同样的理由再失败一次。
 */
class AutoFailoverTest {

    private fun lan(lastUsedAt: Long = 1L) = Endpoint(
        id = "lan",
        label = "192.168.50.58",
        url = "http://192.168.50.58:3081/?token=12345678",
        lastUsedAt = lastUsedAt,
    )

    private fun pub(lastUsedAt: Long = 1L) = Endpoint(
        id = "pub",
        label = "公网隧道",
        url = "https://abc-xyz.trycloudflare.com/?token=87654321",
        lastUsedAt = lastUsedAt,
    )

    @Test
    fun next_prefersPublicWhenLanJustFailed() {
        // 出门场景：局域网失败 → 立刻换公网。
        val next = AutoFailover.next(listOf(lan(), pub()), lan(), setOf("lan"))
        assertEquals("pub", next?.id)
    }

    @Test
    fun next_prefersLanWhenPublicJustFailed() {
        // 回家了但上次用的是公网（更慢）→ 失败后换局域网。
        val next = AutoFailover.next(listOf(lan(), pub()), pub(), setOf("pub"))
        assertEquals("lan", next?.id)
    }

    @Test
    fun next_switchKindBeatsRecency() {
        // 两条公网都比我这条局域网「更新」，但换网络优先于换新旧。
        val olderPub = pub(lastUsedAt = 100L)
        val newerLan = lan(lastUsedAt = 999L)
        val current = lan(lastUsedAt = 500L)
        val next = AutoFailover.next(
            listOf(olderPub, newerLan, current),
            current,
            setOf(current.id),
        )
        assertEquals("pub", next?.id)
    }

    @Test
    fun next_fallsBackToSameKindWhenNoOtherKindLeft() {
        // 只有一个公网的「另一条」时，同网络类型也是唯一可试的。
        val pub1 = pub(lastUsedAt = 5L)
        val pub2 = Endpoint(
            id = "pub2",
            label = "公网隧道",
            url = "https://second-name.trycloudflare.com/?token=87654321",
            lastUsedAt = 9L,
        )
        val next = AutoFailover.next(listOf(pub1, pub2), pub1, setOf("pub"))
        assertEquals("pub2", next?.id)
    }

    @Test
    fun next_neverReturnsSomethingAlreadyTried() {
        // 两条都试过了就不再兜圈，交给列表页。
        val next = AutoFailover.next(listOf(lan(), pub()), lan(), setOf("lan", "pub"))
        assertNull(next)
    }

    @Test
    fun next_returnsNullWhenNothingSaved() {
        assertNull(AutoFailover.next(emptyList(), lan(), setOf("lan")))
    }

    @Test
    fun next_worksWithoutCurrent() {
        // 启动时没有任何「正在连的」也能选出最该试的那条：按最近使用。
        val a = lan(lastUsedAt = 10L)
        val b = pub(lastUsedAt = 99L)
        val next = AutoFailover.next(listOf(a, b), null, emptySet())
        assertEquals("pub", next?.id)
    }

    @Test
    fun next_singleEntryThatIsAlreadyTriedGivesNull() {
        // 边界：只有一条且它就是刚失败那条 —— 别自己连自己。
        assertNull(AutoFailover.next(listOf(lan()), lan(), setOf("lan")))
    }

    // ---- pickStart：冷启动先连哪条 ----

    @Test
    fun pickStart_keepsLanWhenWifiIsOn() {
        // 在家有 Wi-Fi：局域网最近，就是最好的选择，不要动。
        val l = lan(lastUsedAt = 5L)
        assertEquals(l.id, AutoFailover.pickStart(listOf(l, pub()), l, onLan = true)?.id)
    }

    @Test
    fun pickStart_switchesToPublicWhenOnlyMobileData() {
        // 出门只插流量：局域网必然不通，直接换公网，别白等 8 秒。
        val l = lan(lastUsedAt = 99L) // 局域网反而是最近用的那条
        val p = pub(lastUsedAt = 1L)
        assertEquals(p.id, AutoFailover.pickStart(listOf(l, p), l, onLan = false)?.id)
    }

    @Test
    fun pickStart_keepsPublicWhenNoWifi() {
        val l = lan()
        val p = pub()
        assertEquals(p.id, AutoFailover.pickStart(listOf(l, p), p, onLan = false)?.id)
    }

    @Test
    fun pickStart_returnsLanWhenNoPublicExists() {
        // 没公网可选时仍然返回局域网 —— 让它失败并由守望给明确的话，
        // 比无声停在列表页让用户猜好。
        val l = lan()
        assertEquals(l.id, AutoFailover.pickStart(listOf(l), l, onLan = false)?.id)
    }

    @Test
    fun pickStart_picksMostRecentPublic() {
        val oldPub = pub(lastUsedAt = 1L)
        val newPub = Endpoint(
            id = "pub2",
            label = "公网隧道",
            url = "https://second-name.trycloudflare.com/?token=87654321",
            lastUsedAt = 50L,
        )
        val l = lan(lastUsedAt = 100L)
        val picked = AutoFailover.pickStart(listOf(l, oldPub, newPub), l, onLan = false)
        assertEquals("pub2", picked?.id)
    }

    @Test
    fun pickStart_returnsNullWithoutAnySavedEntry() {
        assertNull(AutoFailover.pickStart(emptyList(), null, onLan = false))
    }
}
