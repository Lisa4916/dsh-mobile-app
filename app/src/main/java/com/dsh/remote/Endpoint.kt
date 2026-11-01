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
    /**
     * 入口落点：局域网 / 公网隧道 / 本机回环。
     *
     * 默认值由 url 推断，所以所有老的构造点（`Endpoint(id, label, url)`）不用改，
     * 拿到的 kind 就已经是对的。
     */
    val kind: Kind = kindOf(url),
) {
    val host: String?
        get() = Endpoint.hostOf(url)

    /** 公网入口：换 Wi-Fi、切 4G 都该用这条；局域网入口只在家里那条路由下有效。 */
    val isPublic: Boolean
        get() = kind == Kind.PUBLIC

    /**
     * 公网入口的一个现实约束：quick tunnel 的域名每次重开隧道都会变。
     * 界面上要提示用户「换了地址得重新扫码」，否则他会在列表里反复点一条死链接。
     */
    val urlIsVolatile: Boolean
        get() = kind == Kind.PUBLIC && host?.endsWith(".trycloudflare.com") == true

    enum class Kind {
        /** 127.0.0.0/8、::1、localhost —— 手机自己，实际只有调试用得上。 */
        LOOPBACK,

        /** 10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10。 */
        LAN,

        /** 其它一切：公网隧道、公网 IP、自有域名。 */
        PUBLIC,
    }

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

        /** 由 URL 推断入口类型。host 解析不出来时按 PUBLIC 处理（宁可提示成公网，也不要谎称局域网）。 */
        fun kindOf(url: String): Kind {
            val host = hostOf(url) ?: return Kind.PUBLIC
            return when {
                isLoopbackHost(host) -> Kind.LOOPBACK
                isPrivateHost(host) -> Kind.LAN
                else -> Kind.PUBLIC
            }
        }

        fun isLoopbackHost(host: String?): Boolean {
            val h = normalizeHost(host) ?: return false
            if (h == "localhost" || h.endsWith(".localhost")) return true
            if (h == "::1" || h == "0:0:0:0:0:0:0:1") return true
            val v4 = parseIpv4(h) ?: return false
            return v4[0] == 127
        }

        /**
         * 私有网段判定。**CGNAT 100.64/10 不算私有**——那是运营商给手机分配的地址，
         * 手机在 4G 下拿到它的时候，局域网入口根本连不上家里那台电脑。
         */
        fun isPrivateHost(host: String?): Boolean {
            val h = normalizeHost(host) ?: return false
            if (h.contains(':')) return isPrivateIpv6(h)
            val v4 = parseIpv4(h) ?: return false
            return when {
                v4[0] == 10 -> true
                v4[0] == 172 && v4[1] in 16..31 -> true
                v4[0] == 192 && v4[1] == 168 -> true
                v4[0] == 169 && v4[1] == 254 -> true // link-local，AP 隔离时的自分配地址
                else -> false
            }
        }

        private fun isPrivateIpv6(raw: String): Boolean {
            val h = raw
            // IPv4-mapped：::ffff:192.168.1.5
            val mapped = h.substringAfterLast(':')
            if (h.startsWith("::ffff:") || h.startsWith("::FFFF:")) {
                return parseIpv4(mapped)?.let { isPrivateHost(mapped) } ?: false
            }
            val head = h.trimStart(':').takeWhile { it != ':' }
            if (head.length < 2) return false
            val firstByte = head.take(2).toIntOrNull(16) ?: return false
            // fc00::/7 → 首字节 0xfc 或 0xfd；fe80::/10 → 首字节 0xfe 且高两位为 10
            if (firstByte == 0xfc || firstByte == 0xfd) return true
            if (firstByte == 0xfe) {
                val second = head.drop(2).take(1).toIntOrNull(16) ?: return false
                // fe80–febf
                return second in 0x8..0xb
            }
            return false
        }

        private fun normalizeHost(host: String?): String? {
            val h = host?.trim()?.lowercase() ?: return null
            if (h.isEmpty()) return null
            return h.removePrefix("[").removeSuffix("]").trimEnd('.')
        }

        private fun parseIpv4(s: String): List<Int>? {
            val parts = s.split('.')
            if (parts.size != 4) return null
            val nums = parts.map { it.toIntOrNull() ?: return null }
            if (nums.any { it !in 0..255 }) return null
            return nums
        }
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

        /**
         * 行式序列化：id \t label \t url \t lastUsedAt \t kind，一行一条。标签里的制表符被替换掉。
         *
         * 第 5 列是后加的，**必须能读老数据**：只有 4 列时按 url 推断 kind，
         * 否则升级 App 后已保存的连接会全部消失。
         */
        internal fun serialize(list: List<Endpoint>): String =
            list.joinToString("\n") { e ->
                listOf(
                    e.id.replace('\t', ' ').replace('\n', ' '),
                    e.label.replace('\t', ' ').replace('\n', ' '),
                    e.url.replace('\n', ' '),
                    e.lastUsedAt.toString(),
                    e.kind.name,
                ).joinToString("\t")
            }

        internal fun deserialize(raw: String): List<Endpoint> =
            raw.split('\n')
                .mapNotNull { line ->
                    val parts = line.split('\t')
                    if (parts.size < 4) return@mapNotNull null
                    val used = parts[3].toLongOrNull() ?: 0L
                    val kind = parts.getOrNull(4)
                        ?.let { name -> Endpoint.Kind.entries.firstOrNull { it.name == name } }
                        ?: Endpoint.kindOf(parts[2])
                    Endpoint(id = parts[0], label = parts[1], url = parts[2], lastUsedAt = used, kind = kind)
                }

        /** 生成稳定 id：同一台电脑同一入口重复扫码时命中同一条，不产生重复项。 */
        internal fun idFor(label: String, url: String): String =
            "${label.trim().lowercase()}|${url.trim()}".hashCode().toString()
    }
}
