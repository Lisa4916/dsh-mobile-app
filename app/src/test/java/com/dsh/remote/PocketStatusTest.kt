package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [PocketStatus] 的取值测试。
 *
 * 夹具全是真机上抓到的形状（2026-11-03 `POST /dsh-pocket/pocket.status` 的响应），
 * 不是编的：字段名、`lanAuthEnabled` 的位置、`tunnelRunning` 与 `tunnelUrl` 并存的事实都对得上。
 */
class PocketStatusTest {

    /** 真机实测响应（隧道在跑）。 */
    private val live = """
        {"proxyPort":3081,"lanUrl":"http://192.168.50.58:3081","tunnelRunning":true,
         "tunnelUrl":"https://tunnel-a.trycloudflare.com",
         "tunnelState":{"phase":"ready","startedAt":1793614199149},"dshPort":30462,
         "accessToken":"87654321","lanToken":"12345678","lanAuthEnabled":false}
    """.trimIndent()

    @Test
    fun parse_readsTheFieldsWeNeed() {
        val s = PocketStatus.parse(live)
        assertNotNull(s)
        assertEquals("https://tunnel-a.trycloudflare.com", s!!.tunnelUrl)
        assertEquals("http://192.168.50.58:3081", s.lanUrl)
        assertTrue(s.tunnelRunning)
        assertEquals("87654321", s.accessToken)
    }

    @Test
    fun parse_rejectsNonJson() {
        assertNull(PocketStatus.parse("unauthorized"))
        assertNull(PocketStatus.parse(""))
        assertNull(PocketStatus.parse(null))
        assertNull(PocketStatus.parse("<html>401</html>"))
    }

    @Test
    fun parse_rejectsUnrelatedJsonObject() {
        // 有 JSON 形状但一个能用的键都没有：不是 pocket 的回复，别当状态用。
        assertNull(PocketStatus.parse("""{"error":"nope"}"""))
    }

    @Test
    fun parse_tunnelStoppedKeepsTheStaleUrlButFlagIsFalse() {
        // 服务端关掉隧道后仍会留着上一次的 url —— 这正是「照抄会拿到 530 死地址」的来源。
        val stopped = live.replace("\"tunnelRunning\":true", "\"tunnelRunning\":false")
        val s = PocketStatus.parse(stopped)
        assertNotNull(s)
        assertFalse(s!!.tunnelRunning)
        // url 还在，这是事实，parse 不该替它编造也不该抹掉
        assertNotNull(s.tunnelUrl)
    }

    @Test
    fun publicEndpoint_buildsHttpsUrlWithToken() {
        val ep = PocketStatus.publicEndpoint(live, now = 1L)
        assertNotNull(ep)
        assertEquals(PocketStatus.LABEL, ep!!.label)
        assertTrue(ep.url.startsWith("https://tunnel-a.trycloudflare.com/"))
        // 公网入口永远要 PIN，不带 token 就只会停在验证页
        assertTrue(ep.url.contains("token=87654321"))
        assertEquals(Endpoint.Kind.PUBLIC, ep.kind)
    }

    @Test
    fun publicEndpoint_returnsNullWhenTunnelIsNotRunning() {
        val stopped = live.replace("\"tunnelRunning\":true", "\"tunnelRunning\":false")
        assertNull(PocketStatus.publicEndpoint(stopped, now = 1L))
    }

