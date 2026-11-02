package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Endpoint 的解析与序列化必须有测试：这两处一旦出错，
 * 表现是「扫码成功但打不开」或「重启 App 后连接消失」，
 * 都不是崩溃，最难靠肉眼发现。
 */
class EndpointTest {

    @Test
    fun parseUri_acceptsLanHttp() {
        val url = "http://192.168.50.58:3081/?token=12345678"
        assertEquals(url, Endpoint.parseUri(url))
    }

    @Test
    fun parseUri_acceptsHttpsWithTrailingSpace() {
        val url = "  https://pocket.example.com:3443/#k  "
        assertEquals(url.trim(), Endpoint.parseUri(url))
    }

    @Test
    fun parseUri_rejectsSchemeLess() {
        assertNull(Endpoint.parseUri("192.168.50.58:3081"))
        assertNull(Endpoint.parseUri("ftp://x"))
        assertNull(Endpoint.parseUri(""))
        assertNull(Endpoint.parseUri(null))
    }

    @Test
    fun parseUri_rejectsHostlessHttp() {
        assertNull(Endpoint.parseUri("http://"))
        assertNull(Endpoint.parseUri("http:///?token=1"))
    }

    @Test
    fun host_extracted() {
        val e = Endpoint("1", "本机", "http://192.168.50.58:3081/?token=12345678")
        assertEquals("192.168.50.58", e.host)
    }

    @Test
    fun serialize_roundTrip() {
        val list = listOf(
            Endpoint("1", "本机", "http://192.168.50.58:3081/?token=a", 100L),
            Endpoint("2", "公司", "https://pocket.example.com/#b", 200L),
        )
        val text = EndpointStore.serialize(list)
        val back = EndpointStore.deserialize(text)
        assertEquals(list.size, back.size)
        assertEquals(list[0].url, back[0].url)
        assertEquals(list[1].label, back[1].label)
        assertEquals(200L, back[1].lastUsedAt)
    }

    @Test
    fun serialize_stripsTabsAndNewlinesInLabel() {
        val messy = Endpoint("1", "本机\t含\n换行", "http://h:1/?token=x", 5L)
        val back = EndpointStore.deserialize(EndpointStore.serialize(listOf(messy)))
        assertEquals(1, back.size)
        assertTrue("制表符必须被替换，否则字段会错位", !back[0].label.contains('\t'))
        assertTrue(!back[0].label.contains('\n'))
        assertEquals("http://h:1/?token=x", back[0].url)
    }

    @Test
    fun deserialize_skipsMalformedLines() {
        val raw = "1\t好\thttp://h:1/?token=x\t9\n坏行\n\n2\t更好\thttp://h:2/?token=y\tnotanumber"
        val back = EndpointStore.deserialize(raw)
        assertEquals(2, back.size)
        assertEquals(9L, back[0].lastUsedAt)
        // lastUsedAt 解析失败时降级为 0，不丢弃整条记录
        assertEquals(0L, back[1].lastUsedAt)
    }

    @Test
    fun deserialize_emptyReturnsEmpty() {
        assertTrue(EndpointStore.deserialize("").isEmpty())
    }

    @Test
    fun idFor_sameInputSameId() {
        val a = EndpointStore.idFor("本机", "http://h:1/?token=x")
        val b = EndpointStore.idFor("  本机 ", "http://h:1/?token=x")
        assertEquals("同一入口重复扫码必须命中同一条记录", a, b)
    }

    @Test
    fun idFor_differentUrlDifferentId() {
        val a = EndpointStore.idFor("本机", "http://h:1/?token=x")
        val b = EndpointStore.idFor("本机", "http://h:2/?token=x")
        assertTrue(a != b)
    }

    @Test
    fun lastUsed_picksMax() {
        val list = listOf(
            Endpoint("1", "a", "http://h:1/", 100L),
            Endpoint("2", "b", "http://h:2/", 500L),
            Endpoint("3", "c", "http://h:3/", 300L),
        )
        assertEquals("2", list.maxByOrNull { it.lastUsedAt }?.id)
    }

    // ------------------------------------------------------------ 入口类型

    @Test
    fun kind_lanRanges() {
        val lan = listOf(
            "http://192.168.50.58:3081/?token=x",
            "http://192.168.0.1/",
            "http://10.0.0.5:3081/",
            "http://10.255.255.254/",
            "http://172.16.0.1/",
            "http://172.31.255.1/",
            "http://169.254.13.7:3081/",
        )
        for (u in lan) {
            assertEquals("应判为局域网：$u", Endpoint.Kind.LAN, Endpoint.kindOf(u))
        }
    }

    @Test
    fun kind_loopback() {
        val loop = listOf(
            "http://127.0.0.1:3081/",
            "http://127.1.2.3/",
            "http://localhost:3081/",
            "http://[::1]:3081/",
        )
        for (u in loop) {
            assertEquals("应判为回环：$u", Endpoint.Kind.LOOPBACK, Endpoint.kindOf(u))
        }
    }

    @Test
    fun kind_public() {
        val pub = listOf(
            "https://advised-won-nov-observer.trycloudflare.com/",
            "https://pocket.example.com/",
            "http://8.8.8.8/",
            "http://172.15.0.1/",   // 紧邻 172.16 但不属于私有段
            "http://172.32.0.1/",   // 紧邻 172.31 但不属于私有段
            "http://11.0.0.1/",
            "http://192.169.0.1/",
        )
        for (u in pub) {
            assertEquals("应判为公网：$u", Endpoint.Kind.PUBLIC, Endpoint.kindOf(u))
        }
    }

