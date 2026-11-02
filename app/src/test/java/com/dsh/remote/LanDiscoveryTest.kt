package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 局域网自动发现里「不需要开 Socket 就能判错」的那部分。
 *
 * 为什么值得单测：[LanScan.candidates] 算错一个数就会去扫别人的网段（发到外网的
 * 254 个 SYN，用户看到的是「打开 App 就卡」）；[LanScan.tokenOf] 判错就拼不出能连的地址；
 * [LanScan.rebind] 判错会把用户导向一台不存在的电脑。这三件事在真机上都不好观察。
 */
class LanDiscoveryTest {

    // ---------- candidates ----------

    @Test
    fun candidates_expandsSlash24AndSkipsSelf() {
        val list = LanScan.candidates("192.168.50.58")
        assertEquals(253, list.size)
        assertTrue(list.contains("192.168.50.1"))
        assertTrue(list.contains("192.168.50.254"))
        assertFalse("必须排除本机地址，扫自己没有意义", list.contains("192.168.50.58"))
        assertEquals("192.168.50.1", list.first())
        assertEquals("192.168.50.254", list.last())
    }

    @Test
    fun candidates_neverLeavesTheSlash24() {
        // 若按真实掩码展开，/16 会是 65,534 个地址 —— 手机上要跑几分钟。
        val list = LanScan.candidates("192.168.50.58")
        assertTrue(list.all { it.startsWith("192.168.50.") })
        assertEquals(253, list.distinct().size)
    }

    @Test
    fun candidates_handlesOtherPrivateRanges() {
        val list = LanScan.candidates("10.0.3.7")
        assertEquals("10.0.3.1", list.first())
        assertEquals("10.0.3.254", list.last())
        assertFalse(list.contains("10.0.3.7"))
    }

    @Test
    fun candidates_rejectsLoopback() {
        // 127/8 是手机自己，扫它只会找到本机
        assertTrue(LanScan.candidates("127.0.0.1").isEmpty())
    }

    @Test
    fun candidates_rejectsReservedAndMulticast() {
        assertTrue(LanScan.candidates("0.0.0.0").isEmpty())
        assertTrue(">=224 是组播/保留段", LanScan.candidates("224.0.0.1").isEmpty())
        assertTrue(LanScan.candidates("255.255.255.255").isEmpty())
    }

    @Test
    fun candidates_rejectsGarbage() {
        assertTrue(LanScan.candidates(null).isEmpty())
        assertTrue(LanScan.candidates("").isEmpty())
        assertTrue(LanScan.candidates("192.168.50").isEmpty())
        assertTrue(LanScan.candidates("192.168.50.1.1").isEmpty())
        assertTrue(LanScan.candidates("192.168.50.abc").isEmpty())
        assertTrue(LanScan.candidates("192.168.50.300").isEmpty())
        assertTrue(LanScan.candidates("fe80::1").isEmpty())
    }

    @Test
    fun candidates_handlesEdgeHostOctets() {
        assertEquals("192.168.50.2", LanScan.candidates("192.168.50.1").first())
        // 自己就是 .254 时，最后一个候选应该退到 .253
        assertEquals("192.168.50.253", LanScan.candidates("192.168.50.254").last())
        assertEquals(253, LanScan.candidates("192.168.50.254").size)
    }

    // ---------- looksLikePocket ----------

    @Test
    fun looksLikePocket_matchesPinPageAndMainPage() {
        assertTrue(LanScan.looksLikePocket("<title>DSH Pocket · 访问验证</title>"))
        assertTrue(LanScan.looksLikePocket("<title>DSH Pocket · 正在进入 | opening…</title>"))
        assertTrue(LanScan.looksLikePocket("<title>DeepSeek Harness</title>"))
    }

    @Test
    fun looksLikePocket_rejectsOtherServices() {
        assertFalse(LanScan.looksLikePocket("<title>nginx</title>"))
        assertFalse(LanScan.looksLikePocket("{\"status\":\"ok\"}"))
        // 只是同端口的路由器管理页，不该被当成电脑
        assertFalse(LanScan.looksLikePocket("<title>TP-LINK 路由器设置</title>"))
    }

    @Test
    fun looksLikePocket_handlesNullAndEmpty() {
        assertFalse(LanScan.looksLikePocket(null))
        assertFalse(LanScan.looksLikePocket(""))
    }

