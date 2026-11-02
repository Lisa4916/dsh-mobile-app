package com.dsh.remote

/**
 * 连接档案仓库 —— 让 `MainActivity` 不再直接抱 `SharedPreferences`。
 *
 * 抽出来的直接收益是可测性：`MobileActivity` 里原来的 `autoconnect()` 混合了
 * 「挑哪一条」和「建不建档」两件事，没有 `Context` 就测不了。现在挑选逻辑
 * 收进 [AutoConnect.decide]（纯函数），仓库只管存取。
 *
 * 保持极窄：只有 App 真正用到的五个操作。**不做**缓存、**不做**异步 ——
 * 条目是个位数量级，一次读写就是几毫秒，加缓存只会引入「界面与磁盘不一致」的新问题。
 */
internal interface ConnectionRepository {
    fun all(): List<Endpoint>
    fun lastUsed(): Endpoint?
    fun upsert(endpoint: Endpoint): List<Endpoint>
    fun touch(id: String): List<Endpoint>
    fun remove(id: String): List<Endpoint>
}

/** 生产实现：包一层 [EndpointStore]，语义与原来完全一致。 */
internal class SharedPrefsConnectionRepository(private val store: EndpointStore) : ConnectionRepository {
    override fun all(): List<Endpoint> = store.all()
    override fun lastUsed(): Endpoint? = store.lastUsed()
    override fun upsert(endpoint: Endpoint): List<Endpoint> = store.upsert(endpoint)
    override fun touch(id: String): List<Endpoint> = store.touch(id)
    override fun remove(id: String): List<Endpoint> = store.remove(id)
}

/** 冷启动该连哪一条。 */
internal sealed interface AutoConnectPlan {
    /** 直接连这条（不新建档案）。 */
    data class Connect(val endpoint: Endpoint) : AutoConnectPlan

    /** 用内置地址新建一条档案再连。 */
    data class Seed(val endpoint: Endpoint) : AutoConnectPlan

    /** 没有可用的入口：停在连接列表，走扫码 / 手输引导。 */
    data object ShowList : AutoConnectPlan
}

/**
 * 冷启动的挑选规则。**纯函数**，因为这里曾经出过一个很难查的坑：
 * 内置地址写死时，换网段后 App 会拿一个连不上的地址反复重试，用户以为是网络故障。
 * 现在规则显式写出来、用单测钉住。
 */
internal object AutoConnect {
    /**
     * @param lastUsed 上次使用的连接，没有则 null。
     * @param defaultUrl 构建时注入并拼好的地址；没注入时是空串。
     * @param now 建新档案时用的时间戳（注入以便断言）。
     */
    fun decide(lastUsed: Endpoint?, defaultUrl: String?, now: Long): AutoConnectPlan {
        // 用户选过什么就连什么。**不要**在这里做「局域网连不上就换公网」之类的
        // 聪明判断：那需要先探测，会把冷启动拖慢几秒，而且失败时更难解释。
        if (lastUsed != null) return AutoConnectPlan.Connect(lastUsed)

        val url = Endpoint.parseUri(defaultUrl)
            ?: return AutoConnectPlan.ShowList
        val label = Endpoint.hostOf(url) ?: "电脑"
        val endpoint = Endpoint(
            id = EndpointStore.idFor(label, url),
            label = label,
            url = url,
            lastUsedAt = now,
        )
        return AutoConnectPlan.Seed(endpoint)
    }
}
