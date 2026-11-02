package com.dsh.remote

import com.dsh.remote.BackNavigationDecider.Action
import com.dsh.remote.BackNavigationDecider.PageLocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 返回导航决策测试。
 *
 * 为什么必须有这一组：这是本项目返工最多的地方，而且是**用户能直接感知**的行为
 * （「点了返回却像退出重进」「退不到主界面」「多退了一步直接退出 App」）。
 * Google 官方 testing-setup 的 Step 10 明确要求导航测试覆盖
 * **back handling** 与 **exit through home with multiple backstacks**，这组用例就是它。
 *
 * ★ 2026-11 重写：用户要求「滑动返回必须与进入严格互逆，不能缺少步骤也不能多」，
 * 并追加「无论进入哪个功能项都应如此」。于是核心契约从「三档」变成「七层逐层退」：
 *  - **每一次返回只能退一层**，退完还要停在上一级，不许顺手跳回首页
 *  - **只有 HOME 才退出 App** —— 只要上面还压着任何一层就不许退到外面去
 *  - 会话页 → 首页、首页 → 退出这两条老契约不变
 *  - 认不出位置时不能贸然退出（还在加载）
 */
class BackNavigationDeciderTest {

    private fun decider() = BackNavigationDecider()

    // ------------------------------------------------------- 「一次只退一层」逐层覆盖

    @Test
    fun panel_closePanelOnly() {
        val d = decider()
        assertEquals(
            "带「关闭」按钮的浮层：只点关闭，不许同时把页面拉回首页",
            Action.CLOSE_PANEL,
            d.decide(isWebViewVisible = true, location = PageLocation.PANEL),
        )
    }

    @Test
    fun overlay_dismissOnly() {
        val d = decider()
        assertEquals(
            "菜单/下拉：只发 Escape，页面自己会收",
            Action.DISMISS_OVERLAY,
            d.decide(true, PageLocation.OVERLAY),
        )
    }

    @Test
    fun sidebar_collapseOnly_neverExit() {
        val d = decider()
        assertEquals(
            "侧栏展开时按返回只应收起侧栏 —— 旧版这里会直接退出 App，是用户报的「多退一步」",
            Action.COLLAPSE_SIDEBAR,
            d.decide(true, PageLocation.SIDEBAR),
        )
    }

    @Test
    fun feature_leaveFeatureOnly() {
        val d = decider()
        assertEquals(
            "侧栏功能视图（插件/自动化任务…）：回首页，不是退出",
            Action.LEAVE_FEATURE,
            d.decide(true, PageLocation.FEATURE),
        )
    }

    @Test
    fun session_goesToStart_notExit() {
        val d = decider()
        assertEquals(
            "会话页按返回应回首页，不能退出、不能刷新页面",
            Action.GO_TO_START,
            d.decide(isWebViewVisible = true, location = PageLocation.SESSION),
        )
    }

    @Test
    fun home_exitsApp_doesNotFallBackToList() {
        val d = decider()
        assertEquals(
            "已在首页，返回必须退出 App —— 用户明确要求不要回落到连接列表页",
            Action.EXIT_APP,
            d.decide(isWebViewVisible = true, location = PageLocation.HOME),
        )
    }

    // ------------------------------------------------------- 完整互逆链路

    @Test
    fun fullChain_panelOverlaySidebarFeatureSessionHome_exitsInExactReverse() {
        // 从最上面一层开始，逐层往下退，一次一格，最后才退出
        val d = decider()
        val chain = listOf(
            PageLocation.PANEL to Action.CLOSE_PANEL,
            PageLocation.OVERLAY to Action.DISMISS_OVERLAY,
            PageLocation.SIDEBAR to Action.COLLAPSE_SIDEBAR,
            PageLocation.FEATURE to Action.LEAVE_FEATURE,
            PageLocation.SESSION to Action.GO_TO_START,
            PageLocation.HOME to Action.EXIT_APP,
        )
        chain.forEachIndexed { i, (layer, expected) ->
            val got = d.decide(true, layer)
            assertEquals("第 ${i + 1} 层（$layer）退错", expected, got)
            if (expected != Action.EXIT_APP) d.noteWentBack()
        }
        assertEquals("六层退出五次", 5, d.currentBackSteps())
    }

