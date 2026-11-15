package com.dsh.remote

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 焦点守卫脚本的护栏测试。
 *
 * ## 为什么需要这组用例（真机事故）
 *
 * 手机端「模型选择」两级菜单永远打不开二级：一级菜单能弹出，点「模型」后
 * 二级菜单**确实被挂载过**（CDP MutationObserver 抓到 `+DOM role=menu aria-label="模型"`，
 * 内含 113 个 `[role=menuitemradio]`），但只存在几十毫秒就消失。
 *
 * 用 CDP 抓到的完整时序（`ZY22GHMK5F` / WebView 126.0.6478.71 / DSH web）：
 * ```
 * t=  305  pointerdown  @(313,541)   ← 点触发按钮
 * t=  367  +DOM role=menu al="模型与推理等级"
 * t= 1312  pointerdown  @(189,464)   ← 点「模型」项
 * t= 1436  focusout BUTTON._9r0rkG_trigger
 * t= 1438  focusin  INPUT._input_14sgc_25 [role=searchbox] aria-label="搜索模型…"
 * t= 1438  focusout INPUT._input_14sgc_25    ← 同一毫秒就失焦
 * t= 1450  +DOM role=menu al="模型" radios=113
 * ```
 * 而 `blur()` 的调用栈直接指向注入脚本的匿名函数：
 * ```
 * at HTMLInputElement.blur (<anonymous>:8:19)
 * at HTMLDocument.<anonymous> (<anonymous>:71:17)   ← FOCUS_GUARD_JS 里的 focusin 处理
 * ```
 *
 * 也就是说：**二级菜单自带一个搜索框（`role=searchbox`），React Aria 打开菜单时把焦点
 * 放进去；我们的焦点守卫认为「页面又自动聚焦输入框了」，立刻 `blur()` 掉；
 * React Aria 判定焦点离开菜单 → 把两级菜单一起关掉。**
 * 反证实验：CDP 里把 `HTMLInputElement.prototype.blur` 换成 no-op 之后，同样的两次
 * `input tap` 立刻得到 `menus:1, radios:113, active=INPUT|搜索模型…`，菜单稳住了。
 *
 * ## 修法的边界（别改宽）
 *
 * 焦点守卫要防的是「DSH 在会话页渲染完就把焦点抢到**底部输入框**上，用户什么都没点，
 * 键盘区已经让出 321px」。它**不该管弹层内部的输入框** —— 弹层是用户主动打开的，
 * 里面的搜索框拿到焦点正是这次操作的下一步，blur 它等于把菜单拆了。
 *
 * 所以判据加一条：焦点目标若位于 `[role=menu]` / `[role=listbox]` / `[role=dialog]`
 * / `[aria-modal="true"]` 之内，一律不拦。
 *
 * 这组用例读源码文本做断言（与 `BackNavigationDeciderTest` 一样是纯 JVM 可跑的），
 * 因为守卫逻辑住在注入的 JS 字符串里，没有可直接调用的 Kotlin 函数。
 */
class FocusGuardScriptTest {

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

    // ------------------------------------------------------- 焦点守卫必须放过弹层

    @Test
    fun focusGuard_knowsAboutOverlayContainers() {
        val js = jsConst("FOCUS_GUARD_JS")
        assertTrue(
            "焦点守卫必须能识别弹层容器，否则会把菜单搜索框当成「页面自动聚焦输入框」清掉",
            js.contains("role=menu") && js.contains("role=dialog"),
        )
    }

    @Test
    fun focusGuard_skipsFocusInsideMenu() {
        val js = jsConst("FOCUS_GUARD_JS")
        // focusin 处理函数里必须先判弹层再决定是否 blur
        assertTrue("弹层内的聚焦必须先短路返回", js.contains("inOverlay"))
        val guard = js.substringAfter("document.addEventListener('focusin'")
        assertTrue("focusin 处理函数体要先问 inOverlay", guard.contains("inOverlay"))
    }

    @Test
    fun forceBlurSweep_alsoSkipsOverlay() {
        // 兜底轮询走的是另一段 JS，只修一处等于没修：onPageFinished 之后
        // 200/500/900/1400ms 那四次求值同样会把菜单搜索框 blur 掉。
        val js = jsConst("FORCE_BLUR_IF_UNTOUCHED_JS")
        assertTrue("兜底失焦也必须放过弹层", js.contains("inOverlay"))
    }

