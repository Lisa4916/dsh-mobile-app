package com.dsh.remote

/**
 * 「该拿哪个地址去问 `pocket.status`」—— **纯 JVM，可单测。**
 *
 * ## 要解决的具体场景（2026-11-03 真机实测）
 *
 * dsh-pocket 默认是 quick tunnel：**每次重开电脑，公网域名都换一个随机名字**。
 * 手机里存的那条 `https://integrated-idaho-feat-sherman.trycloudflare.com/?token=…`
 * 在隧道关掉之后就是一条死链接：实测 PC 侧 `DNS 名称不存在`、手机侧
 * `ping` / `nc` 都报 `No address associated with hostname`，WebView 报
 * `net::ERR_NAME_NOT_RESOLVED`。
 *
 * 而刷新逻辑（[com.dsh.remote.MainActivity] 里问一次 `pocket.status` 把新地址存下来）
 * 原来只拿「当前页面的 origin」当 base。当前页面就是那条死域名时，这个请求必然失败
 * （实测日志 `pocket.status failed: UnknownHostException`），于是**永远刷新不到新地址**，
 * 用户只能去电脑上抄一遍地址手输。这就是「公网连接还是存在问题」的正身。
 *
 * ## 为什么 base 不能乱选，选完还得先种 cookie
 *
 * `pocket.status` 走 dsh-pocket 的 RPC 通道，**必须带该 origin 下的 `dsh-auth-*` cookie**。
 * 实测（PC 侧 `Invoke-WebRequest`，不带 cookie）：
 *
 * - `POST http://127.0.0.1:3081/dsh-pocket/pocket.status` → `401 Unauthorized`
 * - `POST http://192.168.50.58:3081/dsh-pocket/pocket.status` → `401 Unauthorized`
 * - 先 `GET http://127.0.0.1:3081/` 拿到 `Set-Cookie: dsh-auth-EsoX…` 之后再 POST → `200`
 *
 * 而真机上第一次改成「多候选 base」时正好踩了这个：日志是
 *
 * ```
 * pocket.status failed: UnknownHostException
 * pocket.status http 401
 * pocket.status: no usable public address (tried 2: …)
 * ```
 *
 * 也就是**回退 base 挑对了，但它没有 cookie** —— 页面从没在那个 origin 上加载过，
 * CookieManager 里当然没有它的 `dsh-auth-*`。所以候选必须同时带上「那个入口的 PIN」，
 * 先 `GET <origin>/?token=<PIN>` 把 cookie 种进去，再问状态。
 *
 * ## 候选顺序
 *
 * 按「最可能已经有 cookie」排：
 *
 * 1. **当前页面的 origin** —— 连得上时它必然有 cookie，一次就成；
 * 2. **其余非易变的已保存入口**（局域网档案为主，也包括固定域名的命名隧道）。
 *    这一条真机验证过：`pocket.status: answered via http://127.0.0.1:3081`；
 * 3. **本机 Wi-Fi IPv4 + 档案里的端口**（缺省 [DEFAULT_PORT]）。
 *
 * **易变入口（quick tunnel）不放进候选**：它的 host 大概率也是已经死掉的随机域名，
 * 试一条就白等一个 4 秒超时。当前页面那条是例外 —— 它是这次连接的对象，用户正在等它。
 */
internal object PocketProbe {

    /** dsh-pocket 反代默认端口，只在档案里查不到端口时兜底。 */
    const val DEFAULT_PORT = 3081

    /**
     * 一个候选探针：向哪里问、用哪个 PIN 先把 cookie 种下来。
     *
     * @param origin 形如 `http://192.168.50.58:3081`（含端口，cookie 按 origin 隔离）。
     * @param pin 那个入口的访问令牌；从档案 URL 的 `?token=` 取。为 null 时只能靠已有 cookie。
     */
    data class Probe(val origin: String, val pin: String?) {
        /** 种 cookie 用的地址：dsh-pocket 看到 `?token=` 才会下发 `dsh-auth-*`。 */
        val seedUrl: String get() = if (pin == null) "$origin/" else "$origin/?token=$pin"
    }

