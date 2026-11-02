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
 *  - DSH 是纯 SPA，进会话前后 `location.href` 与 `history.length` **都不变**（都是 1~2），
 *    所以 `webView.canGoBack()` 拿不到任何一层，不能用它做层级判断。
 *  - 末级是**退出 App**，不是回落到 App 自己的连接列表页（用户明确要求）。
 *
 * ★ 2026-11 重写：用户要求「返回与进入严格互逆，不能少退也不能多退」。
 * 旧版只认三档（session / home / other），结果「首页 + 侧栏展开」按返回会**直接退出 App**
 * （实测 topResumedActivity 变成 launcher），这就是典型的「多退了一步」。
 * 现在把页面拆成七层，每层对应一个**只退这一层**的动作，按返回一次只走一格。
 */
internal class BackNavigationDecider {

    /**
     * 页面自报的位置，按「视觉上压在最上面」排序。
     *
     * 顺序不能乱：`PANEL` 盖在 `OVERLAY` 上，`OVERLAY` 盖在 `SIDEBAR` 上……
     * 反过来说 **返回时必须从上往下退**，所以 [decide] 的 when 分支顺序要跟这里一致。
     * 真机验证见 `tools/probe-layer.cjs`（7 种状态全部认对）。
     */
    enum class PageLocation(val raw: String) {
        /** 带「关闭xxx」按钮的浮层（会话知识库那种）。Escape 对它无效，必须点「关闭」。 */
        PANEL("panel"),

        /** 菜单 / 下拉 / 对话框。页面自己监听 Escape，交给它最省事。 */
        OVERLAY("overlay"),

        /** 左抽屉展开。收起态实测 left ≈ -209，展开态 0。 */
        SIDEBAR("sidebar"),

        /** 侧栏功能视图（插件 / 自动化任务 / XD Pool / Purge…）。靠 `[aria-current]` 认。 */
        FEATURE("feature"),

        /** 某个会话里（「对话」「轨迹」这对 tab 只有会话页有）。 */
        SESSION("session"),

        /** 首页（开始界面）。 */
        HOME("home"),

        /** 还没加载完或认不出。 */
        OTHER("other"),
        ;

        companion object {
            /** 把 `DSH_LOCATION_JS` 的返回值规整成枚举；未知值一律当 OTHER。 */
            fun fromRaw(raw: String?): PageLocation {
                // evaluateJavascript 返回的是带引号的 JSON 字符串字面量，要去掉引号
                val v = raw?.trim()?.trim('"') ?: return OTHER
                return entries.firstOrNull { it.raw == v } ?: OTHER
            }
        }
    }

    /** 一次返回动作的结果。除 [EXIT_APP] 外，每个动作都**只退一层**。 */
    enum class Action {
        /** 点浮层上的「关闭」按钮。 */
        CLOSE_PANEL,

        /** 给页面发 Escape —— 菜单、抽屉都自己认这个键。 */
        DISMISS_OVERLAY,

        /** 收起左抽屉。 */
        COLLAPSE_SIDEBAR,

        /** 从侧栏功能视图回首页。 */
        LEAVE_FEATURE,

        /** 会话页 → 首页（轻量视图切换，不重载页面）。 */
        GO_TO_START,

        /** 已经到最外层：退出 App。 */
        EXIT_APP,

        /** 认不出位置：只把页面拉回首页当保险，先不退出。 */
        RECOVER_TO_START,
    }

    /** 本次会话内成功退回上一级的次数。用于 `other` 状态下避免反复转圈。 */
    private var backSteps = 0

    /** 记录一次「成功退回上一级」。 */
    fun noteWentBack() {
        backSteps += 1
    }

    /**
     * 决定这次返回该做什么 —— **一次只退一层**。
     *
     * @param isWebViewVisible WebView 是否可见。停在连接列表页时为 false —— 那里就该直接退出。
     * @param location 页面自报的当前位置（最上面那一层）。
     *
     * 关键：`HOME` 才退出。只要上面还压着任何一层（面板/菜单/侧栏/功能视图/会话），
     * 就只退那一层 —— 这是「与进入严格互逆」的全部含义。
     */
    fun decide(isWebViewVisible: Boolean, location: PageLocation): Action = when {
        // 连接列表页：这是 App 自己的界面，没有「上一级」可言，直接退出
        !isWebViewVisible -> Action.EXIT_APP
        // 从最上面一层开始，一层一层往下退
        location == PageLocation.PANEL -> Action.CLOSE_PANEL
        location == PageLocation.OVERLAY -> Action.DISMISS_OVERLAY
        location == PageLocation.SIDEBAR -> Action.COLLAPSE_SIDEBAR
        location == PageLocation.FEATURE -> Action.LEAVE_FEATURE
        location == PageLocation.SESSION -> Action.GO_TO_START
        // 已在开始界面 → 退出（这是最外层）
        location == PageLocation.HOME -> Action.EXIT_APP
        // 认不出（还在加载）：已经退过一级就退出，避免卡在反复重载里；
        // 没退过则先把页面拉回首页兜底，不下判断
        backSteps > 0 -> Action.EXIT_APP
        else -> Action.RECOVER_TO_START
    }

    /** 当前累计退回次数（测试与日志用）。 */
    fun currentBackSteps(): Int = backSteps
}
