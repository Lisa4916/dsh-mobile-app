package com.dsh.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 同域判定的单测。
 *
 * 这组用例的价值全在**反面**：`isSameHost` 说「是」的时候，外部页面会被留在
 * 没有地址栏的 WebView 里，而 WebView 上挂着 `dshNative` JS 桥。所以每条**绕过尝试**
 * 都必须断言 false。
 */
class HostMatchTest {

    private val host = "producers-discharge-atmosphere-ppc.trycloudflare.com"

    // ---------------------------------------------------------------- 应判同域

    @Test
    fun sameHost_exactUrl() {
        assertTrue(HostMatch.isSameHost("https://$host/", host))
    }

    @Test
    fun sameHost_withPathAndQuery() {
        assertTrue(HostMatch.isSameHost("https://$host/api/sessions?x=1&token=abc", host))
    }

    @Test
    fun sameHost_ignoresCase() {
        assertTrue(HostMatch.isSameHost("https://${host.uppercase()}/x", host))
    }

    @Test
    fun sameHost_toleratesTrailingDotInAllowedHost() {
        // DNS 里 example.com. 与 example.com 是同一台机器
        assertTrue(HostMatch.isSameHost("https://$host/x", "$host."))
    }

    @Test
    fun sameHost_allowsSubdomain() {
        // quick tunnel 重开会换子域，放宽到子域是刻意的
        assertTrue(HostMatch.isSameHost("https://a.$host/x", host))
    }

    @Test
    fun sameHost_lanIp() {
        assertTrue(HostMatch.isSameHost("http://192.168.50.58:3081/?token=1", "192.168.50.58"))
    }

    // ------------------------------------------------------------ 必须判外链

    @Test
    fun external_hostInQueryStringDoesNotCount() {
        // 旧实现 url.contains(host) 在这里判成同域 —— 本次修复的核心用例
        assertFalse(HostMatch.isSameHost("https://evil.com/?x=$host", host))
    }

    @Test
    fun external_hostInFragmentDoesNotCount() {
        assertFalse(HostMatch.isSameHost("https://evil.com/#$host", host))
    }

    @Test
    fun external_hostAsSubdomainSuffixDoesNotCount() {
        // <host>.evil.com：旧实现 contains 命中，实际是别人的域名
        assertFalse(HostMatch.isSameHost("https://$host.evil.com/steal", host))
    }

    @Test
    fun external_hostAsPathSegmentDoesNotCount() {
        assertFalse(HostMatch.isSameHost("https://evil.com/$host/login", host))
    }

    @Test
    fun external_lookalikeWithoutDotBoundaryDoesNotCount() {
        // evilexample.com 以 "example.com" 结尾但不是子域
        assertFalse(HostMatch.isSameHost("https://evilexample.com/x", "example.com"))
    }

    @Test
    fun external_differentHost() {
        assertFalse(HostMatch.isSameHost("https://example.org/", host))
    }

    // ---------------------------------------------------------------- 边界输入

    @Test
    fun blankAndNullAreNotSameHost() {
        assertFalse(HostMatch.isSameHost(null, host))
        assertFalse(HostMatch.isSameHost("", host))
        assertFalse(HostMatch.isSameHost("   ", host))
        assertFalse(HostMatch.isSameHost("https://$host/", null))
        assertFalse(HostMatch.isSameHost("https://$host/", ""))
    }

    @Test
    fun unparsableTargetIsTreatedAsExternal() {
        assertFalse(HostMatch.isSameHost("not a url", host))
        assertFalse(HostMatch.isSameHost("https://", host))
    }

    // --------------------------------------------------- shouldOpenExternally

    @Test
    fun openExternally_onlyForForeignWebPages() {
        assertTrue(HostMatch.shouldOpenExternally("https://evil.com/?x=$host", host))
        assertTrue(HostMatch.shouldOpenExternally("https://$host.evil.com/", host))
        assertFalse(HostMatch.shouldOpenExternally("https://$host/page", host))
    }

    @Test
    fun openExternally_ignoresNonWebSchemes() {
        // 非 http(s) 不由本函数决定去留（维持旧行为），交给系统更自然
        assertFalse(HostMatch.shouldOpenExternally("mailto:a@b.com", host))
        assertFalse(HostMatch.shouldOpenExternally("tel:10086", host))
        assertFalse(HostMatch.shouldOpenExternally("about:blank", host))
    }

    @Test
    fun openExternally_blankTargetIsNotExternallyOpened() {
        assertFalse(HostMatch.shouldOpenExternally(null, host))
        assertFalse(HostMatch.shouldOpenExternally("", host))
    }
}
