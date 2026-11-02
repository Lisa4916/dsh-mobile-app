package com.dsh.remote

/**
 * 局域网扫描扫到几台电脑之后，该拿它们怎么办 —— **纯 JVM 决策，可单测**。
 *
 * 存在的理由：扫描本身只是「这堆 IP 里哪几个在 3081 上答话」，
 * 而「答话之后是直接连、还是得先让用户输 PIN」是另一层判断，判错两种都不好用：
 *
 * - 明明手机里存着这台电脑的档案（带 PIN），却把用户扔回 PIN 页 —— 白扫一趟；
 * - 明明没有 PIN，却硬拼一个地址去连 —— 页面停在验证页，用户不知道下一步做什么。
 *
 * ## 三种结局
 *
 * 1. [LanAdoptPlan.Adopt]：手机里已经有一条能用的档案（同 IP，或 PIN 可以搬过去），
 *    直接把地址交给 WebView，用户看不到任何中间页。
 * 2. [LanAdoptPlan.AskPin]：扫到了电脑，但手机里没有它的 PIN。
 *    这时**不该**假装能连——打开它自己的验证页，让用户在页面里输 PIN 是最短路径：
 *    dsh-pocket 的验证页就是 `<form method="post" action="/pocket-login">`，
 *    输对之后它会下发 `dsh_pocket_token`，之后再来就靠 cookie 直进。
 * 3. [LanAdoptPlan.None]：一台都没扫到（或本机没连 Wi-Fi），落回连接列表。
 *
 * ## 为什么沿用 PIN 能成立
 *
 * PIN 是 dsh-pocket 进程级的（`~/.dsh/dsh-pocket/token-lan`），不随电脑 IP 变化。
 * 所以电脑换了 DHCP 地址时，「IP 换掉、PIN 照旧」是对这台电脑仍然有效的地址。
 * 这也意味着 **rebind 只能对同一台电脑做**；跨电脑沿用 PIN 是错的，
 * 但手机侧无法区分「同一台换了 IP」和「另一台恰好也在 3081 答话」，
 * 因此只对「已保存档案」做 rebind，且仅在**只有一台电脑应答**时启用 ——
 * 多台应答时一律 AskPin，宁可让用户多看一眼，也不要把人连到别的机器上。
 */
internal sealed interface LanAdoptPlan {
    /** 有可用档案：直接连。 */
    data class Adopt(val endpoint: Endpoint) : LanAdoptPlan

    /** 扫到了，但没有 PIN：打开它的验证页让用户输。 */
    data class AskPin(val url: String, val label: String) : LanAdoptPlan

    /** 没扫到。 */
    data object None : LanAdoptPlan
}

internal object LanAdopt {

    /**
     * @param saved 手机里已保存的连接（调用方应已按最近使用排好序）
     * @param foundHosts 扫描命中的主机地址（不含端口）
     * @param port 扫描用的端口，用来拼 [LanAdoptPlan.AskPin] 的地址
     */
    fun plan(
        saved: List<Endpoint>,
        foundHosts: List<String>,
        port: Int = LanScan.PORT,
    ): LanAdoptPlan {
        val hosts = foundHosts.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (hosts.isEmpty()) return LanAdoptPlan.None

        // ① 同 IP 命中：这台电脑我们本来就认识，直接连（保持原有 PIN 与端口）。
        for (endpoint in saved) {
            val host = endpoint.host ?: continue
            if (hosts.any { it.equals(host, ignoreCase = true) }) return LanAdoptPlan.Adopt(endpoint)
        }

        // ② 换 IP 命中：只在「恰好一台电脑答话」时把 PIN 搬过去。
        //    多台时搬 PIN 有可能连到别人家的机器上，宁可让用户输一次。
        if (hosts.size == 1) {
            val target = hosts.first()
            for (endpoint in saved) {
                val rebound = LanScan.rebind(endpoint, target) ?: continue
                return LanAdoptPlan.Adopt(rebound)
            }
        }

        // ③ 扫到了但没有可用 PIN：交给它自己的验证页。
        val host = hosts.first()
        return LanAdoptPlan.AskPin(url = "http://$host:$port/", label = host)
    }
}