    @Test
    fun publicEndpoint_returnsNullForLoopbackAndPrivateHosts() {
        // 「公网隧道」档案里出现回环/私网地址是纯粹的误导：那条链接只在同一台机器
        // 或同一个 Wi-Fi 里能开。这类值必须拒掉，而**不是**靠后缀白名单拒。
        val loopback = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "https://127.0.0.1:3081",
        )
        assertNull(PocketStatus.publicEndpoint(loopback, now = 1L))
        val lan = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "https://192.168.50.58:3081",
        )
        assertNull(PocketStatus.publicEndpoint(lan, now = 1L))
        val cgnat = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "https://100.64.1.7:3081",
        )
        // CGNAT 100.64/10 在 Endpoint 里明确不算私网（手机在 4G 下拿到的就是它），
        // 但它作为「公网隧道」照样没意义 —— 这一条记录的是当前行为，不是理想状态。
        assertNull(PocketStatus.publicEndpoint(cgnat, now = 1L))
    }

    @Test
    fun publicEndpoint_acceptsNamedTunnelOnOwnDomain() {
        // 根治方案：dsh-pocket 切 named 隧道，域名是用户自己的固定域名。
        // 老版本这里写死 `.trycloudflare.com` 结尾，会把固定域名当垃圾丢掉 ——
        // 于是「换成固定域名」在 App 侧永远收不到结果（2026-11-03 修）。
        val named = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "https://pocket.example.com",
        )
        val ep = PocketStatus.publicEndpoint(named, now = 1L)
        assertNotNull(ep)
        assertEquals(Endpoint.Kind.PUBLIC, ep!!.kind)
        assertTrue(ep.url.startsWith("https://pocket.example.com/"))
        assertTrue(ep.url.contains("token=87654321"))
    }

    @Test
    fun publicEndpoint_namedTunnelEntryIsNotVolatile() {
        // 命名隧道重启地址不变，所以列表里不该对它显示「地址会变，得重新扫码」，
        // 也不该被 PocketProbe 当易变条目排除（那会让它连候选都进不去）。
        val named = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "https://pocket.example.com",
        )
        val ep = PocketStatus.publicEndpoint(named, now = 1L)
        assertNotNull(ep)
        assertFalse(ep!!.urlIsVolatile)
    }

    @Test
    fun publicEndpoint_returnsNullForPlainHttp() {
        val http = live.replace(
            "https://tunnel-a.trycloudflare.com",
            "http://abc.trycloudflare.com",
        )
        assertNull(PocketStatus.publicEndpoint(http, now = 1L))
    }

    @Test
    fun publicEndpoint_returnsNullWithoutToken() {
        // 没有 accessToken 就拼不出能过验证的地址，宁可不生成档案。
        val noToken = live.replace("\"accessToken\":\"87654321\",", "")
        assertNull(PocketStatus.publicEndpoint(noToken, now = 1L))
    }

    @Test
    fun publicEndpoint_idIsStableForSameUrl() {
        val a = PocketStatus.publicEndpoint(live, now = 1L)
        val b = PocketStatus.publicEndpoint(live, now = 999_999L)
        assertNotNull(a)
        assertNotNull(b)
        // id 决定 upsert 是「更新」还是「多一条」，同一地址必须同 id
        assertEquals(a!!.id, b!!.id)
    }

    @Test
    fun publicEndpoint_ignoresLookalikeKeyInsideNestedObject() {
        // 顶层没有 tunnelUrl，只有嵌套对象里有一个同名键 —— 不该被当成顶层值。
        val nested = """
            {"proxyPort":3081,"lanUrl":"http://192.168.50.58:3081","tunnelRunning":true,
             "state":{"tunnelUrl":"https://nested.trycloudflare.com"},"accessToken":"87654321"}
        """.trimIndent()
        val s = PocketStatus.parse(nested)
        assertNotNull(s)
        assertNull(s!!.tunnelUrl)
        assertNull(PocketStatus.publicEndpoint(nested, now = 1L))
    }

    // ---- 信封：字段真的不在顶层 ----
    //
    // 2026-11-03 从真机 `POST /dsh-pocket/pocket.status` 抓到的真实响应就是这个形状，
    // 第一版按顶层取键，结果永远 null，日志只有一句
    // `pocket.status: no usable public address` —— 看着像「隧道没开」，其实隧道好着。

    /** 真机原始响应（截断掉两段 base64 二维码，字段与结构未改）。 */
    private val envelope = """
        {"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{
         "proxyRunning":true,"proxyPort":3081,"lanUrl":"http://192.168.50.58:3081",
         "lanCandidates":["198.18.0.1","192.168.50.58"],"lanIpOverride":"",
         "tunnelRunning":true,
         "tunnelUrl":"https://tunnel-b.trycloudflare.com",
         "tunnelState":{"phase":"ready","detail":"隧道就绪 | ready","startedAt":1793644723314},
         "tunnelConfig":{"mode":"quick","hostname":"","tokenSet":false},
         "dshPort":42591,"desktop":true,
         "accessToken":"87654321","lanToken":"12345678","lanAuthEnabled":false,
         "lanEnabled":true,"mobileRightbarEnabled":false}}}
    """.trimIndent()

    @Test
    fun parse_unwrapsTheRpcEnvelope() {
        val s = PocketStatus.parse(envelope)
        assertNotNull(s)
        assertEquals("https://tunnel-b.trycloudflare.com", s!!.tunnelUrl)
        assertEquals("http://192.168.50.58:3081", s.lanUrl)
        assertTrue(s.tunnelRunning)
        assertEquals("87654321", s.accessToken)
    }

    @Test
    fun publicEndpoint_worksThroughTheEnvelope() {
        // 这条是「在外面用流量也能连」的整条链路的起点：取不到它，
        // 手机就永远只剩局域网那一条，出门必然连不上。
        val ep = PocketStatus.publicEndpoint(envelope, now = 1L)
        assertNotNull(ep)
        assertEquals(Endpoint.Kind.PUBLIC, ep!!.kind)
        assertTrue(ep.url.startsWith("https://tunnel-b.trycloudflare.com/"))
        assertTrue(ep.url.contains("token=87654321"))
    }

    @Test
    fun parse_envelopeWithTunnelStoppedStillReportsNotRunning() {
        val stopped = envelope.replace("\"tunnelRunning\":true", "\"tunnelRunning\":false")
        val s = PocketStatus.parse(stopped)
        assertNotNull(s)
        assertFalse(s!!.tunnelRunning)
        assertNull(PocketStatus.publicEndpoint(stopped, now = 1L))
    }

    @Test
    fun parse_rejectsEnvelopeWithOkFalse() {
        // 失败信封里没有 value 层，取不到任何字段 —— 必须老实返回 null。
        val failed = """{"type":"server-response","rpcId":"r1","result":{"ok":false,"error":"nope"}}"""
        assertNull(PocketStatus.parse(failed))
    }

    @Test
    fun parse_toleratesPayloadDirectlyOnTopLevel() {
        // 兼容老格式：字段就在顶层（没有 result/value 信封）。
        val s = PocketStatus.parse(live)
        assertNotNull(s)
        assertEquals("https://tunnel-a.trycloudflare.com", s!!.tunnelUrl)
    }

    @Test
    fun parse_envelopeIgnoresLookalikeKeysInsideValue() {
        // 信封里的嵌套对象（tunnelState 等）不能冒充顶层字段。
        val tricky = envelope.replace(
            "\"tunnelState\":{\"phase\":\"ready\"",
            "\"tunnelState\":{\"tunnelUrl\":\"https://evil.trycloudflare.com\",\"phase\":\"ready\"",
        )
        val s = PocketStatus.parse(tricky)
        assertNotNull(s)
        assertEquals("https://tunnel-b.trycloudflare.com", s!!.tunnelUrl)
    }
}