    /**
     * `https://a.b:8443/x?y` → `https://a.b:8443`；解析不出就 null。
     *
     * 端口串要保留：dsh-pocket 的 cookie 是按 origin（含端口）下发的，丢端口就是另一个 origin。
     */
    fun originOf(url: String?): String? {
        if (url == null) return null
        if (Endpoint.parseUri(url) == null) return null
        val host = Endpoint.hostOf(url) ?: return null
        val scheme = LanScan.schemeOf(url)
        val port = LanScan.portOf(url)
        return if (port == null) "$scheme://$host" else "$scheme://$host:$port"
    }

    /**
     * 从档案 URL 里取 PIN（`?token=…`）。取不到返回 null。
     *
     * 只认 `token` 这一个键：`?dsh-pocket-auth=1`、`?dsh-pocket-retry=…` 是握手用的，
     * 不是凭据。
     */
    fun pinOf(url: String?): String? {
        if (url == null) return null
        val q = url.substringAfter('?', "")
        if (q.isEmpty()) return null
        return q.split('&')
            .firstOrNull { it.startsWith("token=") }
            ?.substringAfter("token=")
            ?.takeIf { it.isNotEmpty() }
    }

    /**
     * 按可能性从高到低给出候选探针（已去重、保序）。
     *
     * @param current 当前页面那条档案；为 null 时跳过第一项。
     * @param all 全部已保存的连接。
     * @param localLanIp 本机 Wi-Fi 侧 IPv4（`LanScan.localLanIpv4()`）；走流量时为 null。
     */
    fun bases(current: Endpoint?, all: List<Endpoint>, localLanIp: String?): List<Probe> {
        val out = LinkedHashMap<String, Probe>()

        fun add(url: String?, pin: String?) {
            val origin = originOf(url) ?: return
            // 同一个 origin 只留第一次（最靠前的那次），但 PIN 缺失时允许后面的补上。
            val prev = out[origin]
            if (prev == null) out[origin] = Probe(origin, pin) else if (prev.pin == null && pin != null) {
                out[origin] = Probe(origin, pin)
            }
        }

        add(current?.url, pinOf(current?.url))

        // 除「会变的公网隧道」之外，其余已保存入口都可能还留着 cookie：
        // 局域网档案是最常见的，本机/回环档案（比如走 USB 反向转发时手存的）同样成立。
        all.filter { !it.urlIsVolatile }
            .sortedByDescending { it.lastUsedAt }
            .forEach { ep -> add(ep.url, pinOf(ep.url)) }

        if (!localLanIp.isNullOrBlank()) {
            val lanProfiles = all.filter { it.kind == Endpoint.Kind.LAN }
            val port = lanProfiles.mapNotNull { LanScan.portOf(it.url) }.firstOrNull() ?: DEFAULT_PORT
            // 这一条是「本机 Wi-Fi 上的自己」，PIN 沿用局域网档案里的那串（同一台电脑的 lan token）。
            add("http://$localLanIp:$port/", lanProfiles.firstNotNullOfOrNull { pinOf(it.url) })
        }
        return out.values.toList()
    }

    /**
     * 拿到新公网地址后，哪些旧条目该删掉。
     *
     * quick tunnel 的域名是一次性的，`urlIsVolatile`（PUBLIC 且 host 以 `.trycloudflare.com`
     * 结尾）就是它的标记。留着旧条目只会让列表里堆一串死链接，用户点了还得等一轮超时。
     *
     * **只有新地址本身也是 volatile 时才清理**：换成固定域名的命名隧道（named tunnel）时，
     * 那些 quick tunnel 条目可能仍然是用户在别处要用的，不该顺手删。
     */
    fun staleVolatileIds(all: List<Endpoint>, fresh: Endpoint): List<String> {
        if (!fresh.urlIsVolatile) return emptyList()
        return all.filter { it.urlIsVolatile && it.id != fresh.id }.map { it.id }
    }
}
