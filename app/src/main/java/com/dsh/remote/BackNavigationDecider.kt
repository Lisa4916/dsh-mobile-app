package com.dsh.remote

/**
 * 「返回键按下之后该做什么」的纯决策逻辑。
 *
 * 为什么单独抽出来：这段判断是本项目最容易出错的地方，而且**必须**能被测试覆盖。
 * Google 官方 testing-setup 明确写着「不要为 Activity 写单测」，正确做法是把逻辑挤出来
 * （同 HandshakeHealGate 的处理方式：纯 JVM 类 + 可注入参数）。
 *
 * 背景（真机实测，见知识库文档 04a55af4）：
 *  - 手势返回由 OnBackPressedDispatcher 派发，旧实现只写 onKeyDown 时对手势完全失效。
 *  - DSH 是纯 SPA，进会话前后 `location.href` 与 `history.length` **都不变**，
 *    所以 `webView.canGoBack()` 拿不到「会话」这一层，不能用它做层级判断。
 *  - 返回必须按进入顺序的逆序：会话页 → 开始界面 → 退出 App。
 *    末级是**退出**，不是回落到 App 自己的连接列表页（用户明确要求）。
 */
internal class BackNavigationDecider {

    /** 页面自报的三档位置。`other` 表示还没加载完或认不出。 */
    enum class PageLocation(val raw: String) {
        SESSION("session"),
        HOME("home"),
        OTHER("other"),
        ;

        companion object {
            /** 把 `DSH_LOCATION_JS` 的返回值规整成枚举；未知值一律当 OTHER。 */
            fun fromRaw(raw: String?): PageLocation {
                // evaluateJavascript 返回的是带引号的 JSON 字符串字面量，要去掉引号
                val v = raw?.trim()?.trim('"') ?: return OTHER
                return when (v) {
                    SESSION.raw -> SESSION
                    HOME.raw -> HOME
                    // 兜底：任何没见过的返回值都不能当成「正常」，否则会误退出
                    else -> OTHER
                }
            }
        }
    }

    /** 一次返回动作的三种可能结果。 */
    enum class Action {
        /** 有上一级：退回开始界面（轻量视图切换，不重载页面）。 */
        GO_TO_START,

        /** 已经到最外层：退出 App。 */
        EXIT_APP,

        /** 认不出位置：只把页面拉回开始界面当保险，先不退出。 */
        RECOVER_TO_START,
    }

    /** 本次会话内成功退回上一级的次数。用于 `other` 状态下避免反复转圈。 */
    private var backSteps = 0

    /** 记录一次「成功退回上一级」。 */
    fun noteWentBack() {
        backSteps += 1
    }

    /**
     * 决定这次返回该做什么。
     *
     * @param isWebViewVisible WebView 是否可见。停在连接列表页时为 false —— 那里就该直接退出。
     * @param location 页面自报的位置。
     */
    fun decide(isWebViewVisible: Boolean, location: PageLocation): Action = when {
        // 连接列表页：这是 App 自己的界面，没有「上一级」可言，直接退出
        !isWebViewVisible -> Action.EXIT_APP
        // 会话页 → 回开始界面
        location == PageLocation.SESSION -> Action.GO_TO_START
        // 已在开始界面 → 退出
        location == PageLocation.HOME -> Action.EXIT_APP
        // 认不出（还在加载）：已经退过一级就退出，避免卡在反复重载里；
        // 没退过则先把页面拉回开始界面兜底，不下判断
        backSteps > 0 -> Action.EXIT_APP
        else -> Action.RECOVER_TO_START
    }

    /** 当前累计退回次数（测试与日志用）。 */
    fun currentBackSteps(): Int = backSteps
}
