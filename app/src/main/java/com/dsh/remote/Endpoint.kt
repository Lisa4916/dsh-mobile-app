package com.dsh.remote

import android.content.Context
import java.net.URI

/**
 * 连接档案：一台电脑 = 一条记录。
 *
 * 只存关键三样：显示名、入口 URL（含 dsh-pocket 的 ?token=）、最近使用时间。
 * 不存任何凭据以外的派生状态——token 就在 URL 里，dsh-pocket 用它在代理层完成认证。
 *
 * 注意：解析一律走 java.net.URI，**不用 android.net.Uri**。
 * 单元测试跑在 android.jar stub 上，Uri 的方法体是 throw RuntimeException("Stub!")，
 * 用了就必然测不过——而这段解析逻辑恰恰最需要测试（错了的表现是「扫码成功但打不开」）。
 */
data class Endpoint(
    val id: String,
    val label: String,
    val url: String,
    val lastUsedAt: Long = 0L,
) {
    val host: String?
        get() = Endpoint.hostOf(url)

    companion object {
        /** 从扫码结果或手输文本里抽出可用的 HTTP(S) 地址。 */
        fun parseUri(raw: String?): String? {
            val s = raw?.trim().orEmpty()
            if (s.isEmpty()) return null
            if (!s.startsWith("http://") && !s.startsWith("https://")) return null
            return if (hostOf(s).isNullOrBlank()) null else s
        }

        /** 取 authority 里的主机名；解析失败返回 null 而不是抛异常。 */
        fun hostOf(url: String): String? = runCatching {
            URI(url).host
        }.getOrNull()
    }
}

/**
 * 连接档案的持久化。用 SharedPreferences 而不是数据库——
 * 条目是个位数量级，读写都在主线程一次完成，没有并发需求。
 */
class EndpointStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("dsh_endpoints", Context.MODE_PRIVATE)

    fun all(): List<Endpoint> {
        val raw = prefs.getString(KEY_LIST, null) ?: return emptyList()
        return deserialize(raw)
    }

    fun upsert(endpoint: Endpoint): List<Endpoint> {
        val current = all()
        val merged = current.filterNot { it.id == endpoint.id } + endpoint
        save(merged)
        return merged
    }

    fun touch(id: String): List<Endpoint> {
        val now = System.currentTimeMillis()
        val updated = all().map { if (it.id == id) it.copy(lastUsedAt = now) else it }
        save(updated)
        return updated
    }

    fun remove(id: String): List<Endpoint> {
        val updated = all().filterNot { it.id == id }
        save(updated)
        return updated
    }

    fun lastUsed(): Endpoint? = all().maxByOrNull { it.lastUsedAt }

    private fun save(list: List<Endpoint>) {
        prefs.edit().putString(KEY_LIST, serialize(list)).apply()
    }

    companion object {
        private const val KEY_LIST = "list"

        /** 行式序列化：id \t label \t url \t lastUsedAt，一行一条。标签里的制表符被替换掉。 */
        internal fun serialize(list: List<Endpoint>): String =
            list.joinToString("\n") { e ->
                listOf(
                    e.id.replace('\t', ' ').replace('\n', ' '),
                    e.label.replace('\t', ' ').replace('\n', ' '),
                    e.url.replace('\n', ' '),
                    e.lastUsedAt.toString(),
                ).joinToString("\t")
            }

        internal fun deserialize(raw: String): List<Endpoint> =
            raw.split('\n')
                .mapNotNull { line ->
                    val parts = line.split('\t')
                    if (parts.size < 4) return@mapNotNull null
                    val used = parts[3].toLongOrNull() ?: 0L
                    Endpoint(id = parts[0], label = parts[1], url = parts[2], lastUsedAt = used)
                }

        /** 生成稳定 id：同一台电脑同一入口重复扫码时命中同一条，不产生重复项。 */
        internal fun idFor(label: String, url: String): String =
            "${label.trim().lowercase()}|${url.trim()}".hashCode().toString()
    }
}
