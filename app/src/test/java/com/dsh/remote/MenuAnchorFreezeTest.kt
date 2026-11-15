package com.dsh.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 「菜单滚动时原地不动」脚本的护栏测试。
 *
 * ## 为什么需要这组用例（第三次真机事故：滑动选择）
 *
 * 模型菜单能打开了，但在里面一滑就出事。CDP 实测（`ZY22GHMK5F` / WebView 126）：
 *
 * ```
 * 刚展开   portal style: left:12px; top:150.929px; --dsh-menu-anchor:--dsh-menu-r38
 *          portal rect:  top=151  bottom=519   ← 挂在触发按钮下方
 *
 * 滑一下   portal style: left:12px; top:12px;      --dsh-menu-anchor:--dsh-menu-r38  ← 变量没变
 *          portal rect:  top=12   bottom=380   ← 整块跳到屏幕顶端，上移 139px
 * ```
 *
 * 隔离实验证明和触摸无关：`menu.scrollTop = 800`（完全不碰屏幕）同样让它跳；
 * 而且**跳过去就不回来了** —— 滚回 `scrollTop=0` 之后 `top` 仍是 `12px`。
 * 触发按钮本身没动（`triggerTop=371` 全程不变），所以不是锚点在跟着走，
 * 是页面按「可用高度」重算了一次落点，算完还把它当成了新基准。
 *
 * 手感上就是「手指按住往上滑，菜单整块跳到顶上，手底下的内容瞬间换了一批」，
 * 紧接着点下去自然点到别的模型。
 *
 * ## 修法的边界（别改宽）
 *
 * 只冻结「弹层内部自己滚动」引起的 top 变化。页面正文滚动时菜单跟着内容走是对的，
 * 那不归我们管（脚本里对不在门户内的 scroll 直接 return）。锚点变量
 * （`--dsh-menu-anchor`）一变，说明换了菜单或触发按钮挪了位，此时以页面为准重新记基准。
 *
 * 这组用例读源码文本做断言（与 `FocusGuardScriptTest` 同一手法），因为逻辑住在
 * 注入的 JS 字符串里，没有可直接调用的 Kotlin 函数。
 */
class MenuAnchorFreezeTest {

    private fun source(): String {
        val candidates = listOf(
            File("src/main/java/com/dsh/remote/WebViewFactory.kt"),
            File("app/src/main/java/com/dsh/remote/WebViewFactory.kt"),
            File("../app/src/main/java/com/dsh/remote/WebViewFactory.kt"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error("找不到 WebViewFactory.kt，试过：${candidates.map { it.absolutePath }}")
        return file.readText()
    }

    /** 剥掉 Kotlin 注释，避免注释里的示例文字被当成活代码。 */
    private fun code(text: String): String = text.lineSequence()
        .filterNot { it.trimStart().startsWith("//") }
        .filterNot { it.trimStart().startsWith("*") }
        .filterNot { it.trimStart().startsWith("/*") }
        .joinToString("\n")

    /** 取出某个 JS 常量的字符串字面量内容（从 `const val X = """` 到收尾的 `"""`）。 */
    private fun jsConst(name: String): String {
        val text = code(source())
        val start = text.indexOf("const val $name")
        assertTrue("源码里找不到常量 $name", start >= 0)
        val open = text.indexOf("\"\"\"", start)
        assertTrue("常量 $name 不是三引号字符串", open >= 0)
        val close = text.indexOf("\"\"\"", open + 3)
        assertTrue("常量 $name 的三引号没有闭合", close > open)
        return text.substring(open + 3, close)
    }

    // --------------------------------------------------------------- 注入时机

    @Test
    fun freezeScriptIsRegisteredAtDocumentStart() {
        // 菜单是 portal，由 React 在点击时插进 body，随时可能出现在任何一次页面加载里。
        // 等到 onPageFinished 再注入，用户早期的第一次点击就已经吃过跳位了。
        val text = code(source())
        val install = text.substringAfter("private fun installHomeResetOnStart")
            .substringBefore("private fun ")
        assertTrue(
            "冻结脚本必须挂进 installHomeResetOnStart 的 document-start 注册里",
            install.contains("MENU_ANCHOR_FREEZE_JS"),
        )
        assertTrue(
            "注册时必须用 addDocumentStartJavaScript",
            install.contains("addDocumentStartJavaScript(wv, MENU_ANCHOR_FREEZE_JS"),
        )
    }

    // ------------------------------------------------------------ 只冻弹层内部

    @Test
    fun freezeOnlyListensToScrollingInsideThePortal() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 必须监听 scroll，且必须用 capture：scroll 不冒泡，只在捕获阶段能统一收到。
        assertTrue("必须监听 scroll 事件", js.contains("addEventListener('scroll'"))
        assertTrue("scroll 监听必须走捕获阶段", js.contains(", true)"))
        // 页面正文的滚动不能被拦：菜单跟着正文走是正确行为。
        assertTrue("不在门户内的滚动要直接放行", js.contains("return"))
        assertTrue("要判断滚动是否发生在门户内部", js.contains("parentElement"))
    }

    @Test
    fun freezeRecognizesPortalByAnchorVariable() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 门户的识别必须靠 --dsh-menu-anchor，这是它在页面里唯一的稳定标记；
        // 只认 role=group + body 直属还不够（侧栏也可能是这个形态）。
        assertTrue("必须读 --dsh-menu-anchor 变量", js.contains("--dsh-menu-anchor"))
        assertTrue("必须要求门户直接挂在 body 下", js.contains("document.body"))
        assertTrue("必须校验 role=group", js.contains("group"))
    }

