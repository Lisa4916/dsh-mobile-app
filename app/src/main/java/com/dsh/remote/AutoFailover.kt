package com.dsh.remote

/**
 * 一个地址连不上时，接下来该试哪个。**纯 JVM，可单测。**
 *
 * ## 要解决的具体场景
 *
 * 手机里同时存着两条档案：
 * - `http://192.168.50.58:3081/?token=…`（局域网，在家才有用）
 * - `https://xxx.trycloudflare.com/?token=…`（公网隧道，走流量也能用）
 *
 * 而在家时局域网那条是 `lastUsed`，因为更近、更快。于是**出门之后冷启动必然先连局域网**，
 * 连不上，然后（修了守望之后）回落列表页 —— 用户还得自己认出「要换那条公网的」。
 * 用户的原话是「在外面连接使用手机网络，也没有 wifi 啊」，他要的是它自己换过去。
 *
 * ## 选取规则
 *
 * 1. **优先换一种网络**：当前是 `LAN` 就优先试 `PUBLIC`，反之亦然。
 *    这是核心 —— 同一个网络类型的另一条地址，失败原因大概率一样，试它只是多等一轮。
 * 2. 同类型里按 `lastUsedAt` 从新到旧。
 * 3. 已经试过的（[triedIds]）绝不重试，避免来回打转。
 *
 * 一条都不剩就返回 null，调用方回落列表页。
 */
internal object AutoFailover {

    /**
     * 启动时该先连哪一条。
     *
     * 为什么不能直接用 `lastUsed`：在家时局域网最快，所以它必然是 `lastUsed`；
     * 但**出门之后它还是 `lastUsed`**，于是每次冷启动都先花 8 秒去等一个
     * 只在局域网里有意义的地址（这台手机长期只插流量卡，天天如此）。
     *
     * 判据用「有没有 Wi-Fi」而不是「局域网连不连得上」：后者要真的拨一次才知道，
     * 那正是要避免的 8 秒；前者是本地信息，`LanScan.localLanIpv4()` 立刻就答。
     *
     * @param onLan 当前是否连着 Wi-Fi（`LanScan.localLanIpv4() != null`）。
     * @return 建议先连的那条；null 表示没有档案，交给 [AutoConnect] 走别的分支。
     */
    fun pickStart(all: List<Endpoint>, lastUsed: Endpoint?, onLan: Boolean): Endpoint? {
        if (lastUsed == null) return null
        // 有 Wi-Fi：本来就是最好的选择，不动。
        if (onLan) return lastUsed
        // 没 Wi-Fi（走流量）：局域网那条必然连不通，直接换成公网。
        if (lastUsed.kind == Endpoint.Kind.LAN) {
            return all.filter { it.kind == Endpoint.Kind.PUBLIC }
                .maxByOrNull { it.lastUsedAt }
            // 一条公网都没有时仍然返回 lastUsed —— 让它失败、由守望给出
            // 「局域网地址只能在同一个 Wi-Fi 下用」这句明确的话，
            // 比无声地停在列表页让用户猜要好。
                ?: lastUsed
        }
        return lastUsed
    }

    /**
     * @param all 全部已保存的连接（顺序无所谓，内部会排）。
     * @param current 刚刚连失败的那条；为 null 时按「没有偏好」处理。
     * @param triedIds 本次启动已经试过的 id 集合（含 [current]）。
     */
    fun next(all: List<Endpoint>, current: Endpoint?, triedIds: Set<String>): Endpoint? {
        val candidates = all.filter { it.id !in triedIds }
        if (candidates.isEmpty()) return null

        // 「换一种网络的」排在前面。current 为 null 时没有网络偏好，全部算同一档。
        val preferredKind = when (current?.kind) {
            Endpoint.Kind.LAN -> Endpoint.Kind.PUBLIC
            Endpoint.Kind.PUBLIC -> Endpoint.Kind.LAN
            else -> null
        }
        return candidates.sortedWith(
            compareByDescending<Endpoint> { preferredKind != null && it.kind == preferredKind }
                .thenByDescending { it.lastUsedAt },
        ).firstOrNull()
    }
}
