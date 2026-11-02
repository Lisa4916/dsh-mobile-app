package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ConnectWatchdog] 的判据测试。
 *
 * 这些数字全是真机上量出来的，不是拍的：
 * - 私网地址被静默丢弃：90 秒仍是 0% → 必须判 GIVE_UP；
 * - 公网隧道首屏：8 秒内到 100% → 必须判 KEEP_WAITING（早判就等于自己把能连的掐了）。
 */
class ConnectWatchdogTest {

    @Test
    fun verdict_keepsWaitingWhileProgressIsMoving() {
        // 进度动过，时间也还早 —— 这就是正常加载。
        assertEquals(ConnectWatchdog.Verdict.KEEP_WAITING, ConnectWatchdog.verdict(1_000L, 30))
        assertEquals(ConnectWatchdog.Verdict.KEEP_WAITING, ConnectWatchdog.verdict(7_999L, 1))
        assertEquals(ConnectWatchdog.Verdict.KEEP_WAITING, ConnectWatchdog.verdict(29_999L, 99))
    }

    @Test
    fun verdict_givesUpWhenProgressNeverLeavesZero() {
        // 这条是黑屏事故的正身：进度恒 0 且过了 8 秒。
        assertEquals(ConnectWatchdog.Verdict.GIVE_UP, ConnectWatchdog.verdict(8_000L, 0))
        assertEquals(ConnectWatchdog.Verdict.GIVE_UP, ConnectWatchdog.verdict(90_000L, 0))
    }

    @Test
    fun verdict_doesNotGiveUpBeforeTheFirstProgressLimit() {
        // 刚 loadUrl 完还是 0，这是正常的，不能马上判死。
        assertEquals(ConnectWatchdog.Verdict.KEEP_WAITING, ConnectWatchdog.verdict(0L, 0))
        assertEquals(ConnectWatchdog.Verdict.KEEP_WAITING, ConnectWatchdog.verdict(7_999L, 0))
    }

    @Test
    fun verdict_givesUpAtTotalLimitEvenIfProgressMoved() {
        // 动过但永远走不完：到硬上限就放手。
        assertEquals(ConnectWatchdog.Verdict.GIVE_UP, ConnectWatchdog.verdict(30_000L, 55))
    }

    @Test
    fun verdict_finishedPageIsNotJudgedHere() {
        // 100% 之后由 onPageFinished 收尾；这里只判「还没走完」的情况。
        // 记录一条约束：到了 100 但 onPageFinished 没来，硬上限照样兜住。
        assertEquals(ConnectWatchdog.Verdict.GIVE_UP, ConnectWatchdog.verdict(30_000L, 100))
    }

    @Test
    fun firstProgressLimitIsLongerThanRealRemoteFirstPaint() {
        // 实测量级：公网隧道首屏 3~5 秒，最慢一次 12 秒（含 document-start 注入与自愈探测）。
        // 8 秒是「至少要走 1%」的门槛，不是「必须画完」的门槛，所以可以比 12 秒小。
        assertTrue(ConnectWatchdog.FIRST_PROGRESS_LIMIT_MS in 5_000L..15_000L)
        assertTrue(ConnectWatchdog.TOTAL_LIMIT_MS > ConnectWatchdog.FIRST_PROGRESS_LIMIT_MS)
    }

    @Test
    fun message_forLanAddressTellsUserToSwitchToTunnel() {
        val msg = ConnectWatchdog.giveUpMessage("http://192.168.50.58:3081/?token=12345678")
        assertTrue(msg.contains("192.168.50.58"))
        assertTrue(msg.contains("同一个 Wi-Fi"))
        assertTrue(msg.contains("公网隧道"))
    }

    @Test
    fun message_forPublicAddressBlamesTheTunnel() {
        val msg = ConnectWatchdog.giveUpMessage("https://abc-xyz.trycloudflare.com/?token=87654321")
        assertTrue(msg.contains("abc-xyz.trycloudflare.com"))
        assertTrue(msg.contains("隧道"))
        assertTrue(msg.contains("变"))
    }

    @Test
    fun message_handlesNullUrlWithoutCrashing() {
        val msg = ConnectWatchdog.giveUpMessage(null)
        assertTrue(msg.isNotEmpty())
        assertFalse(msg.contains("null"))
    }

    // ---- hopeless：没 Wi-Fi 去连私有网段 = 一定不通 ----

    @Test
    fun hopeless_lanUrlWithoutWifi() {
        // 实测这条路上 maxProgress 竟然到过 10，8 秒判据不触发，白等 30 秒。
        assertTrue(ConnectWatchdog.hopeless("http://192.168.50.58:3081/?token=12345678", onLan = false))
    }

    @Test
    fun hopeless_lanUrlWithWifiIsWorthTrying() {
        // 有 Wi-Fi 时局域网是最快的路径，绝不能提前判死。
        assertFalse(ConnectWatchdog.hopeless("http://192.168.50.58:3081/?token=12345678", onLan = true))
    }

    @Test
    fun hopeless_publicUrlWithoutWifiIsNotHopeless() {
        // 公网地址正是走流量时该用的那条 —— 它慢也要等，不能提前掐。
        assertFalse(
            ConnectWatchdog.hopeless("https://x.trycloudflare.com/?token=87654321", onLan = false),
        )
    }

    @Test
    fun hopeless_ignoresNonWebUrls() {
        assertFalse(ConnectWatchdog.hopeless("about:blank", onLan = false))
        assertFalse(ConnectWatchdog.hopeless(null, onLan = false))
        assertFalse(ConnectWatchdog.hopeless("", onLan = false))
    }

    @Test
    fun hopeless_loopbackIsNotTreatedAsLan() {
        assertFalse(ConnectWatchdog.hopeless("http://127.0.0.1:3081/", onLan = false))
    }

    @Test
    fun giveUpMessage_forLanUrlMentionsWifi() {
        // 用户在外面时最需要的是一句能指导下一步的话，而不是「连接失败」四个字。
        val msg = ConnectWatchdog.giveUpMessage("http://192.168.50.58:3081/?token=12345678")
        assertTrue(msg.contains("Wi-Fi"))
        assertFalse(msg.contains("null"))
    }
}
