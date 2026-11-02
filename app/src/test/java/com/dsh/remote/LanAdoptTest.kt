package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    /** 要 PIN 的一台电脑。 */
    private fun locked(host: String) = LanHit(host = host, open = false)

    /** 免 PIN 的一台电脑（电脑端关掉了「局域网访问密码」）。 */
    private fun open(host: String) = LanHit(host = host, open = true)

    @Test
    fun plan_noneWhenNothingFound() {
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186"))
        assertEquals(LanAdoptPlan.None, LanAdopt.plan(saved, emptyList()))
    }

    @Test
    fun plan_noneWhenFoundHostsAreBlank() {
        // 扫描器不应产出空串，但真产出了也不能当成一台电脑
        assertEquals(LanAdoptPlan.None, LanAdopt.plan(emptyList(), listOf(locked(""), locked("  "))))
    }

    @Test
    fun plan_adoptsExactHostMatch() {
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        // 必须原样沿用已保存的那条（PIN、端口都在里面）
        assertEquals(saved[0], (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_exactMatchIgnoresCase() {
        val saved = listOf(ep("http://PC.Local:3081/?token=12345678", "pc"))
        val plan = LanAdopt.plan(saved, listOf(locked("pc.local")))
        assertTrue(plan is LanAdoptPlan.Adopt)
    }

    @Test
    fun plan_rebindsPinWhenComputerMovedToNewIp() {
        // 电脑换了 DHCP 地址（PIN 不变），只有它一台在答话
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.77")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals("http://192.168.50.77:3081/?token=60111186", (plan as LanAdoptPlan.Adopt).endpoint.url)
    }

    @Test
    fun plan_doesNotRebindWhenMultipleComputersAnswer() {
        // 两台都在 3081 答话，手机侧无法区分哪台是自己的 —— 搬 PIN 风险太大
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.77"), locked("192.168.50.78")))
        assertTrue(plan is LanAdoptPlan.AskPin)
    }

    @Test
    fun plan_exactMatchStillWinsWhenOthersAlsoAnswer() {
        // 其中一台就是自己认识的那台：即便旁边还有别的机器，也要直连自己那台
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.77"), locked("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals(saved[0], (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_asksForPinWhenNothingSaved() {
        val plan = LanAdopt.plan(emptyList(), listOf(locked("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.AskPin)
        val ask = plan as LanAdoptPlan.AskPin
        assertEquals("http://192.168.50.58:3081/", ask.url)
        assertEquals("192.168.50.58", ask.label)
    }

    @Test
    fun plan_asksForPinWhenSavedEntryHasNoPin() {
        // 存着一条没有 token 的档案（比如用户手输过裸地址），不能凭空造 PIN
        val saved = listOf(ep("http://192.168.50.58:3081/", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.9")))
        assertTrue(plan is LanAdoptPlan.AskPin)
    }

    @Test
    fun plan_prefersRecentlyUsedSavedEntry() {
        // 调用方按最近使用排序，这里验证「第一个能用的就用」而不是随便挑
        val newer = ep("http://192.168.50.58:3081/?token=aaaaaaaa", "192.168.50.58")
        val older = ep("http://192.168.50.58:3081/?token=bbbbbbbb", "192.168.50.58")
        val plan = LanAdopt.plan(listOf(newer, older), listOf(locked("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals(newer, (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_deduplicatesFoundHosts() {
        // 同一台机器被扫到两次也只算一台，否则会误判成「多台答话」而不搬 PIN
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(locked("192.168.50.77"), locked("192.168.50.77")))
        assertTrue(plan is LanAdoptPlan.Adopt)
    }

    // ---------------------------------------------------------------- 免 PIN 分支
    //
    // 这一组是「从 GitHub 装完直接进主界面」的核心：电脑端关掉「局域网访问密码」后，
    // 服务器裸请求就下发 dsh-auth-… 凭据，手机不该再问用户要 PIN。

    @Test
    fun plan_adoptsOpenComputerWithoutAnySavedEntry() {
        // 全新安装、手机里一条档案都没有，但扫到的那台电脑免 PIN → 直接连
        val plan = LanAdopt.plan(emptyList(), listOf(open("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        val url = (plan as LanAdoptPlan.Adopt).endpoint.url
        assertEquals("http://192.168.50.58:3081/", url)
        // 免 PIN 地址里不能出现 token（那会是编出来的假凭据）
        assertFalse(url.contains("token="))
    }

    @Test
    fun plan_openComputerGetsLanKindBadge() {
        // 免 PIN 的局域网地址必须被判成 LAN，否则列表页会标成「公网」
        val plan = LanAdopt.plan(emptyList(), listOf(open("192.168.50.58")))
        val endpoint = (plan as LanAdoptPlan.Adopt).endpoint
        assertEquals(Endpoint.Kind.LAN, endpoint.kind)
        assertEquals("192.168.50.58", endpoint.label)
    }

    @Test
    fun plan_openComputerWinsOverRebindingSavedPin() {
        // 存着一条别处的旧档案，而扫到的这台免 PIN：
        // 免 PIN 是更强的信号（不需要任何凭据就能进），优先于搬旧 PIN
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(open("192.168.50.99")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals("http://192.168.50.99:3081/", (plan as LanAdoptPlan.Adopt).endpoint.url)
    }

    @Test
    fun plan_exactHostMatchStillWinsOverOpenFlag() {
        // 同一台电脑、手机里已经有带 PIN 的档案：沿用它，不要因为现在免 PIN 就换档案
        val saved = listOf(ep("http://192.168.50.58:3081/?token=60111186", "192.168.50.58"))
        val plan = LanAdopt.plan(saved, listOf(open("192.168.50.58")))
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals(saved[0], (plan as LanAdoptPlan.Adopt).endpoint)
    }

    @Test
    fun plan_doesNotGuessWhenTwoOpenComputersAnswer() {
        // 两台都免 PIN：不知道用户想进哪台，宁可让用户选（落到 AskPin 展示第一台）
        val plan = LanAdopt.plan(emptyList(), listOf(open("192.168.50.58"), open("192.168.50.77")))
        assertTrue(plan is LanAdoptPlan.AskPin)
    }

    @Test
    fun plan_openAndLockedMixedPrefersTheOpenOne() {
        // 一台免 PIN、一台要 PIN：免 PIN 那台能进，就进它
        val plan = LanAdopt.plan(
            emptyList(),
            listOf(locked("192.168.50.58"), open("192.168.50.77")),
        )
        assertTrue(plan is LanAdoptPlan.Adopt)
        assertEquals("http://192.168.50.77:3081/", (plan as LanAdoptPlan.Adopt).endpoint.url)
    }

    @Test
    fun plan_reportsOpenComputerInChattyForm() {
        // 待连接的免 PIN 地址不能带 token —— 否则 WebView 会去验证一个不存在的凭据
        val plan = LanAdopt.plan(emptyList(), listOf(open("192.168.50.58")))
        val endpoint = (plan as LanAdoptPlan.Adopt).endpoint
        assertEquals(null, LanScan.tokenOf(endpoint.url))
        assertTrue(endpoint.url.startsWith("http://"))
    }
}
