package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [BootstrapUrl] 的判据。
 *
 * 背景：内置地址原来是硬编码在 [MainActivity] 里的
 * `http://192.168.50.58:3081/?token=12345678` —— 既是局域网 PIN 泄漏（进仓库就等于给出访问密码），
 * 也把 IP 钉死，换个网段就报废。
 *
 * 现在改成构建时从 local.properties 注入（见 app/build.gradle.kts 的 addLanUrl 校验），
 * 这里测的是「注入值到最终 URL」这段纯逻辑，不依赖 Android。
 */
class BootstrapUrlTest {

    @Test
    fun build_composesUrlFromHostAndPin() {
        assertEquals(
            "http://192.168.50.58:3081/?token=12345678",
            BootstrapUrl.build("192.168.50.58:3081", "12345678"),
        )
    }

    @Test
    fun build_keepsDefaultPortWhenHostHasNoPort() {
        // 不带端口就按 http 默认 80 处理，不擅自补 3081
        assertEquals(
            "http://192.168.50.58/?token=12345678",
            BootstrapUrl.build("192.168.50.58", "12345678"),
        )
    }

    @Test
    fun build_acceptsHttpsHostWithScheme() {
        // 用户可能把整条带 scheme 的地址填进 dsh.lanUrl，不能再拼一次 http://
        assertEquals(
            "https://tunnel-name.trycloudflare.com/?token=87654321",
            BootstrapUrl.build(
                "https://tunnel-name.trycloudflare.com",
                "87654321",
            ),
        )
    }

    @Test
    fun build_toleratesWhitespaceAndTrailingSlash() {
        assertEquals(
            "http://192.168.50.58:3081/?token=12345678",
            BootstrapUrl.build("  192.168.50.58:3081/  ", " 12345678 "),
        )
    }

    @Test
    fun build_keepsNonDefaultPort() {
        assertEquals(
            "http://192.168.50.58:8080/?token=1234",
            BootstrapUrl.build("http://192.168.50.58:8080", "1234"),
        )
    }

    @Test
    fun build_returnsNullWhenHostMissing() {
        assertNull(BootstrapUrl.build(null, "12345678"))
        assertNull(BootstrapUrl.build("", "12345678"))
        assertNull(BootstrapUrl.build("   ", "12345678"))
    }

    @Test
    fun build_returnsNullWhenPinMissing() {
        // 没有 PIN 就拼不出可用地址：宁可让 App 走「手输/扫码」引导，
        // 也不要生成一个进不去的地址让用户以为是网络问题。
        assertNull(BootstrapUrl.build("192.168.50.58", null))
        assertNull(BootstrapUrl.build("192.168.50.58", ""))
        assertNull(BootstrapUrl.build("192.168.50.58", "   "))
    }

    @Test
    fun build_stripsExistingQueryFromHost() {
        // 万一有人把带 ?token= 的旧地址填进去，不能拼出两个 token
        assertEquals(
            "http://192.168.50.58:3081/?token=newpin",
            BootstrapUrl.build("http://192.168.50.58:3081/?token=oldpin", "newpin"),
        )
    }

    @Test
    fun build_resultIsAcceptedByEndpointParser() {
        // 拼出来的东西必须是 App 真正能连的入口，否则等于白拼
        val url = BootstrapUrl.build("192.168.50.58", "12345678")
        assertTrue(url != null && Endpoint.parseUri(url) != null)
    }

    @Test
    fun build_encodesPinWithSpecialCharacters() {
        // PIN 是纯数字（dsh-pocket 自己生成 8 位数字），但用户在设置页可以自定义，
        // 一旦包含特殊字符必须编码，不然 URL 会被截断。
        assertEquals(
            "http://192.168.50.58/?token=a%26b%3Dc",
            BootstrapUrl.build("192.168.50.58", "a&b=c"),
        )
    }
}
