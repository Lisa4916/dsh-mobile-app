package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 冷启动挑选规则的测试。
 *
 * 这段逻辑以前散在 `MainActivity.autoconnect()` 里，必须起 Activity 才能跑，
 * 于是它出过的 bug 全都靠用户反馈发现。两个具体教训：
 *  - 内置地址写死后换网段，App 拿一个连不上的地址反复重试，看起来像「网络故障」；
 *  - 一个连接都没保存、也没有内置地址时，如果直接 `loadUrl("")`，
 *    WebView 会停在空白页而不是列表页 —— 用户看到的是黑屏。
 */
class AutoConnectTest {

    private val now = 1_700_000_000_000L

    private val saved = Endpoint(
        id = "saved",
        label = "书房电脑",
        url = "http://192.168.1.9:3081/?token=12345678",
        lastUsedAt = 1_600_000_000_000L,
    )

    @Test
    fun decide_prefersLastUsedConnection() {
        val plan = AutoConnect.decide(saved, "http://10.0.0.2:3081/?token=99999999", now)
        assertTrue("用户选过什么就连什么", plan is AutoConnectPlan.Connect)
        assertEquals(saved, (plan as AutoConnectPlan.Connect).endpoint)
    }

    @Test
    fun decide_lastUsedWinsEvenWhenBuiltInUrlIsPresent() {
        // 内置地址只是首次启动的引导，永远不该盖掉用户已保存的选择
        val plan = AutoConnect.decide(saved, "http://127.0.0.1:3081/?token=1", now)
        assertEquals(saved, (plan as AutoConnectPlan.Connect).endpoint)
    }

    @Test
    fun decide_seedsFromBuiltInUrlWhenNothingSaved() {
        val plan = AutoConnect.decide(null, "http://192.168.1.9:3081/?token=12345678", now)
        assertTrue(plan is AutoConnectPlan.Seed)
        val ep = (plan as AutoConnectPlan.Seed).endpoint
        assertEquals("http://192.168.1.9:3081/?token=12345678", ep.url)
        assertEquals("192.168.1.9", ep.label)
        assertEquals(now, ep.lastUsedAt)
        assertEquals(EndpointStore.idFor(ep.label, ep.url), ep.id)
    }

    @Test
    fun decide_seedDerivesKindFromUrl() {
        // 落点标签决定列表里显示「局域网」还是「公网」，不能一律当成本机
        val lan = AutoConnect.decide(null, "http://192.168.1.9:3081/?token=1", now)
        assertEquals(Endpoint.Kind.LAN, (lan as AutoConnectPlan.Seed).endpoint.kind)

        val pub = AutoConnect.decide(null, "https://x.trycloudflare.com/?token=1", now)
        assertEquals(Endpoint.Kind.PUBLIC, (pub as AutoConnectPlan.Seed).endpoint.kind)
    }

    @Test
    fun decide_showListWhenNoBuiltInUrl() {
        // 没注入地址（CI 构建、或用户换了电脑）：停在列表走扫码引导，
        // **不要**凭空造一个连不上的地址
        assertEquals(AutoConnectPlan.ShowList, AutoConnect.decide(null, "", now))
        assertEquals(AutoConnectPlan.ShowList, AutoConnect.decide(null, null, now))
        assertEquals(AutoConnectPlan.ShowList, AutoConnect.decide(null, "   ", now))
    }

    @Test
    fun decide_showListWhenBuiltInUrlIsNotUsable() {
        // 拼坏的地址（比如忘了 scheme 又被截断）也要落到列表页，而不是 loadUrl 一个空串
        assertEquals(AutoConnectPlan.ShowList, AutoConnect.decide(null, "not a url", now))
        assertEquals(AutoConnectPlan.ShowList, AutoConnect.decide(null, "ftp://192.168.1.9/", now))
    }

    @Test
    fun decide_doesNotRewriteTheSeedUrl() {
        // 内置地址已经由 BootstrapUrl 拼好（含 ?token=），这里绝不能再动它
        val built = "http://192.168.1.9:3081/?token=12345678"
        val plan = AutoConnect.decide(null, built, now)
        assertEquals(built, (plan as AutoConnectPlan.Seed).endpoint.url)
    }
}
