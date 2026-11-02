package com.dsh.remote

/**
 * 「这次加载到底是在慢慢加载，还是根本连不上」的判定。
 *
 * ## 为什么需要它
 *
 * WebView 的 [android.webkit.WebViewClient.onReceivedError] **不是万灵药**。
 * 实测（2026-11-03，Redmi 只插 4G、地址是内网 `192.168.50.58`）：
 *
 * - 手机里存着 `http://192.168.50.58:3081/?token=…`；
 * - 手机走流量，这个私网地址的 SYN 被运营商 / 系统直接丢弃，**不回 RST**；
 * - 于是 WebView 一直停在「正在加载」，`onReceivedError` 一次都不触发，
 *   `onPageFinished` 也不触发 —— 界面就是一块纯黑（WebView 背景 `#151517`），
 *   等 90 秒还是黑的，按返回键也只会在空白页上做无效的「回首页」。
 *
 * 用户看到的是一块死屏，连「连不上」这句话都拿不到。
 *
 * ## 判据怎么来的
 *
 * 只能用**进度条有没有动过**来区分：
 *
 * | 情形 | 实测进度 | 结论 |
 * |---|---|---|
 * | 私网地址被静默丢弃 | 一直是 0，90 秒不变 | 连不上 |
 * | 公网隧道首次加载 | 几百毫秒内就离开 0，8 秒内到 100 | 在加载 |
 * | 公网隧道很慢 | 会停在 30~60 但仍在变 | 在加载 |
 *
 * 所以 `maxProgress` 记录的是**本次加载达到过的最大值**，不是当前值 ——
 * 后面的进度回退（页面重定向、SPA 换路由）不该把已经动过的证据抹掉。
 */
internal object ConnectWatchdog {

    /**
     * 这么久连 1% 都没走过，就当作连不上。
     *
     * 取值依据：正常远程页面实测在 8 秒内必到 100；而私网被丢弃时 90 秒仍是 0。
     * 留 8 秒是为了慢网络（实测手机 4G ping 隧道域名 225ms、首屏 3~5 秒）。
     */
    const val FIRST_PROGRESS_LIMIT_MS = 8_000L

    /**
     * 进度动过但一直走不完的硬上限。
     *
     * 不能设更小：页面里还有 `document-start` 注入与自愈探测，实测首屏偶尔到 12 秒。
     * 也不能无限等：走不完就是走不完，让用户回到列表页自己换地址，比看着转圈强。
     */
    const val TOTAL_LIMIT_MS = 30_000L

    enum class Verdict {
        /** 继续等。 */
        KEEP_WAITING,

        /** 放弃这次加载，回落列表页并给出原因。 */
        GIVE_UP,
    }

    /**
     * @param elapsedMs 从 `loadUrl` 起算的毫秒数。
     * @param maxProgress 本次加载达到过的最大进度（0..100）。注意是**最大值**，见类注释。
     */
    fun verdict(elapsedMs: Long, maxProgress: Int): Verdict = when {
        // 一点都没动过：不是慢，是连不上。等满 8 秒就走。
        maxProgress <= 0 && elapsedMs >= FIRST_PROGRESS_LIMIT_MS -> Verdict.GIVE_UP
        // 动过但迟迟走不完：给到硬上限。
        elapsedMs >= TOTAL_LIMIT_MS -> Verdict.GIVE_UP
        else -> Verdict.KEEP_WAITING
    }

    /**
     * 这条地址在当前网络下是不是**必然连不上**。
     *
     * 有实测依据的确定结论：手机没连 Wi-Fi（只有移动数据）时去连一个私有网段地址，
     * SYN 会被直接丢弃、连 RST 都不回。这不是「可能慢」，是「一定不通」，
     * 没有任何理由再等 8 秒或 30 秒让用户盯着黑屏。
     *
     * 实测（2026-11-03，Redmi 只插 4G）：`maxProgress` 竟然到过 10，
     * 于是 `FIRST_PROGRESS_LIMIT_MS` 不触发，一路等满 30 秒才回落 —— 用户白等半分钟。
     *
     * @param url 正在加载的地址。
     * @param onLan 当前是否连着 Wi-Fi（`LanScan.localLanIpv4() != null`）。
     */
    fun hopeless(url: String?, onLan: Boolean): Boolean {
        if (onLan) return false
        val target = url ?: return false
        // 只对 http(s) 判：about:blank 之类不算。
        if (Endpoint.parseUri(target) == null) return false
        return Endpoint.kindOf(target) == Endpoint.Kind.LAN
    }

    /**
     * 给出「为什么回落到列表页」这句人话。
     *
     * 分两种说，因为用户要做的事完全不同：
     * - 内网地址：他多半是不在同一张网里（在外面用流量），该换公网地址；
     * - 公网地址：多半是电脑那边隧道断了或换地址了，该去电脑上看一眼。
     */
    fun giveUpMessage(url: String?): String {
        val kind = url?.let { Endpoint.kindOf(it) } ?: Endpoint.Kind.PUBLIC
        val host = url?.let { Endpoint.hostOf(it) }
        // host 可能解析不出来（地址畸形），这时不要往句子里塞一个 "null"。
        if (host == null) {
            return "连不上这台电脑。检查地址有没有写错，或去电脑上看一眼当前的手机访问地址"
        }
        return if (kind == Endpoint.Kind.PUBLIC) {
            "连不上这台电脑的隧道（$host）。地址可能已经变了，去电脑上看一眼当前地址再更新"
        } else {
            "连不上 $host：你当前没连 Wi-Fi。局域网地址只能在同一个 Wi-Fi 下用，" +
                "在外面要等电脑先开出公网隧道地址"
        }
    }
}
