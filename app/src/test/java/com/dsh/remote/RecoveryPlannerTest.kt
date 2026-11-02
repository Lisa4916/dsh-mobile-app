package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「页面坏了该怎么修」的决策测试。
 *
 * 这层逻辑之所以必须单测：它决定要不要**删掉用户的 cookie**。删错了，
 * 表现是「App 自己把能用的会话搞坏，然后彻底进不去」——用户只能重装。
 * 真机上已复现过这个坑：早期自愈清掉了 `dsh_pocket_token`，页面直接跳「访问验证」，
 * 而那个页面没有 PIN 可填（用户早忘了当初的密码）。
 */
class RecoveryPlannerTest {

    // ------------------------------------------------------------ 探测结果映射

    @Test
    fun fromProbe_mapsRawValues() {
        assertEquals(PageState.HEALTHY, PageState.fromProbe("\"0\""))
        assertEquals(PageState.HANDSHAKE_BROKEN, PageState.fromProbe("\"1\""))
        assertEquals(PageState.PIN_REQUIRED, PageState.fromProbe("\"2\""))
        assertEquals(PageState.HEALTHY, PageState.fromProbe("0"))
        assertEquals(PageState.PIN_REQUIRED, PageState.fromProbe(" 2 "))
    }

    /**
     * 求值失败（null）、异常（"0" 之外的怪值）一律当 UNKNOWN：
     * 拿不准就不动手，这是策略底线。
     */
    @Test
    fun fromProbe_unknownStaysSafe() {
        assertEquals(PageState.UNKNOWN, PageState.fromProbe(null))
        assertEquals(PageState.UNKNOWN, PageState.fromProbe(""))
        assertEquals(PageState.UNKNOWN, PageState.fromProbe("\"\"\"\""))
        assertEquals(PageState.UNKNOWN, PageState.fromProbe("true"))
        // 拿不准时决策必须是「什么都不做」，不能被当成可动手的信号
        assertEquals(
            RecoveryAction.NONE,
            RecoveryPlanner.plan(PageState.fromProbe("true"), "http://h:3081/?token=x"),
        )
    }

    // ------------------------------------------------------------ 决策

    @Test
    fun plan_healthyDoesNothing() {
        assertEquals(
            RecoveryAction.NONE,
            RecoveryPlanner.plan(PageState.HEALTHY, "http://192.168.50.58:3081/?token=12345678"),
        )
    }

    @Test
    fun plan_unknownDoesNothing() {
        assertEquals(
            RecoveryAction.NONE,
            RecoveryPlanner.plan(PageState.UNKNOWN, "http://192.168.50.58:3081/?token=12345678"),
        )
    }

    @Test
    fun plan_handshakeBrokenClearsUpstreamCookie() {
        assertEquals(
            RecoveryAction.CLEAR_UPSTREAM_COOKIE,
            RecoveryPlanner.plan(PageState.HANDSHAKE_BROKEN, "http://192.168.50.58:3081/"),
        )
    }

    /**
     * 核心场景：页面回到「访问验证」，但入口 URL 里还带着当初扫码得到的 `?token=`。
     *
     * 真凶就是**残留的失效 `dsh_pocket_token`**：dsh-pocket 的 `maybeSeedAuthCookie`
     * 见到 cookie 存在就直接 return，不再下发新的（proxy.mjs:509-525）。
     * 所以只清 `dsh-auth-*` 永远修不好，必须把 `dsh_pocket_token` 一起清掉，
     * 再用 URL 里的 token 重新导航。
     */
    @Test
    fun plan_pinPageWithTokenInUrlClearsPocketCookie() {
        assertEquals(
            RecoveryAction.CLEAR_POCKET_COOKIE,
            RecoveryPlanner.plan(PageState.PIN_REQUIRED, "http://192.168.50.58:3081/?token=12345678"),
        )
    }

    /**
     * 反例：URL 里没有 token 时**绝不能**清 `dsh_pocket_token`。
     * 清了就再也没法自动重新认证，用户被永久锁在验证页外面。
     */
    @Test
    fun plan_pinPageWithoutTokenAsksUser() {
        assertEquals(
            RecoveryAction.ASK_USER,
            RecoveryPlanner.plan(PageState.PIN_REQUIRED, "http://192.168.50.58:3081/"),
        )
        assertEquals(
            RecoveryAction.ASK_USER,
            RecoveryPlanner.plan(PageState.PIN_REQUIRED, "https://pocket.example.com/#k"),
        )
        assertEquals(
            RecoveryAction.ASK_USER,
            RecoveryPlanner.plan(PageState.PIN_REQUIRED, null),
        )
    }

    @Test
    fun plan_pinPageWithEmptyTokenAsksUser() {
        assertEquals(
            RecoveryAction.ASK_USER,
            RecoveryPlanner.plan(PageState.PIN_REQUIRED, "http://192.168.50.58:3081/?token="),
        )
    }

    // ------------------------------------------------------------ token 检测

    @Test
    fun hasPinToken_readsQueryOnly() {
        assertTrue(RecoveryPlanner.hasPinToken("http://h:3081/?token=12345678"))
        assertTrue(RecoveryPlanner.hasPinToken("http://h:3081/?a=1&token=12345678&b=2"))
        assertTrue(RecoveryPlanner.hasPinToken("http://h:3081/?token=12345678#frag"))
    }

    @Test
    fun hasPinToken_ignoresFragmentsAndOtherKeys() {
        assertTrue(
            "fragment 里的 token 不是 query，不算",
            !RecoveryPlanner.hasPinToken("http://h:3081/#token=12345678"),
        )
        assertTrue(
            "键名必须完全等于 token，mytoken 不算",
            !RecoveryPlanner.hasPinToken("http://h:3081/?mytoken=12345678"),
        )
        assertTrue(!RecoveryPlanner.hasPinToken("http://h:3081/"))
        assertTrue(!RecoveryPlanner.hasPinToken(""))
        assertTrue(!RecoveryPlanner.hasPinToken(null))
    }

    // ------------------------------------------------------------ retry 参数

    @Test
    fun withRetry_appendsWithCorrectSeparator() {
        assertEquals(
            "http://h:3081/?token=x&dsh-pocket-retry=1",
            RecoveryPlanner.withRetry("http://h:3081/?token=x"),
        )
        assertEquals(
            "http://h:3081/?dsh-pocket-retry=1",
            RecoveryPlanner.withRetry("http://h:3081/"),
        )
    }

    @Test
    fun withRetry_isIdempotent() {
        val once = RecoveryPlanner.withRetry("http://h:3081/?token=x")
        assertEquals(once, RecoveryPlanner.withRetry(once!!))
    }

    /**
     * 踩坑：URL 里只有 `#fragment` 而没有 `?` 时，若直接拼在末尾，
     * `?dsh-pocket-retry=1` 会落进 fragment，服务端根本收不到，于是握手计数清不掉，
     * 重连撞上 503「无法完成登录握手」。必须插在 `#` 之前。
     */
    @Test
    fun withRetry_insertsBeforeFragment() {
        assertEquals(
            "https://pocket.example.com/?dsh-pocket-retry=1#k",
            RecoveryPlanner.withRetry("https://pocket.example.com/#k"),
        )
        assertEquals(
            "https://pocket.example.com/?token=x&dsh-pocket-retry=1#k",
            RecoveryPlanner.withRetry("https://pocket.example.com/?token=x#k"),
        )
    }

    @Test
    fun withRetry_handlesNullAndBlank() {
        assertNull(RecoveryPlanner.withRetry(null))
        assertNull(RecoveryPlanner.withRetry("   "))
    }
}
