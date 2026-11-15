package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [KeepAlivePolicy] 的行为约束。
 *
 * 前台服务这块最容易出错的地方不是「怎么起」，而是三件小事：
 * 什么时候**不该**起、通知文案怎么拼、不同 API 级别的 `foregroundServiceType` 传什么。
 * 三件都能写成纯函数，就在这里钉住。
 */
class KeepAlivePolicyTest {

    private fun ep(url: String, label: String = "家里那台") =
        Endpoint(id = "x", label = label, url = url)

    // ---- 该不该保活 ----

    @Test
    fun keepsNothingWhenThereIsNoConnection() {
        // 停在列表页（没选服务器）时起一个常驻通知纯属骚扰。
        assertFalse(KeepAlivePolicy.shouldKeep(null))
    }

    @Test
    fun keepsWhileConnectedToLan() {
        assertTrue(KeepAlivePolicy.shouldKeep(ep("http://192.168.1.7:16969/")))
    }

    @Test
    fun keepsWhileConnectedToPublicAddress() {
        assertTrue(KeepAlivePolicy.shouldKeep(ep("https://abc-def-ghi.trycloudflare.com/")))
    }

    @Test
    fun keepsWhileConnectedToLoopback() {
        // 代理模式（手机自己跑 dsh-pocket）也是合法连接。
        assertTrue(KeepAlivePolicy.shouldKeep(ep("http://127.0.0.1:3081/")))
    }

    // ---- 通知文案 ----

    @Test
    fun noticeUsesServerLabelAsTitle() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/"), pageTitle = null)
        assertEquals("家里那台", n.title)
    }

    @Test
    fun noticeFallsBackToHostWhenLabelIsBlank() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/", label = "  "), null)
        assertEquals("192.168.1.7", n.title)
    }

    @Test
    fun noticeShowsPageTitleAsText() {
        // 通知正文放页面标题，用户一眼能看出「是哪个会话在跑」。
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/"), "改个 bug")
        assertEquals("改个 bug", n.text)
    }

    @Test
    fun noticeUsesStandbyTextWhenPageTitleMissing() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/"), null)
        assertTrue(n.text.isNotEmpty())
        assertEquals("会话保持中", n.text)
    }

    @Test
    fun noticeUsesStandbyTextWhenPageTitleIsBlank() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/"), "   ")
        assertEquals("会话保持中", n.text)
    }

    @Test
    fun noticeTruncatesOverlongPageTitle() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/"), "很".repeat(300))
        assertTrue(n.text.length <= KeepAlivePolicy.TEXT_LIMIT)
    }

    @Test
    fun noticeTruncatesOverlongLabel() {
        val n = KeepAlivePolicy.notice(ep("http://192.168.1.7:16969/", label = "长".repeat(300)), null)
        assertTrue(n.title.length <= KeepAlivePolicy.TITLE_LIMIT)
    }

    @Test
    fun noticeNeverLeaksTheFullUrl() {
        // 通知会出现在锁屏上。URL 里可能带 ?token=，绝不能进标题/正文。
        val url = "http://192.168.1.7:16969/?token=SECRET123"
        val n = KeepAlivePolicy.notice(ep(url, label = ""), "改个 bug")
        assertFalse(n.title.contains("SECRET"))
        assertFalse(n.text.contains("SECRET"))
        assertFalse(n.title.contains("token"))
    }

    // ---- foregroundServiceType ----

    @Test
    fun foregroundTypeIsZeroBelowAndroid14() {
        // API < 34 不认识 type 参数，必须传 0，否则 startForeground 直接抛。
        assertEquals(0, KeepAlivePolicy.foregroundType(24))
        assertEquals(0, KeepAlivePolicy.foregroundType(33))
    }

    @Test
    fun foregroundTypeIsSpecialUseOnAndroid14AndAbove() {
        // Android 14 起 targetSdk >= 34 必须显式声明类型。
        // 选 specialUse 而不是 dataSync：Android 15 给 dataSync 加了每天 6 小时的总额度，
        // 而「保持一个常驻网页会话」本来就不是数据同步，被限时反而是 bug。
        assertEquals(KeepAlivePolicy.TYPE_SPECIAL_USE, KeepAlivePolicy.foregroundType(34))
        assertEquals(KeepAlivePolicy.TYPE_SPECIAL_USE, KeepAlivePolicy.foregroundType(35))
        assertEquals(KeepAlivePolicy.TYPE_SPECIAL_USE, KeepAlivePolicy.foregroundType(36))
    }

    @Test
    fun specialUseTypeMatchesPlatformConstant() {
        // ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE == 1073741824 == 1 shl 30。
        // 这里刻意不 import ServiceInfo：单元测试里的 android.jar 是空桩，
        // 常量虽然是编译期内联、但少一个依赖少一份风险。
        assertEquals(1073741824, KeepAlivePolicy.TYPE_SPECIAL_USE)
    }

    // ---- 通知渠道 ----

    @Test
    fun keepAliveChannelIdIsStable() {
        // 渠道 ID 变了 = 新建一个渠道。用户上一版设过的「静音这个渠道」会失效，
        // 而且要连带删旧渠道，否则设置页里会留下没法清理的僵尸项。
        assertEquals("dsh-keepalive", KeepAlivePolicy.CHANNEL_ID)
    }

    @Test
    fun doneChannelIsSeparateFromKeepAliveChannel() {
        // 两个渠道必须分开：一个要能滑掉、要能响；一个必须常驻、必须静音。
        // 合成一个渠道的话，用户想留一个关一个就做不到。
        assertEquals(true, TaskNotifier.CHANNEL_DONE != KeepAlivePolicy.CHANNEL_ID)
    }

    @Test
    fun notificationIdIsStable() {
        // ID 变了会变成两条常驻通知叠在一起。
        assertEquals(KeepAlivePolicy.NOTIFICATION_ID, KeepAlivePolicy.notificationId())
    }

    @Test
    fun doneNotificationIdDiffersFromKeepAliveId() {
        // 同 ID 会让「回答完成」把常驻通知顶掉，用户就再也看不到会话还在保持。
        assertEquals(true, TaskNotifier.DONE_NOTIFICATION_ID != KeepAlivePolicy.NOTIFICATION_ID)
    }
}
