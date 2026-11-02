package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 页面状态判据的测试（纯 JVM）。
 *
 * ## 为什么这个类值得写到这么细
 *
 * `PageProbe.classify` 的返回值直接决定**要不要删用户的 cookie**：
 *
 *  - 把「访问验证」页判成健康 → 地址里带着 `?token=` 也永远进不去，用户只能重装 App；
 *  - 把健康页判成故障 → cookie 被清、页面被重载，还弹一句莫名其妙的提示；
 *  - 把「正在进入」过渡页判成故障 → 握手还没完成就被打断，本来能进去的变成进不去。
 *
 * 项目已经为一次误判付过代价：旧版整段判据写在 JS 里，把「访问验证」判成 `'0'`，
 * 于是该故障永远不会自愈 —— 而且只能在真机上靠肉眼看出来。
 * 现在它是纯函数，改一行就有下面这些用例立刻指出对错。
 *
 * 页面文案取自 dsh-pocket 2.12 / dsh web 0.2.1-rc.5 的实测。
 */
class PageProbeTest {

    // --------------------------------------------------------- 正常页

    @Test
    fun mainInterface_isHealthy() {
        assertEquals("0", PageProbe.classify("DeepSeek Harness", "导出会话日志 探索未至之境 预览版"))
    }

    @Test
    fun mainInterfaceWins_evenWhenTitleLooksLikeFailurePage() {
        // 真机踩过：SPA 切页后 title 会滞后，还是上一次的失败页标题，正文早已是主界面。
        // 信标题就会无故清掉用户 cookie。
        assertEquals(
            "0",
            PageProbe.classify("DSH Pocket · 无法完成登录握手", "导出会话日志 默认工作区"),
        )
    }

    @Test
    fun mainInterfaceWins_overPinPageSignals() {
        // 主界面里可能有「访问密码」这几个字（比如设置入口），但主界面特征优先级最高
        assertEquals("0", PageProbe.classify("DeepSeek Harness", "探索未至之境 手机访问 访问密码"))
    }

    @Test
    fun openingTransition_isHealthy() {
        // 握手进行中，等它自己跳。打断它会把本来能进去的变成进不去。
        assertEquals("0", PageProbe.classify("DSH Pocket · 正在进入 | opening…", "正在进入…"))
    }

    // --------------------------------------------------------- 故障页

    @Test
    fun handshakeFailurePage_isBroken() {
        assertEquals("1", PageProbe.classify("DSH Pocket · 无法完成登录握手", "无法完成登录握手，请稍后重试"))
    }

    @Test
    fun upstreamUnauthorized_isBroken() {
        assertEquals("1", PageProbe.classify("", "dsh web authentication required"))
    }

    @Test
    fun blankBodyWithFailureTitle_isBroken() {
        // 正文还没渲染出来时，才退回用标题判断失败页
        assertEquals("1", PageProbe.classify("DSH Pocket · 无法完成登录握手", ""))
    }

    @Test
    fun failureBeatsPinSignals_whenBothPresent() {
        // 503 失败页里也可能提到密码，但它是「握手失败」而不是「要输密码」
        assertEquals(
            "1",
            PageProbe.classify("DSH Pocket · 无法完成登录握手", "无法完成登录握手 访问密码"),
        )
    }

    // ------------------------------------------------------- PIN 页

    @Test
    fun pinPageByBody_isPinRequired() {
        assertEquals(
            "2",
            PageProbe.classify("DSH Pocket · 访问验证", "此局域网地址受访问密码保护"),
        )
    }

    @Test
    fun pinPageByTitleOnly_isPinRequired() {
        // 这一页正文很短、渲染很快，标题「访问验证」是最稳定的特征
        assertEquals("2", PageProbe.classify("DSH Pocket · 访问验证", ""))
    }

    @Test
    fun pinPageByAccessPinLabel_isPinRequired() {
        assertEquals("2", PageProbe.classify("", "访问密码 | Access PIN"))
    }

    @Test
    fun pinPage_bodyWithoutTitle_isPinRequired() {
        assertEquals("2", PageProbe.classify("DSH Pocket", "此局域网地址受访问密码保护"))
    }

    // ------------------------------------------------------- 兜底

    @Test
    fun unknownPage_isHealthy() {
        // 拿不准一律不动手：误判成故障会删用户 cookie，代价远大于漏判
        assertEquals("0", PageProbe.classify("Something else", "某个不相干的页面"))
    }

    @Test
    fun nullAndEmptyInputs_areHealthy() {
        assertEquals("0", PageProbe.classify(null, null))
        assertEquals("0", PageProbe.classify("", ""))
        assertEquals("0", PageProbe.classify("   ", "   "))
    }

    @Test
    fun veryLongBody_doesNotThrowAndStillClassifies() {
        // 极端页面：正文几 MB。截断在 Kotlin 侧按 MAX_BODY_LENGTH 处理，
        // 且末尾特征不能被截掉导致漏判（先看头，再看全量都不做额外开销）。
        val huge = "填充".repeat(PageProbe.MAX_BODY_LENGTH) + "探索未至之境"
        assertEquals("0", PageProbe.classify("", huge))
        assertTrue(PageProbe.MAX_BODY_LENGTH > 0)
    }

    // ------------------------------------- evaluateJavascript 返回值还原

    @Test
    fun decodeJsString_plainUtf8() {
        // 真机实测：中文标题通常原样返回
        assertEquals("DSH Pocket · 访问验证", PageProbe.decodeJsString("\"DSH Pocket · 访问验证\""))
    }

    @Test
    fun decodeJsString_unicodeEscaped() {
        // 也可能是 \uXXXX 转义。还原不回来 → 中文判据静默失效 → 自愈永远不触发。
        assertEquals("访问验证", PageProbe.decodeJsString("\"\\u8bbf\\u95ee\\u9a8c\\u8bc1\""))
    }

    @Test
    fun decodeJsString_emptyAndNull() {
        assertEquals("", PageProbe.decodeJsString("\"\""))
        assertEquals("", PageProbe.decodeJsString("null"))
        assertEquals("", PageProbe.decodeJsString(null))
        assertEquals("", PageProbe.decodeJsString(""))
    }

    @Test
    fun decodeJsString_escapes() {
        assertEquals("a\nb", PageProbe.decodeJsString("\"a\\nb\""))
        assertEquals("a\tb", PageProbe.decodeJsString("\"a\\tb\""))
        assertEquals("a\"b", PageProbe.decodeJsString("\"a\\\"b\""))
        assertEquals("a\\b", PageProbe.decodeJsString("\"a\\\\b\""))
    }

    @Test
    fun decodeJsString_malformedEscape_keepsText() {
        // 缺位的 \u 不能吞字符 —— 宁可留原文，也不要静默丢内容
        assertTrue(PageProbe.decodeJsString("\"a\\u12\"").startsWith("a"))
        assertTrue(PageProbe.decodeJsString("\"a\\uZZZZ\"").startsWith("a"))
    }
}
