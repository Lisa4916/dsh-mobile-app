package com.dsh.remote

import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 在**真 WebView** 里验证「取值」这一半：`PageProbe.JS_TITLE` / `PageProbe.JS_BODY`
 * 加上 `PageProbe.decodeJsString`，能不能把页面标题与正文原样取回 Kotlin。
 *
 * ## 为什么只有这一半需要真机
 *
 * 判据本体（`PageProbe.classify`）是纯函数，`test/PageProbeTest` 已经把全部页面形态
 * 钉住了，不必上真机。真正只有真 WebView 才能回答的是这些：
 *
 *  - `evaluateJavascript` 对中文标题返回的是原样 UTF-8 还是 `\uXXXX` 转义；
 *  - 对没设标题的页面返回 `""` 还是 `null`；
 *  - `innerText` 是否跳过 `display:none` 的元素（判据依赖这一点）；
 *  - SPA 反复改标题后，取回的值是否跟着变；
 *  - 跨文档加载后旧值不会漏过来。
 *
 * 这几条任何一条与预期不同，中文判据就会静默失效：`classify` 拿到转义文本什么都匹配
 * 不上，最终返回 `"0"`（不动手）—— 看起来"没出错"，实际上自愈永远不触发。
 *
 * ## 不联网
 *
 * 全部用 `loadDataWithBaseURL` 灌本地 HTML，不依赖 dsh-pocket 是否开着，
 * 因此 CI 的模拟器里也能跑。
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class PageProbeJsTest {

    /**
     * 在真 WebView 里加载 [html]，可选先用 JS 设置 [jsTitle]，然后分别求值取标题与正文。
     *
     * **标题为什么用 JS 设而不是写在 `<title>` 里**：实测 `loadDataWithBaseURL` 加载的
     * 文档上 `document.title` 读回空串（标签里的 `<title>` 不生效）。而 DSH 前端本身就是
     * SPA —— 页面切换后由 JS 改 `document.title`。用 `document.title = ...` 既能绕开这个
     * WebView 怪癖，又正好是真实场景里标题的产生方式。
     */
    private fun load(html: String, jsTitle: String? = null): Pair<String, String> {
        val done = CountDownLatch(1)
        var titleOut = "<no result>"
        var bodyOut = "<no result>"

        val instr = InstrumentationRegistry.getInstrumentation()
        instr.runOnMainSync {
            val webView = WebView(ApplicationProvider.getApplicationContext())
            webView.settings.javaScriptEnabled = true
            webView.settings.domStorageEnabled = true

            webView.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    val readBoth = {
                        view?.evaluateJavascript(PageProbe.JS_TITLE) { rawTitle ->
                            titleOut = rawTitle ?: "<null>"
                            view.evaluateJavascript(PageProbe.JS_BODY) { rawBody ->
                                bodyOut = rawBody ?: "<null>"
                                done.countDown()
                            }
                        }
                    }
                    if (jsTitle == null) {
                        readBoth()
                    } else {
                        // 用 JSON 编码传标题，避免引号/中文手工转义出错
                        val literal = buildString {
                            append('"')
                            jsTitle.forEach { c ->
                                when (c) {
                                    '"' -> append("\\\"")
                                    '\\' -> append("\\\\")
                                    '\n' -> append("\\n")
                                    else -> append(c)
                                }
                            }
                            append('"')
                        }
                        view?.evaluateJavascript("document.title = $literal") { readBoth() }
                    }
                }
            }
            webView.loadDataWithBaseURL(
                "http://127.0.0.1/",
                "<html><body>$html</body></html>",
                "text/html",
                "UTF-8",
                null,
            )

            // WebView 必须在主线程销毁；给求值留足时间后收掉
            webView.postDelayed({ webView.destroy() }, 10_000L)
        }

        assertTrue("WebView 求值超时（15s）—— 取值链路卡住了", done.await(15, TimeUnit.SECONDS))
        return PageProbe.decodeJsString(titleOut) to PageProbe.decodeJsString(bodyOut)
    }

    @Test
    fun titleRoundTrip_keepsChineseAndMiddleDot() {
        // 标题里的「·」是 U+00B7。它在 evaluateJavascript 的 JSON 编码里可能被转义，
        // 若还原不回来，「DSH Pocket · 访问验证」就永远匹配不上。
        val (title, _) = load("<div>x</div>", jsTitle = "DSH Pocket · 访问验证")
        assertEquals("DSH Pocket · 访问验证", title)
    }

    @Test
    fun bodyRoundTrip_keepsChinese() {
        val (_, body) = load("<div>此局域网地址受访问密码保护</div>")
        assertTrue("正文应取回原始中文，实际：$body", body.contains("此局域网地址受访问密码保护"))
    }

    @Test
    fun emptyTitle_decodesToEmptyString() {
        // 没设 <title> 时求值结果可能是 "" 或 null，两种都必须还原成空串而不是字面量 "null"
        val (title, _) = load("<div>x</div>")
        assertEquals("", title)
        assertFalse("不能把 null 当成字符串保留", title.contains("null"))
    }

    @Test
    fun innerText_skipsHiddenElements() {
        // 判据靠这一点区分「页面里藏着的旧告警」与「真的故障页」。
        // 若 innerText 把 display:none 的内容也返回，健康页会被误判成 PIN 页，
        // 进而清掉用户的 dsh_pocket_token。
        val (_, body) = load(
            "<div style='display:none'>访问密码</div><div>随便什么页面</div>",
        )
        assertFalse("innerText 必须跳过 display:none 的文案，实际：$body", body.contains("访问密码"))
        assertTrue(body.contains("随便什么页面"))
    }

    @Test
    fun bodyOfHeavyPage_isCappedByClassifyNotByJs() {
        // 极端页面：正文很长。JS 不该被截断（截断要在 Kotlin 侧可控位置做），
        // 但 classify 会按 MAX_BODY_LENGTH 处理。这里只确认取值本身不丢内容。
        val filler = "填充".repeat(500)
        val (_, body) = load("<div>$filler</div><div>探索未至之境</div>")
        assertTrue("正文末尾的特征不能丢", body.contains("探索未至之境"))
        assertTrue(body.length > 500)
    }

    @Test
    fun probeOnRealPageShapes_classifiesAsExpected() {
        // 端到端：取值 + 判状态。这六条是最常见的页面形态，
        // 它们放在 instrumented 里是因为要顺带验证「取值是否失真」——
        // 纯 JVM 侧已用同样的文案覆盖过 classify 本身。
        val cases = listOf(
            Triple("<div>导出会话日志</div><div>探索未至之境</div>", "", "0"),
            Triple("<div>正在进入…</div>", "DSH Pocket · 正在进入 | opening…", "0"),
            Triple("<div>无法完成登录握手，请稍后重试</div>", "DSH Pocket · 无法完成登录握手", "1"),
            Triple("<pre>dsh web authentication required</pre>", "", "1"),
            Triple("<div>此局域网地址受访问密码保护</div>", "DSH Pocket · 访问验证", "2"),
            Triple("<div>某个不相干的页面</div>", "Something else", "0"),
        )
        for ((html, title, expected) in cases) {
            val (t, b) = load(html, jsTitle = title.ifEmpty { null })
            assertEquals("页面 [$title] 判定错误（取值 title=$t）", expected, PageProbe.classify(t, b))
        }
    }

    @Test
    fun aboutBlank_returnsEmptyBodyWithoutThrowing() {
        // 清错误页时页面就是 about:blank，body 可能为 null —— 判据的取值分支不能崩
        val done = CountDownLatch(1)
        var bodyOut = "<no result>"
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val webView = WebView(ApplicationProvider.getApplicationContext())
            webView.settings.javaScriptEnabled = true
            webView.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    view?.evaluateJavascript(PageProbe.JS_BODY) { raw ->
                        bodyOut = raw ?: "<null>"
                        done.countDown()
                    }
                }
            }
            webView.loadUrl("about:blank")
            webView.postDelayed({ webView.destroy() }, 10_000L)
        }
        assertTrue(done.await(15, TimeUnit.SECONDS))
        assertEquals("", PageProbe.decodeJsString(bodyOut))
        assertEquals("about:blank 必须判成不动手", "0", PageProbe.classify("", PageProbe.decodeJsString(bodyOut)))
    }
}