    // ------------------------------------------------- 原有的键盘避让语义不能丢

    @Test
    fun focusGuard_stillRequiresRealTapOnTextField() {
        val js = jsConst("FOCUS_GUARD_JS")
        assertTrue("必须仍然要求「触摸点落在输入框矩形内」才发许可", js.contains("pointHitsTextField"))
        assertTrue("许可必须是一次性的、有时限的", js.contains("allowUntil"))
    }

    @Test
    fun focusGuard_stillBlursUnexpectedFocus() {
        val js = jsConst("FOCUS_GUARD_JS")
        assertTrue("非弹层、非用户点击引发的聚焦仍要回退", js.contains(".blur()"))
    }

    @Test
    fun forceBlurSweep_stillChecksRecentTap() {
        val js = jsConst("FORCE_BLUR_IF_UNTOUCHED_JS")
        assertTrue(
            "兜底失焦仍要看「最近 2 秒有没有点过输入框」",
            js.contains("__dshFocusGuardLastHit"),
        )
    }

    // --------------------------------------------------------- overlay 判据本身

    @Test
    fun overlayMatchCoversMenuRadioGroupAndModal() {
        val js = jsConst("FOCUS_GUARD_JS")
        listOf("menu", "listbox", "dialog").forEach { role ->
            assertTrue("overlay 判据要覆盖 role=$role", js.contains(role))
        }
        assertTrue("还要覆盖 [aria-modal=true]", js.contains("aria-modal"))
    }

    @Test
    fun overlayMatchWalksUpEnoughLevels() {
        val js = jsConst("FOCUS_GUARD_JS")
        // 菜单搜索框到 [role=menu] 之间隔着 input → div → div 若干层，
        // 遍历层数太少会漏判（实测祖先链至少 3 层）。
        assertFalse("遍历层数不能是 0", js.contains("i < 0"))
        assertTrue("必须向上遍历祖先节点", js.contains("parentElement"))
    }

    @Test
    fun overlayMatchIsSharedBetweenBothScripts() {
        // 两段 JS 各自持有一份判据会漂移（改一处忘另一处，就等于只修了一半）。
        val guard = jsConst("FOCUS_GUARD_JS")
        val sweep = jsConst("FORCE_BLUR_IF_UNTOUCHED_JS")
        assertTrue("守卫里要有 overlay 判据", guard.contains("role=menu") || guard.contains("'menu'"))
        assertTrue("兜底里要有 overlay 判据", sweep.contains("role=menu") || sweep.contains("'menu'"))
        // 判据的语义片段必须一致（同一串选择器文本）
        val selector = "[role=menu],[role=listbox],[role=dialog]"
        assertTrue("两段脚本必须用同一串选择器，避免漂移", guard.contains(selector) && sweep.contains(selector))
    }

    // ------------------------------------- 弹层门户与延迟复查（第二次真机事故）

    @Test
    fun overlayMatchRecognizesPortalGroupUnderBody() {
        // 实测祖先链：INPUT[role=searchbox] < SPAN < DIV < DIV[role=group] < BODY
        // 二级菜单在 focusin 那一刻还没进 DOM，链上根本没有 [role=menu]；
        // 唯一能认出来的浮层标记是「直挂 body 下的 role=group 门户」。
        val guard = jsConst("FOCUS_GUARD_JS")
        assertTrue(
            "必须能识别直挂 body 下的 role=group 弹层门户，否则搜索框被判成页面抢焦点",
            guard.contains("document.body") && guard.contains("role") && guard.contains("group"),
        )
    }

    @Test
    fun focusGuardRechecksBeforeBlurring() {
        // 病灶时序（探针实测）：focusin 在 t=8237，`+DOM role=menu` 在 t=8340。
        // 同步判定时菜单尚不存在，若当场 blur，React Aria 立刻把两级菜单收掉。
        // 所以必须延后一次再判：一帧后弹层已挂上，此时放行即可。
        val js = jsConst("FOCUS_GUARD_JS")
        val guard = js.substringAfter("document.addEventListener('focusin'")
        assertTrue(
            "blur 之前必须延后复查（requestAnimationFrame 或 setTimeout）",
            guard.contains("requestAnimationFrame") || guard.contains("setTimeout"),
        )
        assertTrue("延后后要重新问一次 inOverlay", guard.substringAfter("requestAnimationFrame").contains("inOverlay") ||
            guard.substringAfter("setTimeout").contains("inOverlay"))
    }
}
