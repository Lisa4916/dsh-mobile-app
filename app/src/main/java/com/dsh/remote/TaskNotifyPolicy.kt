package com.dsh.remote

/**
 * 「要不要弹任务完成通知」的决策。
 *
 * 输入只有两帧采样和三个环境量，没有任何 Android API —— 这样它能在纯 JVM 上跑单测。
 *
 * 设计取向：**宁可漏发，不可错发**。错发一次用户会直接关掉通知权限，
 * 之后真通知也看不到了；漏发的代价只是回到「自己切回 App 看一眼」。
 */
internal object TaskNotifyPolicy {

    /** 决策结果。 */
    enum class Action { NONE, NOTIFY }

    /**
     * 同一次回答的重复通知冷却窗。
     *
     * 为什么需要：真实回答中间会有工具调用间隙，页面短暂回到「不在生成」再回到「生成中」，
     * 于是会采到 true → false → true → false。没有冷却窗就会连发两三条。
     *
     * 为什么是 3 秒：实测一次中等长度的回答在 20~60 秒量级，3 秒远小于它，
     * 连续两个真实任务不会互相压制；同时足够盖住重渲染抖动。
     */
    const val COOLDOWN_MS = 3_000L

    /**
     * @param previous 上一次采样；为 null 表示这是本次连接的第一帧
     * @param current 本次采样；为 null 表示这次没采到（脚本报错 / 页面还在加载 / 半包）
     * @param appVisible App 是否在前台可见
     * @param lastNotifiedAt 上次发通知的时间戳；0 表示还没发过
     * @param now 当前时间戳
     */
    fun decide(
        previous: RunStateProbe.Snapshot?,
        current: RunStateProbe.Snapshot?,
        appVisible: Boolean,
        lastNotifiedAt: Long,
        now: Long,
    ): Action {
        // 第一帧没有「上一次」，不能凭空判定「刚刚完成」。
        if (previous == null) return Action.NONE
        // 这次没采到：既不能当完成，也不能清掉上一次的 running 状态。
        if (current == null) return Action.NONE
        // 必须是 running → 非 running 这一个方向。
        if (!previous.running || current.running) return Action.NONE
        // 用户正盯着屏幕，自己看得见，不需要再弹。
        if (appVisible) return Action.NONE
        if (lastNotifiedAt > 0L && now - lastNotifiedAt < COOLDOWN_MS) return Action.NONE
        return Action.NOTIFY
    }
}
