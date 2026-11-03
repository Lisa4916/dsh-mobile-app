package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [PocketProbe] 的候选地址选择与 cookie 种子测试。
 *
 * 为什么值得单测：这段逻辑决定「手机在外面到底能不能自己把公网地址换掉」。
 * 真机上判错的后果是要么永远背着一条死域名（2026-11-03 的原始故障），
 * 要么对着一串已经死掉的 quick tunnel 域名挨个等 4 秒超时；
 * 而漏掉 PIN 的后果是每次回退都拿一个没有 cookie 的 origin 去问，恒 401
 * （真机日志 `pocket.status http 401` 就是这么来的）。
 *
 * 夹具里的域名全是编的：`tunnel-a/b.trycloudflare.com` 这种形状就是 quick tunnel 的样子。
 */
class PocketProbeTest {

    private fun lan(host: String = "192.168.50.58", port: Int? = 3081, lastUsedAt: Long = 10L) =
        Endpoint(
            "lan|$host",
            host,
            if (port == null) "http://$host/?token=60111186" else "http://$host:$port/?token=60111186",
            lastUsedAt,
        )

    private fun pub(host: String = "tunnel-a.trycloudflare.com", lastUsedAt: Long = 20L) =
        Endpoint("pub|$host", "公网隧道", "https://$host/?token=75330002", lastUsedAt)

    private fun loop() = Endpoint("loop", "127.0.0.1", "http://127.0.0.1:3081/?token=75330002", 5L)

    private fun origins(current: Endpoint?, all: List<Endpoint>, localLanIp: String? = null) =
        PocketProbe.bases(current, all, localLanIp).map { it.origin }

    // ---------- originOf ----------

    @Test
    fun originOf_keepsSchemeHostAndPort() {
        assertEquals("http://192.168.50.58:3081", PocketProbe.originOf("http://192.168.50.58:3081/?token=x"))
        assertEquals("https://a.trycloudflare.com", PocketProbe.originOf("https://a.trycloudflare.com/?token=x"))
    }

    @Test
    fun originOf_dropsPathQueryFragment() {
        assertEquals("http://h:8080", PocketProbe.originOf("http://h:8080/deep/path?q=1#frag"))
    }

    @Test
    fun originOf_rejectsGarbage() {
        assertNull(PocketProbe.originOf(null))
        assertNull(PocketProbe.originOf(""))
        assertNull(PocketProbe.originOf("not a url"))
        assertNull("file:// 不是 dsh-pocket 的入口", PocketProbe.originOf("file:///etc/passwd"))
    }

    // ---------- pinOf ----------

    @Test
    fun pinOf_readsTokenQueryParameter() {
        assertEquals("75330002", PocketProbe.pinOf("https://a.trycloudflare.com/?token=75330002"))
        assertEquals("60111186", PocketProbe.pinOf("http://192.168.50.58:3081/?token=60111186"))
    }

    @Test
    fun pinOf_ignoresHandshakeParameters() {
        // `dsh-pocket-auth` / `dsh-pocket-retry` 是握手用的，不是凭据。
        assertNull(PocketProbe.pinOf("https://a.trycloudflare.com/?dsh-pocket-auth=1"))
        assertNull(PocketProbe.pinOf("https://a.trycloudflare.com/?dsh-pocket-retry=2"))
    }

    @Test
    fun pinOf_handlesMultipleParametersAndEmptyPin() {
        assertEquals("75330002", PocketProbe.pinOf("https://a.trycloudflare.com/?x=1&token=75330002&y=2"))
        assertNull(PocketProbe.pinOf("https://a.trycloudflare.com/?token="))
        assertNull(PocketProbe.pinOf("https://a.trycloudflare.com/"))
        assertNull(PocketProbe.pinOf(null))
    }

    // ---------- Probe.seedUrl ----------

