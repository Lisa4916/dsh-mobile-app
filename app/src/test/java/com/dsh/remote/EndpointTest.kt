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
        val url = "http://192.168.50.58:3081/?token=60111186"
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
        val e = Endpoint("1", "本机", "http://192.168.50.58:3081/?token=60111186")
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
}
