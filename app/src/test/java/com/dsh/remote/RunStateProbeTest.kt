package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [RunStateProbe] 的解析测试。
 *
 * 这个类只做一件事：把 `evaluateJavascript` 拿回来的那串东西变成
 * 「页面到底还在不在生成」这一个布尔值。它必须**永不抛异常**——
 * 判错的代价是发一条假通知或漏一条真通知，而抛异常的代价是轮询线程直接死掉，
 * 之后再也不会有任何通知。
 */
class RunStateProbeTest {

    // ---- 正常形态 ----

    @Test
    fun parse_readsRunningTrue() {
        val snap = RunStateProbe.parse("\"{\\\"running\\\":true,\\\"title\\\":\\\"改个 bug\\\"}\"")
        assertEquals(true, snap?.running)
        assertEquals("改个 bug", snap?.title)
    }

    @Test
    fun parse_readsRunningFalse() {
        val snap = RunStateProbe.parse("\"{\\\"running\\\":false,\\\"title\\\":\\\"改个 bug\\\"}\"")
        assertEquals(false, snap?.running)
    }

    @Test
    fun parse_acceptsUnquotedJson() {
        // 有些路径（比如走 CDP 直接求值）拿到的不是 JSON 字符串字面量，而是裸 JSON。
        val snap = RunStateProbe.parse("{\"running\":true}")
        assertEquals(true, snap?.running)
    }

    @Test
    fun parse_toleratesSpacesInJson() {
        val snap = RunStateProbe.parse("{\"running\": true, \"title\": \"a\"}")
        assertEquals(true, snap?.running)
        assertEquals("a", snap?.title)
    }

    // ---- 必须容错的形态（这些才是真机上常见的） ----

    @Test
    fun parse_returnsNullForEmptyAndNull() {
        assertNull(RunStateProbe.parse(null))
        assertNull(RunStateProbe.parse(""))
        assertNull(RunStateProbe.parse("null"))
        assertNull(RunStateProbe.parse("\"\""))
    }

    @Test
    fun parse_returnsNullWhenJsThrew() {
        // 注入脚本自己 catch 住异常后返回空串，这里不能当 false 处理 ——
        // 把「不知道」当成「生成结束」会发一条假通知。
        assertNull(RunStateProbe.parse("\"\""))
    }

    @Test
    fun parse_returnsNullWhenRunningFieldMissing() {
        assertNull(RunStateProbe.parse("{\"title\":\"x\"}"))
        assertNull(RunStateProbe.parse("\"not json at all\""))
    }

    @Test
    fun parse_survivesTruncatedPayload() {
        // 页面正在被销毁时 evaluateJavascript 可能回一个半包。
        assertNull(RunStateProbe.parse("{\"running\":"))
        assertNull(RunStateProbe.parse("\"{\\\"runn"))
    }

    @Test
    fun parse_ignoresUnknownExtraFields() {
        val snap = RunStateProbe.parse("{\"running\":false,\"title\":\"t\",\"extra\":[1,2,3]}")
        assertEquals(false, snap?.running)
    }

    // ---- title 的边界 ----

    @Test
    fun parse_missingTitleIsNull() {
        val snap = RunStateProbe.parse("{\"running\":true}")
        assertEquals(true, snap?.running)
        assertNull(snap?.title)
    }

    @Test
    fun parse_titleWithEscapedQuoteIsNotTruncated() {
        val snap = RunStateProbe.parse("{\"running\":true,\"title\":\"a\\\"b\"}")
        assertEquals(true, snap?.running)
        assertEquals("a\"b", snap?.title)
    }

    @Test
    fun parse_titleWithEscapedBackslashStaysIntact() {
        val snap = RunStateProbe.parse("{\"running\":true,\"title\":\"a\\\\b\"}")
        assertEquals("a\\b", snap?.title)
    }

    @Test
    fun parse_titleWithUnicodeEscape() {
        val snap = RunStateProbe.parse("{\"running\":true,\"title\":\"\\u4f60\\u597d\"}")
        assertEquals("你好", snap?.title)
    }

    // ---- 注入脚本本身的自洽性 ----

    @Test
    fun jsScriptTargetsTheStopButtonLabel() {
        // 判据来源：页面在生成中时，输入框主按钮的 aria-label 会变成「停止生成」
        // （dsh-client-ui-conversation/lib/client.js:19208 `primaryLabel = primaryStops ? t("input.stop")`，
        // 中文文案 `"input.stop": "停止生成"` 在 client.js:16151，英文 `Stop generating` 在 16528）。
        // 没有这个按钮 = 不在生成。这比找「复制」按钮稳：复制按钮在流式过程中也会出现。
        assertTrue(RunStateProbe.JS.contains("停止生成"))
        assertTrue(RunStateProbe.JS.contains("Stop generating"))
    }

    @Test
    fun jsScriptReturnsEmptyStringOnError() {
        // 脚本必须自己兜住异常并回空串，不能把这些东西交给 WebView 的错误页机制。
        assertTrue(RunStateProbe.JS.contains("catch"))
        assertTrue(RunStateProbe.JS.contains("running"))
    }

    @Test
    fun jsScriptNeverThrowsOnNullOrMissingBody() {
        // 页面的 document.body 在 document-start 阶段可能还是 null；
        // 脚本里只查 document 级 API，不碰 body。
        assertFalse(RunStateProbe.JS.contains("document.body."))
    }

    // ---- 页面内轮询钩子 ----

    @Test
    fun hookInstallsTheBridgeNameItWasGiven() {
        val js = RunStateProbe.hookJs("DshNative")
        assertTrue(js.contains("window.DshNative"))
        assertTrue(js.contains("reportRunState"))
    }

    @Test
    fun hookIsIdempotentWithinOnePage() {
        // WebView 重建后页面会重新加载，但同一页面里 onPageFinished 可能被调多次，
        // 没有这个哨兵就会叠出好几个 setInterval。
        val js = RunStateProbe.hookJs("B")
        assertTrue(js.contains("__dshRunStateHooked"))
    }

    @Test
    fun hookOnlyReportsOnFlip() {
        // 状态没变就不发 —— 否则空闲页面每秒都会往原生打一次 IPC。
        val js = RunStateProbe.hookJs("B")
        assertTrue(js.contains("if (running === last) return;"))
    }

    @Test
    fun hookUsesTheSharedIntervalConstant() {
        val js = RunStateProbe.hookJs("B")
        assertTrue(js.contains("setInterval"))
        assertTrue(js.contains(RunStateProbe.POLL_INTERVAL_MS.toString()))
    }

    @Test
    fun hookAlsoCarriesBothStopLabelsThroughTheSharedDetector() {
        val js = RunStateProbe.hookJs("B")
        assertTrue(js.contains("停止生成"))
        assertTrue(js.contains("Stop generating"))
    }

    @Test
    fun hookDoesNotTouchDocumentBody() {
        assertFalse(RunStateProbe.hookJs("B").contains("document.body."))
    }
}
