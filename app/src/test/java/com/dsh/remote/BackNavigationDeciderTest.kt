package com.dsh.remote

import com.dsh.remote.BackNavigationDecider.Action
import com.dsh.remote.BackNavigationDecider.PageLocation
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 返回导航决策测试。
 *
 * 为什么必须有这一组：这是本项目返工最多的地方，而且是**用户能直接感知**的行为
 * （「点了返回却像退出重进」「退不到主界面」）。
 * Google 官方 testing-setup 的 Step 10 明确要求导航测试覆盖
 * **back handling** 与 **exit through home with multiple backstacks**，这组用例就是它。
 *
 * 四条被锁死的语义：
 *  1. 会话页 → 回开始界面（不是刷新页面、不是退出）
 *  2. 开始界面 → 退出 App（不是回落连接列表）
 *  3. 连接列表页 → 直接退出（那里没有「上一级」）
 *  4. 认不出位置时不能贸然退出（还在加载）
 */
class BackNavigationDeciderTest {

    private fun decider() = BackNavigationDecider()

    // ---------------------------------------------------------------- 正常链路

    @Test
    fun session_goesToStart_notExit() {
        val d = decider()
        assertEquals(
            "会话页按返回应回开始界面，不能退出、不能刷新页面",
            Action.GO_TO_START,
            d.decide(isWebViewVisible = true, location = PageLocation.SESSION),
        )
    }

    @Test
    fun home_exitsApp_doesNotFallBackToList() {
        val d = decider()
        assertEquals(
            "已在开始界面，返回必须退出 App —— 用户明确要求不要回落到连接列表页",
            Action.EXIT_APP,
            d.decide(isWebViewVisible = true, location = PageLocation.HOME),
        )
    }

    @Test
    fun fullChain_followsReverseEntryOrder() {
        // 模拟完整链路：会话页 →（返回）→ 开始界面 →（返回）→ 退出
        val d = decider()

        assertEquals(Action.GO_TO_START, d.decide(true, PageLocation.SESSION))
        d.noteWentBack() // 这一步真的退回了一级

        assertEquals(Action.EXIT_APP, d.decide(true, PageLocation.HOME))
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

    // ---------------------------------------------------------------- 加载中 / 认不出

    @Test
    fun other_beforeAnyBack_recoversInsteadOfExiting() {
        val d = decider()
        assertEquals(
            "页面还在加载（认不出）且没退过级时，应先把页面拉回开始界面兜底，不能直接退出",
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

    // ---------------------------------------------------------------- 原始值解析

    @Test
    fun fromRaw_handlesQuotedJsonString() {
        // evaluateJavascript 回调给的是带引号的 JSON 字符串字面量
        assertEquals(PageLocation.SESSION, PageLocation.fromRaw("\"session\""))
        assertEquals(PageLocation.HOME, PageLocation.fromRaw("\"home\""))
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

    // ---------------------------------------------------------------- 状态计数

    @Test
    fun noteWentBack_accumulates() {
        val d = decider()
        assertEquals(0, d.currentBackSteps())
        d.noteWentBack()
        d.noteWentBack()
        assertEquals(2, d.currentBackSteps())
    }
}
