package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「扫到电脑之后怎么办」的决策。
 *
 * 这套判断错了用户看到的现象是「明明扫到了却又要输密码」或者「连上了别人家的机器」，
 * 两种在真机上都不好复现（要多台设备、要手工改 DHCP）。所以全部压成纯函数钉在这里。
 */
class LanAdoptTest {

    private fun ep(url: String, label: String = "pc") =
        Endpoint(id = EndpointStore.idFor(label, url), label = label, url = url)

    @Test
    fun plan_noneWhenNothingFound() {
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186"))
        assertEquals(LanAdoptPlan.None, LanAdopt.plan(saved, emptyList()))
    }

    @Test
    fun plan_noneWhenFoundHostsAreBlank() {
        // 扫描器不应产出空串，但真产出了也不能当成一台电脑
        assertEquals(LanAdoptPlan.None, LanAdopt.plan(emptyList(), listOf("", "  ")))
    }

    @Test
    fun plan_adoptsExactHostMatch() {
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.58"))
        assertTrue(plan is LanAdoptPlan.Adopt)
        // 必须原样沿用已保存的那条（PIN、端口都在里面）
        assertEquals(saved[0], (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_exactMatchIgnoresCase() {
        val saved = listOf(ep("http://PC.Local:3081/?token=12345678", "pc"))
        val plan = LanAdopt.plan(saved, listOf("pc.local"))
        assertTrue(plan is LanAdoptPlan.Adopt)
    }

    @Test
    fun plan_rebindsPinWhenComputerMovedToNewIp() {
        // 电脑换了 DHCP 地址（PIN 不变），只有它一台在答话
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.77"))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals("http://192.168.50.77:3081/?token=60111186", (plan as LanAdoptPlan.Adopt).endpoint.url)
    }

    @Test
    fun plan_doesNotRebindWhenMultipleComputersAnswer() {
        // 两台都在 3081 答话，手机侧无法区分哪台是自己的 —— 搬 PIN 风险太大
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.77", "192.168.50.78"))
        assertTrue(plan is LanAdoptPlan.AskPin)
    }

    @Test
    fun plan_exactMatchStillWinsWhenOthersAlsoAnswer() {
        // 其中一台就是自己认识的那台：即便旁边还有别的机器，也要直连自己那台
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.77", "192.168.50.58"))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals(saved[0], (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_asksForPinWhenNothingSaved() {
        val plan = LanAdopt.plan(emptyList(), listOf("192.168.50.58"))
        assertTrue(plan is LanAdoptPlan.AskPin)
        val ask = plan as LanAdoptPlan.AskPin
        assertEquals("http://192.168.50.58:3081/", ask.url)
        assertEquals("192.168.50.58", ask.label)
    }

    @Test
    fun plan_asksForPinWhenSavedEntryHasNoPin() {
        // 存着一条没有 token 的档案（比如用户手输过裸地址），不能凭空造 PIN
        val saved = listOf(ep("http://192.168.50.58:3081/", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.9"))
        assertTrue(plan is LanAdoptPlan.AskPin)
    }

    @Test
    fun plan_prefersRecentlyUsedSavedEntry() {
        // 调用方按最近使用排序，这里验证「第一个能用的就用」而不是随便挑
        val newer = ep("http://192.168.50.58:3081/?token=aaaaaaaa", "192.168.50.58")
        val older = ep("http://192.168.50.58:3081/?token=bbbbbbbb", "192.168.50.58")
        val plan = LanAdopt.plan(listOf(newer, older), listOf("192.168.50.58"))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals(newer, (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_deduplicatesFoundHosts() {
        // 同一台机器被扫到两次也只算一台，否则会误判成「多台答话」而不搬 PIN
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf("192.168.50.77", "192.168.50.77"))
        assertTrue(plan is LanAdoptPlan.Adopt)
    }
}