    @Test
    fun seedUrl_appendsTokenSoDshPocketIssuesTheCookie() {
        // 实测：`GET http://127.0.0.1:3081/` 的响应头里有 `Set-Cookie: dsh-auth-…`，
        // 但没有 `?token=` 时可能是「访问验证」页，带上 PIN 才稳定换到会话。
        assertEquals(
            "http://192.168.50.58:3081/?token=60111186",
            PocketProbe.Probe("http://192.168.50.58:3081", "60111186").seedUrl,
        )
    }

    @Test
    fun seedUrl_fallsBackToBareOriginWithoutPin() {
        assertEquals("https://a.trycloudflare.com/", PocketProbe.Probe("https://a.trycloudflare.com", null).seedUrl)
    }

    // ---------- bases ----------

    @Test
    fun bases_putsCurrentFirst() {
        val cur = pub("tunnel-live.trycloudflare.com")
        val got = origins(cur, listOf(lan(), pub()), localLanIp = "192.168.50.58")
        assertEquals("https://tunnel-live.trycloudflare.com", got.first())
    }

    @Test
    fun bases_fallsBackToSavedLanWhenCurrentIsDeadQuickTunnel() {
        // 事故原样：当前是那条死域名，手机走流量。没有 Wi-Fi 就没有第三项，
        // 但已保存的局域网档案仍然要给出来 —— 它的 cookie 可能还在。
        val dead = pub("integrated-idaho-feat-sherman.trycloudflare.com")
        val got = origins(dead, listOf(lan(), dead), localLanIp = null)
        assertEquals(
            listOf(
                "https://integrated-idaho-feat-sherman.trycloudflare.com",
                "http://192.168.50.58:3081",
            ),
            got,
        )
    }

    @Test
    fun bases_carriesThePinOfEveryCandidate() {
        // 真机上第一版漏了这个，回退 base 恒 401（`pocket.status http 401`）。
        // 用不同的 Wi-Fi IP 是为了让第三条独立出现，不被去重吃掉。
        val dead = pub("dead.trycloudflare.com")
        val probes = PocketProbe.bases(dead, listOf(dead, lan()), localLanIp = "192.168.50.90")
        assertEquals(3, probes.size)
        assertEquals("75330002", probes[0].pin)
        assertEquals("60111186", probes[1].pin)
        assertEquals("60111186", probes[2].pin) // Wi-Fi 那条沿用同一台电脑的 lan token
    }

    @Test
    fun bases_appendsWifiAddressWithSavedPort() {
        val got = origins(null, listOf(lan(port = 4000)), localLanIp = "192.168.50.90")
        assertEquals(listOf("http://192.168.50.58:4000", "http://192.168.50.90:4000"), got)
    }

    @Test
    fun bases_usesDefaultPortWhenNoLanProfileExists() {
        val got = origins(null, emptyList(), localLanIp = "192.168.50.90")
        assertEquals(listOf("http://192.168.50.90:${PocketProbe.DEFAULT_PORT}"), got)
    }

    @Test
    fun bases_skipsBlankWifiAddress() {
        assertTrue(PocketProbe.bases(null, emptyList(), localLanIp = null).isEmpty())
        assertTrue(PocketProbe.bases(null, emptyList(), localLanIp = "  ").isEmpty())
    }

    @Test
    fun bases_dedupesKeepingOrder() {
        // 当前页面恰好就是那条局域网档案时，不该出现两次 —— 每次重复都是一个 4 秒超时。
        val cur = lan()
        val got = origins(cur, listOf(cur), localLanIp = "192.168.50.58")
        assertEquals(listOf("http://192.168.50.58:3081"), got)
    }

    @Test
    fun bases_dedupeFillsInMissingPin() {
        // 当前页面那条 URL 没带 PIN（用户手输时省了），后面同 origin 的档案带了 —— 要补上，
        // 否则第一个候选种不上 cookie。
        val bare = Endpoint("bare", "192.168.50.58", "http://192.168.50.58:3081/", 30L)
        val withPin = lan(lastUsedAt = 10L)
        val probes = PocketProbe.bases(bare, listOf(bare, withPin), localLanIp = null)
        assertEquals(1, probes.size)
        assertEquals("60111186", probes[0].pin)
    }