    @Test
    fun looksLikePocket_doesNotDependOnLength() {
        // 同一个访问验证页实测出现过 4210 与 3969 两种长度，长度不能当指纹。
        val shortPage = "<title>DSH Pocket · 访问验证</title>"
        val padded = shortPage + " ".repeat(10_000)
        assertTrue(LanScan.looksLikePocket(shortPage))
        assertTrue(LanScan.looksLikePocket(padded))
    }

    // ---------- tokenOf ----------

    @Test
    fun tokenOf_readsTokenFromQuery() {
        assertEquals("60111186", LanScan.tokenOf("http://192.168.50.58:3081/?token=60111186"))
        assertEquals("abc", LanScan.tokenOf("http://h/?token=abc"))
        assertEquals("abc", LanScan.tokenOf("http://h/?a=1&token=abc&b=2"))
    }

    @Test
    fun tokenOf_ignoresFragmentOnlyToken() {
        // `#?token=` 是 fragment，服务端根本收不到，不能当成可用凭据
        assertNull(LanScan.tokenOf("http://h/#?token=12345678"))
        assertNull(LanScan.tokenOf("http://h/#token=12345678"))
    }

    @Test
    fun tokenOf_requiresNonEmptyValue() {
        assertNull(LanScan.tokenOf("http://h/?token="))
        assertNull(LanScan.tokenOf("http://h/?token"))
        assertNull(LanScan.tokenOf("http://h/"))
        assertNull(LanScan.tokenOf("http://h/?"))
    }

    @Test
    fun tokenOf_handlesNullAndEmpty() {
        assertNull(LanScan.tokenOf(null))
        assertNull(LanScan.tokenOf(""))
    }

    @Test
    fun tokenOf_doesNotConfuseSimilarNames() {
        assertNull(LanScan.tokenOf("http://h/?token-lan=60111186"))
        assertNull(LanScan.tokenOf("http://h/?mytoken=1"))
    }

    // ---------- rebind ----------

    @Test
    fun rebind_keepsPinAndSwapsHost() {
        val old = Endpoint(
            id = "x",
            label = "192.168.50.58",
            url = "http://192.168.50.58:3081/?token=60111186",
        )
        val fresh = LanScan.rebind(old, "192.168.50.77")
        assertEquals("http://192.168.50.77:3081/?token=60111186", fresh?.url)
        assertEquals("192.168.50.77", fresh?.label)
        assertEquals(Endpoint.Kind.LAN, fresh?.kind)
    }

    @Test
    fun rebind_preservesHttpsScheme() {
        val old = Endpoint(id = "x", label = "h", url = "https://pc.local:8443/?token=87654321")
        val fresh = LanScan.rebind(old, "192.168.50.9")
        assertEquals("https://192.168.50.9:8443/?token=87654321", fresh?.url)
    }

    @Test
    fun rebind_returnsNullWhenOldUrlHasNoPin() {
        // 没有 PIN 就拼不出能连的地址；这里必须返回 null 让上层退回「让用户手输」，
        // 不能猜一个 PIN 出来。
        val old = Endpoint(id = "x", label = "h", url = "http://192.168.50.58:3081/")
        assertNull(LanScan.rebind(old, "192.168.50.77"))
    }

    @Test
    fun rebind_returnsNullForUnusableHost() {
        val old = Endpoint(id = "x", label = "h", url = "http://h:3081/?token=12345678")
        assertNull(LanScan.rebind(old, ""))
        assertNull(LanScan.rebind(old, "   "))
    }

    @Test
    fun rebind_producesStableIdForSameHost() {
        // 同一台电脑扫两次不能产生两条档案
        val old = Endpoint(id = "x", label = "h", url = "http://h:3081/?token=12345678")
        val a = LanScan.rebind(old, "192.168.50.77")
        val b = LanScan.rebind(old, "192.168.50.77")
        assertEquals(a?.id, b?.id)
    }

    @Test
    fun rebind_changesIdWhenHostChanges() {
        val old = Endpoint(id = "x", label = "h", url = "http://h:3081/?token=12345678")
        val a = LanScan.rebind(old, "192.168.50.77")
        val b = LanScan.rebind(old, "192.168.50.78")
        assertFalse(a?.id == b?.id)
    }

    @Test
    fun rebind_marksRecentUse() {
        val before = System.currentTimeMillis()
        val old = Endpoint(id = "x", label = "h", url = "http://h:3081/?token=12345678")
        val fresh = LanScan.rebind(old, "192.168.50.77")
        assertTrue(fresh!!.lastUsedAt >= before)
    }
}
