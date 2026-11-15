package com.dsh.remote

/**
 * 前台服务保活的全部「想清楚」的部分。
 *
 * 为什么不把判断写在 Service 里：`Service` 的所有东西在单元测试里都是空桩
 * （本仓库零 Robolectric），一旦判断逻辑长在 Service 内部就再也测不到。
 * 所以这里只放纯函数，Service 只负责「照做」。
 *
 * 三个容易踩的坑，都在下面钉住：
 *  1. 停在列表页时不该起常驻通知（用户会觉得是骚扰）；
 *  2. `startForeground` 的 type 在 API 33 及以下必须传 0，传了非零值直接抛异常；
 *  3. Android 14 起 targetSdk >= 34 要求显式声明 type，不声明同样抛。
 */
internal object KeepAlivePolicy {

    /** 常驻通知的固定 ID。变了会变成两条通知叠在一起。 */
    const val NOTIFICATION_ID = 0x4453 // "DS"

    /** 通知渠道 ID。改了要连带删旧渠道，否则用户设过的静音会失效。 */
    const val CHANNEL_ID = "dsh-keepalive"

    /** 通知渠道名，出现在系统设置里。 */
    const val CHANNEL_NAME = "会话保持"

    /**
     * `ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE`。
     *
     * 刻意写死字面量而不 import：单元测试里的 `android.jar` 是空桩，
     * 常量虽会编译期内联，但少一个依赖少一份意外。
     *
     * 为什么选 specialUse 而不是 dataSync：Android 15 给 dataSync 加了每天 6 小时总额度，
     * 超时会被系统直接掐掉。而「保持一个常驻网页会话不掉线」本来就不是数据同步，
     * 被限时反而是 bug。
     */
    const val TYPE_SPECIAL_USE = 1 shl 30 // 1073741824

    /** 通知标题上限。锁屏上放不下长的。 */
    const val TITLE_LIMIT = 40

    /** 通知正文上限。 */
    const val TEXT_LIMIT = 80

    /** 页面标题缺失时的正文。 */
    const val STANDBY_TEXT = "会话保持中"

    /**
     * 当前的连接要不要保活。
     *
     * 只要有一个可用 endpoint 就该保活 —— 局域网、公网隧道、本机代理都算。
     * 停在列表页（current == null）时不起，省得用户每次开 App 都被一条通知迎接。
     */
    fun shouldKeep(endpoint: Endpoint?): Boolean = endpoint != null

    /**
     * 拼常驻通知的文案。
     *
     * **绝不把 URL 放进通知**：通知会出现在锁屏上，而 URL 可能带 `?token=`。
     * 标题取服务器 label（没有就退回 host），正文取页面标题（没有就退回固定文案）。
     */
    fun notice(endpoint: Endpoint, pageTitle: String?): Notice {
        val title = endpoint.label.trim().ifEmpty { endpoint.host ?: "DSH" }
        val text = pageTitle?.trim().takeUnless { it.isNullOrEmpty() } ?: STANDBY_TEXT
        return Notice(clip(title, TITLE_LIMIT), clip(text, TEXT_LIMIT))
    }

    /** 拼好的通知文案。 */
    data class Notice(val title: String, val text: String)

    /**
     * `startForeground(id, notification, type)` 要传的 type。
     *
     * API 33 及以下不认识这个参数，必须传 0；API 34 起必须是非零的已声明类型。
     * @param sdkInt `Build.VERSION.SDK_INT`
     */
    fun foregroundType(sdkInt: Int): Int = if (sdkInt >= 34) TYPE_SPECIAL_USE else 0

    /** 通知 ID。 */
    fun notificationId(): Int = NOTIFICATION_ID

    /**
     * 按**码点**截断，不是按 `length`。
     *
     * 中文和 emoji 在 Kotlin 里是 char 序列，直接 `substring` 可能把代理对劈成两半，
     * 显示成 ``。宁可少一个字也不要半个字。
     */
    private fun clip(s: String, limit: Int): String {
        if (s.length <= limit) return s
        var end = limit
        // 落在低代理位上就回退一格，保证不劈开代理对。
        if (end > 0 && Character.isLowSurrogate(s[end])) end--
        return s.substring(0, end)
    }
}