    @Test
    fun bases_neverProposesAnotherPublicProfile() {
        // 别的公网 quick tunnel 大概率也是死域名，试它只是白等。
        val cur = pub("dead-one.trycloudflare.com")
        val other = pub("dead-two.trycloudflare.com", lastUsedAt = 99L)
        val got = origins(cur, listOf(cur, other), localLanIp = null)
        assertTrue("除当前以外不该出现第二条公网", got.none { it.contains("dead-two") })
    }

    @Test
    fun bases_includesNonVolatilePublicSuchAsNamedTunnel() {
        // 命名隧道是固定域名，cookie 可能还在，值得试。
        val named = Endpoint("named", "公网隧道", "https://remote.example.com/?token=1", 30L)
        val dead = pub("dead-one.trycloudflare.com")
        val got = origins(dead, listOf(dead, named), localLanIp = null)
        assertEquals(listOf("https://dead-one.trycloudflare.com", "https://remote.example.com"), got)
    }

    @Test
    fun bases_includesLoopbackProfile() {
        // USB 反向转发（`adb reverse tcp:3081 tcp:3081`）时手存的本机档案，是一条真能用的
        // 救急入口 —— 它也必须进候选，否则外面连死域名时没有任何可用 base。
        // 这条路径真机验证过：`pocket.status: answered via http://127.0.0.1:3081`。
        val dead = pub("dead-one.trycloudflare.com")
        val got = origins(dead, listOf(dead, loop()), localLanIp = null)
        assertEquals(listOf("https://dead-one.trycloudflare.com", "http://127.0.0.1:3081"), got)
    }

    @Test
    fun bases_ordersLanByRecency() {
        val older = lan(host = "192.168.50.10", lastUsedAt = 1L)
        val newer = lan(host = "192.168.50.20", lastUsedAt = 50L)
        val got = origins(null, listOf(older, newer), localLanIp = null)
        assertEquals(listOf("http://192.168.50.20:3081", "http://192.168.50.10:3081"), got)
    }

    // ---------- staleVolatileIds ----------

    @Test
    fun staleVolatileIds_dropsOldQuickTunnelEntries() {
        val fresh = pub("tunnel-new.trycloudflare.com")
        val old = pub("tunnel-old.trycloudflare.com")
        val kept = lan()
        assertEquals(listOf(old.id), PocketProbe.staleVolatileIds(listOf(old, kept, fresh), fresh))
    }

    @Test
    fun staleVolatileIds_neverTouchesLanEntries() {
        val fresh = pub("tunnel-new.trycloudflare.com")
        assertTrue(PocketProbe.staleVolatileIds(listOf(lan(), fresh), fresh).isEmpty())
    }

    @Test
    fun staleVolatileIds_keepsEverythingWhenFreshIsNamedTunnel() {
        // 命名隧道是固定域名（host 不是 .trycloudflare.com）：此时 quick tunnel 条目
        // 可能是用户另外留着的入口，不该顺手删。
        val named = Endpoint("named", "公网隧道", "https://remote.example.com/?token=1", 1L)
        val quick = pub("tunnel-old.trycloudflare.com")
        assertTrue(PocketProbe.staleVolatileIds(listOf(quick, named), named).isEmpty())
    }

    @Test
    fun staleVolatileIds_isEmptyWhenNothingToDrop() {
        val fresh = pub("tunnel-new.trycloudflare.com")
        assertTrue(PocketProbe.staleVolatileIds(listOf(fresh), fresh).isEmpty())
        assertTrue(PocketProbe.staleVolatileIds(emptyList(), fresh).isEmpty())
    }
}