    /**
     * CGNAT 100.64/10 是最容易判错的一段：手机在 4G 下常拿到 100.x 地址，
     * 但那是运营商的内网，**连不到家里那台电脑的局域网入口**。判成 LAN 会让
     * 界面把一条必然打不开的链接标成「局域网」。
     */
    @Test
    fun kind_cgnatIsNotLan() {
        assertEquals(Endpoint.Kind.PUBLIC, Endpoint.kindOf("http://100.64.0.1:3081/"))
        assertEquals(Endpoint.Kind.PUBLIC, Endpoint.kindOf("http://100.127.255.1/"))
    }

    @Test
    fun kind_ipv6Private() {
        assertEquals(Endpoint.Kind.LAN, Endpoint.kindOf("http://[fd00::1]:3081/"))
        assertEquals(Endpoint.Kind.LAN, Endpoint.kindOf("http://[fc00::1]/"))
        assertEquals(Endpoint.Kind.LAN, Endpoint.kindOf("http://[fe80::1]/"))
        assertEquals(Endpoint.Kind.PUBLIC, Endpoint.kindOf("http://[2408:832e:8c1:4c40::1]/"))
    }

    /**
     * IPv4-mapped IPv6（`::ffff:192.168.1.5`）会被系统直接拿来表示 IPv4 对端。
     * 只看首字节会掉进「3 不是 fc/fd/fe → 判公网」的坑，把局域网入口标成公网。
     */
    @Test
    fun kind_ipv4MappedIpv6FollowsEmbeddedV4() {
        assertEquals(Endpoint.Kind.LAN, Endpoint.kindOf("http://[::ffff:192.168.1.5]:3081/"))
        assertEquals(Endpoint.Kind.LAN, Endpoint.kindOf("http://[::ffff:10.0.0.7]/"))
        assertEquals(Endpoint.Kind.PUBLIC, Endpoint.kindOf("http://[::ffff:8.8.8.8]/"))
    }

    @Test
    fun kind_hostlessFallsBackToPublic() {
        // 解析不出 host 时不能抛异常，也不能谎称是局域网
        assertEquals(Endpoint.Kind.PUBLIC, Endpoint.kindOf("http://"))
    }

    @Test
    fun kind_isDerivedByDefault() {
        val lan = Endpoint("1", "本机", "http://192.168.50.58:3081/?token=x")
        assertEquals("构造时不传 kind 也应自动推断", Endpoint.Kind.LAN, lan.kind)
        assertTrue(!lan.isPublic)
    }

    @Test
    fun urlIsVolatile_onlyForQuickTunnel() {
        val quick = Endpoint("1", "公网", "https://advised-won-novo.trycloudflare.com/")
        assertTrue("quick tunnel 的域名每次重开都会变，要提示", quick.urlIsVolatile)

        val named = Endpoint("2", "固定域名", "https://pocket.example.com/")
        assertTrue("命名隧道地址固定，不该提示", !named.urlIsVolatile)

        val lan = Endpoint("3", "本机", "http://192.168.50.58:3081/")
        assertTrue(!lan.urlIsVolatile)
    }

    // -------------------------------------------------- 序列化向后兼容

    @Test
    fun serialize_roundTripKeepsKind() {
        val list = listOf(
            Endpoint("1", "本机", "http://192.168.50.58:3081/?token=a", 100L, Endpoint.Kind.LAN),
            Endpoint("2", "公网", "https://x.trycloudflare.com/", 200L, Endpoint.Kind.PUBLIC),
            Endpoint("3", "调试", "http://127.0.0.1:3081/", 300L, Endpoint.Kind.LOOPBACK),
        )
        val back = EndpointStore.deserialize(EndpointStore.serialize(list))
        assertEquals(list.size, back.size)
        assertEquals(Endpoint.Kind.LAN, back[0].kind)
        assertEquals(Endpoint.Kind.PUBLIC, back[1].kind)
        assertEquals(Endpoint.Kind.LOOPBACK, back[2].kind)
    }

    /**
     * 升级兼容：老版本只写 4 列。这些记录**必须照样读出来**，
     * 否则用户升级 App 后连接列表会凭空清空。
     */
    @Test
    fun deserialize_legacyFourColumnsStillLoads() {
        val legacy = "123\t本机\thttp://192.168.50.58:3081/?token=x\t999"
        val back = EndpointStore.deserialize(legacy)
        assertEquals("老格式不能丢", 1, back.size)
        assertEquals("123", back[0].id)
        assertEquals(999L, back[0].lastUsedAt)
        assertEquals(Endpoint.Kind.LAN, back[0].kind)
    }

    @Test
    fun deserialize_unknownKindFallsBackToUrlInference() {
        val raw = "1\t本机\thttp://10.1.2.3:3081/?token=x\t5\tNOT_A_KIND"
        val back = EndpointStore.deserialize(raw)
        assertEquals(1, back.size)
        assertEquals("无法识别的 kind 应按 url 重新推断", Endpoint.Kind.LAN, back[0].kind)
    }
}