    // ---------------------------------------------------------------- 冻结语义

    @Test
    fun freezeRemembersTheOriginalTopBeforeAnyScroll() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 基准必须是在「用户还没滑」的那一刻记下的 150.929px，
        // 而不是等页面重算成 12px 之后再记 —— 那等于把错误位置当正确答案。
        assertTrue("必须记下初始 top", js.contains("__dshFreezeTop"))
        assertTrue("必须记下当时的锚点变量", js.contains("__dshFreezeAnchor"))
    }

    @Test
    fun freezeRestoresTopWhenAnchorIsUnchanged() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 锚点没变 + top 变了 → 恢复。这两件事必须同时出现在同一处判断里。
        assertTrue("要比较锚点是否变化", js.contains("__dshFreezeAnchor"))
        assertTrue("要写回原 top", js.contains("style.top"))
        assertTrue("必须能读出当前 top", js.contains("style.top"))
    }

    @Test
    fun freezeGivesWayWhenTheAnchorChanges() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 换了菜单（或触发按钮挪位）时锚点变量会变，此时不能再拿旧 top 去写，
        // 否则新菜单会被钉在上一个菜单的位置上。
        assertTrue(
            "锚点变化时必须重新记基准而不是覆盖",
            js.contains("__dshFreezeAnchor =") || js.contains("__dshFreezeAnchor="),
        )
    }

    @Test
    fun freezeWindowIsBounded() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 页面重算 top 不是同步的（实测最长约 1s 才落地），所以要留一个时间窗；
        // 但窗口不能是无限的，否则用户拖动窗口/键盘弹出时菜单会被钉死。
        assertTrue("必须有一个有限的冻结时间窗", js.contains("GUARD_MS"))
        assertFalse("不能把窗口设成无限", js.contains("guardUntil = Infinity"))
    }

    @Test
    fun freezeDoesNotFightNonScrollLayoutChanges() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 只在「刚发生过门户内滚动」的窗口里才纠正，其它时候完全让页面自己排版。
        assertTrue("纠正动作必须在时间窗内才生效", js.contains("Date.now()"))
        assertTrue("必须有 guardUntil 这类截止时刻", js.contains("guardUntil"))
    }

    @Test
    fun freezeReleasesWhenThePortalWouldLeaveTheScreen() {
        val js = jsConst("MENU_ANCHOR_FREEZE_JS")
        // 钉住 top 只在「页面无缘无故往上翻」时是对的。触发按钮贴近底部、
        // 或键盘弹出把可视区压矮时，往上翻是页面的正确选择 —— 此时继续钉住
        // 会把菜单下半截顶到屏幕外，用户连选项都点不到。
        // 所以写回之后要量一次位置，一旦出界就松手，把排版权还给页面。
        assertTrue("写回之后必须量一次实际位置", js.contains("getBoundingClientRect()"))
        assertTrue("要用视口高度来判断出界", js.contains("innerHeight"))
        assertTrue("出界时必须清掉我们自己写的 top", js.contains("style.top = ''"))
        assertTrue("松手后要停止纠正", js.contains("guardEl = null"))
    }
}