    @Test
    fun everyNonHomeLayer_neverExits() {
        // 反向锁死：除了 HOME，任何一层都不许返回 EXIT_APP
        val d = decider()
        PageLocation.entries
            .filter { it != PageLocation.HOME && it != PageLocation.OTHER }
            .forEach { layer ->
                assertNotEquals("$layer 不该退出 App", Action.EXIT_APP, d.decide(true, layer))
            }
    }

    @Test
    fun everyLayer_isRepeatable_soHoldingBackDoesNotSkip() {
        // 连按两次返回、页面还没跟上（还是同一层）时，动作应当一样，不能越退越深
        val d = decider()
        PageLocation.entries
            .filter { it != PageLocation.OTHER }
            .forEach { layer ->
                val first = d.decide(true, layer)
                val second = d.decide(true, layer)
                assertEquals("$layer 第二次返回的动作应与第一次一致", first, second)
            }
    }

    @Test
    fun listPage_exitsImmediately() {
        val d = decider()
        assertEquals(
            "停在 App 自己的连接列表页时，那里没有上一级，应直接退出",
            Action.EXIT_APP,
            d.decide(isWebViewVisible = false, location = PageLocation.HOME),
        )
    }

    @Test
    fun listPage_exitsRegardlessOfLayer() {
        // WebView 不可见时页面层级信息不可信，一律退出
        val d = decider()
        PageLocation.entries.forEach {
            assertEquals("不可见时 $it 也应退出", Action.EXIT_APP, d.decide(false, it))
        }
    }

    // ------------------------------------------------------- 加载中 / 认不出

    @Test
    fun other_beforeAnyBack_recoversInsteadOfExiting() {
        val d = decider()
        assertEquals(
            "页面还在加载（认不出）且没退过级时，应先把页面拉回首页兜底，不能直接退出",
            Action.RECOVER_TO_START,
            d.decide(true, PageLocation.OTHER),
        )
    }

    @Test
    fun other_afterBackingOutOnce_exitsToAvoidLoop() {
        val d = decider()
        d.noteWentBack()
        assertEquals(
            "已经退过一级还认不出位置，说明卡在重载里，应退出而不是继续转圈",
            Action.EXIT_APP,
            d.decide(true, PageLocation.OTHER),
        )
    }

    // ------------------------------------------------------- 原始值解析

    @Test
    fun fromRaw_handlesQuotedJsonString() {
        // evaluateJavascript 回调给的是带引号的 JSON 字符串字面量
        assertEquals(PageLocation.SESSION, PageLocation.fromRaw("\"session\""))
        assertEquals(PageLocation.HOME, PageLocation.fromRaw("\"home\""))
        assertEquals(PageLocation.SIDEBAR, PageLocation.fromRaw("\"sidebar\""))
        assertEquals(PageLocation.PANEL, PageLocation.fromRaw("\"panel\""))
        assertEquals(PageLocation.OVERLAY, PageLocation.fromRaw("\"overlay\""))
        assertEquals(PageLocation.FEATURE, PageLocation.fromRaw("\"feature\""))
    }

    @Test
    fun fromRaw_handlesBareAndNullValues() {
        assertEquals(PageLocation.SESSION, PageLocation.fromRaw("session"))
        assertEquals(PageLocation.OTHER, PageLocation.fromRaw(null))
        assertEquals(PageLocation.OTHER, PageLocation.fromRaw(""))
    }

    @Test
    fun fromRaw_unknownValueIsOther_neverTreatedAsHome() {
        // 关键防呆：未知返回值若被当成 home，会导致误退出 App
        assertEquals(PageLocation.OTHER, PageLocation.fromRaw("\"loading\""))
        assertEquals(PageLocation.OTHER, PageLocation.fromRaw("\"err\""))
        assertEquals(PageLocation.OTHER, PageLocation.fromRaw("\"1\""))
    }

    @Test
    fun unknownLocation_doesNotCauseSilentExit() {
        val d = decider()
        val action = d.decide(true, PageLocation.fromRaw("\"whatever\""))
        assertEquals(
            "未知位置 + 未退过级，只能是 RECOVER，绝不能 EXIT",
            Action.RECOVER_TO_START,
            action,
        )
    }

    // ------------------------------------------------------- 状态计数

    @Test
    fun noteWentBack_accumulates() {
        val d = decider()
        assertEquals(0, d.currentBackSteps())
        d.noteWentBack()
        d.noteWentBack()
        assertEquals(2, d.currentBackSteps())
    }
}
