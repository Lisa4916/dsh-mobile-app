package com.dsh.remote

import java.io.IOException
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * 局域网里「哪台电脑在跑 dsh-pocket」的判定与地址推导。**纯 JVM，可单测。**
 *
 * 为什么要自己扫：dsh-pocket 没有 mDNS / bonjour / SSDP，服务端 lib 目录下所有
 * js 文件里 `mdns|bonjour|discovery|broadcast|multicast|ssdp` 零命中，
 * 所以手机上不可能「问一句谁在跑 DSH」得到回答，只能按网段挨个敲 3081 端口。
 *
 * 代价已经量过（本机 192.168.50.58/24，并发 48、连接超时 300ms）：
 * **254 个地址扫完 1.86 秒**，命中唯一一台电脑。所以这件事可以在打开 App 时
 * 顺手做掉，用户不必先扫码或手输 URL。
 *
 * ## 判定不能只看端口
 *
 * 3081 是 dsh-pocket 的默认端口，但那是**约定不是标识**——别人家的服务、
 * 上一版残留进程都可能占着它。真正的判据是响应正文里有 `DSH Pocket`
 * （访问验证页与「正在进入」过渡页都带这个词）。
 *
 * 反过来，**绝不能拿响应长度当指纹**：实测同一个访问验证页在
 * `len=4210` 与 `len=3969` 之间变过（页面内容随握手失败计数变化）。
 */
internal object LanScan {

    /** dsh-pocket 的默认监听端口（`--port` 可改，改了就只能靠手输）。 */
    const val PORT = 3081

    /** 单次 TCP 连接超时。300ms 是实测能在 1.86 秒内扫完 /24 的取值。 */
    const val CONNECT_TIMEOUT_MS = 300

    /** 连上之后读响应的超时。给到 800ms：局域网内 HTTP 首包远快于此。 */
    const val READ_TIMEOUT_MS = 800

    /** 最多读多少字节就放弃。访问验证页 4KB 以内，给足余量。 */
    const val MAX_READ_BYTES = 64_000

    /**
     * 从本机 IPv4 生成同网段候选地址（**钉在 /24**），排除自己。
     *
     * 为什么钉 /24 而不是按真实掩码展开：家庭/办公路由器绝大多数是 /24；
     * 若真按 /16 展开那是 65,534 个地址，手机上要跑几分钟，用户早就关掉了。
     * 代价是 /16 网络里电脑若不在本机所在的那个 /24 内就会漏掉——这种情况
     * 仍可扫码或手输，不是死路。
     *
     * @param localIp 本机 IPv4 字符串；不是合法 IPv4 或属于回环时返回空列表。
     */
    fun candidates(localIp: String?): List<String> {
        val parts = localIp?.trim()?.split('.') ?: return emptyList()
        if (parts.size != 4) return emptyList()
        val nums = ArrayList<Int>(4)
        for (p in parts) {
            val n = p.toIntOrNull() ?: return emptyList()
            if (n !in 0..255) return emptyList()
            nums.add(n)
        }
        // 127/8 是手机自己，扫它只会找到本机；0/8 与 255 段也不是可用的局域网。
        if (nums[0] == 127 || nums[0] == 0 || nums[0] >= 224) return emptyList()
        val prefix = "${nums[0]}.${nums[1]}.${nums[2]}"
        val self = nums[3]
        return (1..254).filter { it != self }.map { "$prefix.$it" }
    }

    /** 响应正文是不是 dsh-pocket（访问验证页 / 正在进入页 / 主界面都带这个词）。 */
    fun looksLikePocket(body: String?): Boolean {
        val b = body ?: return false
        return b.contains("DSH Pocket") || b.contains("DeepSeek Harness")
    }

    /**
     * 这次响应**是否直接发了登录凭据**（`Set-Cookie: dsh-auth-…`）。
     *
     * 这是「装完不用输 PIN 也能直接进」的判定依据。判的不是正文而是响应头，
     * 原因是实测出来的三态（裸 GET `/`，不带任何 cookie、不带 token）：
     *
     * | 电脑侧局域网密码 | 状态码 | 正文 | `Set-Cookie` |
     * |---|---|---|---|
     * | **开着**（默认） | 200 | 访问验证页 `DSH Pocket · 访问验证` | **无** |
     * | **关着** | 200 | 过渡页 `DSH Pocket · 正在进入` | **有 `dsh-auth-…`** |
     *
     * 注意第二行的正文同样是「DSH Pocket · 正在进入」，**光看正文分不开这两种情况**；
     * 而挂上这张 cookie 再请求一次就拿到 `DeepSeek Harness` 主界面（实测 47,868 B）。
     * 所以唯一可靠的判据是「服务器有没有主动发凭据」。
     *
     * 什么时候会出现免 PIN：电脑端关掉「局域网访问密码」
     * （`~/.dsh/dsh-pocket/settings.json` 的 `lanAuthEnabled=false`，
     * 网页端「设置 → 手机访问」里也有这个开关）。默认是开着的，
     * 所以这条不是常态，而是**用户可选的一次性配置**。
     */
    fun issuesCredential(rawResponse: String?): Boolean {
        val head = rawResponse ?: return false
        // 只看响应头（第一个空行之前），避免把正文里出现的字符串误判
        val headerEnd = head.indexOf("\r\n\r\n")
        val headers = if (headerEnd >= 0) head.substring(0, headerEnd) else head
        for (line in headers.lines()) {
            if (!line.lowercase().startsWith("set-cookie:")) continue
            if (line.contains(CookieNames.AUTH_PREFIX)) return true
        }
        return false
    }

    /**
     * 从入口 URL 的 query 里取 `token`，也就是 dsh-pocket 的访问 PIN。
     *
     * 自己解析而不用 `Uri.getQueryParameter`：这一层要能被纯 JVM 单测覆盖。
     * 同时也避免把 fragment 里的 `token=` 误当成 query（`#?token=` 那种）。
     */
    fun tokenOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        // 先砍掉 fragment 再找 query：`http://h/#?token=x` 里的 token 是 fragment 里的，
        // 服务端根本收不到。反过来先找 `?` 会把 `#?` 里的也算进来。
        val query = url.substringBefore('#').substringAfter('?', "")
        if (query.isEmpty()) return null
        for (pair in query.split('&')) {
            if (pair.substringBefore('=') == "token") {
                val v = pair.substringAfter('=', "")
                if (v.isNotEmpty()) return v
            }
        }
        return null
    }

    /**
     * 把一条已有档案迁移到新发现的主机上，**沿用原来的 PIN 与端口**。
     *
     * 这是「换网段 / 电脑换了 DHCP 地址」时不用重扫的关键：PIN 没变，只是 IP 变了。
     * 端口也要一起搬——dsh-pocket 的 `--port` 可以改，扫描器只知道 3081，
     * 但老档案里记着用户当初连的那个端口，那个才是对这台电脑有效的。
     * 新地址若拼不出来（host 非法）返回 null，由调用方退回「让用户手输 PIN」。
     */
    fun rebind(old: Endpoint, newHost: String): Endpoint? {
        val pin = tokenOf(old.url) ?: return null
        val host = newHost.trim()
        if (host.isEmpty()) return null
        val base = buildBase(host, portOf(old.url), schemeOf(old.url))
        val url = BootstrapUrl.build(base, pin) ?: return null
        return Endpoint(
            id = EndpointStore.idFor(Endpoint.hostOf(url) ?: host, url),
            label = Endpoint.hostOf(url) ?: host,
            url = url,
            lastUsedAt = System.currentTimeMillis(),
        )
    }

    /** 旧 URL 的 scheme（小写）；认不出来时按 `http`。 */
    fun schemeOf(url: String?): String {
        val s = url?.substringBefore("://")?.trim()?.lowercase() ?: return "http"
        return if (s == "https") "https" else "http"
    }

    /** 从 URL 里取端口；没有显式端口时返回 null（走 scheme 默认端口）。 */
    fun portOf(url: String?): Int? {
        if (url.isNullOrBlank()) return null
        val noScheme = url.substringAfter("://", url)
        val authority = noScheme.substringBefore('/').substringBefore('?').substringBefore('#')
        val afterHost = authority.substringAfterLast(':', "")
        if (afterHost.isEmpty()) return null
        // 纯数字才算端口：`[::1]` 这种 IPv6 里的冒号不是端口分隔符
        return afterHost.toIntOrNull()?.takeIf { it in 1..65535 }
    }

    /**
     * 拼 `scheme://host[:port]`。
     *
     * **必须带上 scheme**：`BootstrapUrl.build` 见到没有 scheme 的输入会补 `http://`，
     * 于是 `https://` 的档案会在迁移后**悄悄降级成明文** —— 用户不会察觉，
     * 但登录 cookie 就开始裸奔了。
     */
    private fun buildBase(host: String, port: Int?, scheme: String): String {
        val portPart = if (port == null) "" else ":$port"
        return "$scheme://$host$portPart"
    }

    /**
     * 读本机第一个可用于扫描的 IPv4。
     *
     * 只读 `/proc/net` 派生的接口列表，不需要任何权限（`NetworkInterface` 不经
     * ConnectivityManager）。跳过回环与 link-local（169.254.x.x 是没拿到 DHCP 时的自救地址，
     * 那个网段上不会有电脑在跑 dsh-pocket）。
     */
    fun localIpv4(): String? = runCatching {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { it.isUp && !it.isLoopback }
            .flatMap { Collections.list(it.inetAddresses) }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
            ?.hostAddress
    }.getOrNull()

    /**
     * Wi-Fi 接口名是否属于「这台手机连的是局域网」。
     *
     * 为什么不用 `ConnectivityManager`：那要 `ACCESS_NETWORK_STATE` 权限，而本项目
     * 把它删了（代码零引用，权限越多审核越啰嗦）。接口名本身就够——
     * Android 上 Wi-Fi 是 `wlan0`，热点是 `wlan1`/`ap0`/`swlan0`，
     * 而移动数据是 `rmnet_data0`/`ccmni0`/`pdp0`。
     *
     * 这个判据的价值：走流量时也去扫 /24 会白等近 2 秒，而且扫的是运营商 NAT 网段，
     * 一台电脑都不会有。
     */
    fun isWifiLikeInterface(name: String?): Boolean {
        val n = name?.trim()?.lowercase() ?: return false
        if (n.isEmpty()) return false
        return n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan") ||
            n.startsWith("eth") || n.startsWith("rndis") || n.startsWith("usb")
    }

    /**
     * 只在「像局域网」的接口上取 IP。拿不到说明当前不是 Wi-Fi/有线，
     * 扫描没有意义（见 [isWifiLikeInterface]）。
     */
    fun localLanIpv4(): String? = runCatching {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { it.isUp && !it.isLoopback && isWifiLikeInterface(it.name) }
            .flatMap { Collections.list(it.inetAddresses) }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
            ?.hostAddress
    }.getOrNull()
}

/**
 * 扫描命中的一台电脑。
 *
 * @param host 主机地址（不含端口）
 * @param open **这台电脑不需要 PIN** —— 裸请求就下发了 `dsh-auth-…` 登录凭据
 *   （电脑端关掉了「局域网访问密码」）。见 [LanScan.issuesCredential]。
 */
internal data class LanHit(val host: String, val open: Boolean)

/**
 * 真正动手扫的执行器。**Android 侧**，因为要开 Socket。
 *
 * 设计约束：
 * - 全程在后台线程池，主线程只收回调；
 * - 回调在**工作线程**触发，调用方自己切主线程（这样本类不必知道 Looper）；
 * - [cancel] 必须能在 Activity 销毁时立刻停手：扫描期间的 Socket 连接会一直
 *   占着端口几秒，用户已经退出还继续扫是纯浪费。
 */
internal class LanDiscovery {

    @Volatile
    private var cancelled = false

    private var workers: java.util.concurrent.ExecutorService? = null

    /**
     * 开始扫描。
     *
     * @param localIp 本机 IPv4（见 [LanScan.localIpv4]），null 时直接结束。
     * @param onFound 每发现一台电脑回调一次。
     * @param onDone 扫完回调，参数是发现总数。取消时**不会**回调。
     */
    fun scan(
        localIp: String?,
        onFound: (LanHit) -> Unit,
        onDone: (Int) -> Unit,
    ) {
        cancel()
        cancelled = false

        val hosts = LanScan.candidates(localIp)
        if (hosts.isEmpty()) {
            onDone(0)
            return
        }

        val pool = Executors.newFixedThreadPool(CONCURRENCY)
        workers = pool
        val found = AtomicInteger(0)
        val latch = CountDownLatch(hosts.size)

        for (host in hosts) {
            pool.execute {
                try {
                    val hit = probe(host)
                    if (!cancelled && hit != null) {
                        found.incrementAndGet()
                        onFound(hit)
                    }
                } catch (e: Throwable) {
                    // 单个地址的任何异常都不该终止整轮扫描
                } finally {
                    latch.countDown()
                }
            }
        }

        // 汇总必须用独立线程：把「等所有任务结束」当成一个任务提交到同一个池里，
        // 在池满时可能永远轮不到执行（线程全被阻塞型任务占着）。
        Thread({
            runCatching {
                latch.await()
                pool.shutdown()
                val n = found.get()
                if (!cancelled) onDone(n)
            }
        }, "dsh-lan-discovery-summary").apply { isDaemon = true }.start()
    }

    /** 停止扫描。已经发出的连接会自然超时，未开始的直接跳过。 */
    fun cancel() {
        cancelled = true
        workers?.shutdownNow()
        workers = null
    }

    /**
     * 探一台主机：连 3081，发一个最小 HTTP 请求，看它是不是 dsh-pocket，
     * 顺便从响应头判断这台电脑要不要 PIN。
     *
     * 用 `HTTP/1.0` + `Connection: close`：让服务端回完就断，不必自己解析
     * `Content-Length` 或 chunked。我们只关心正文里那几个字与响应头里的 `Set-Cookie`。
     *
     * 命中即返回（不必读完整个页面），但**必须把响应头读完**才知道要不要 PIN——
     * 响应头一定在正文之前，所以第一轮读到的 4KB 里必然包含它。
     */
    private fun probe(host: String): LanHit? {
        return try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, LanScan.PORT), LanScan.CONNECT_TIMEOUT_MS)
                socket.soTimeout = LanScan.READ_TIMEOUT_MS
                val request = "GET / HTTP/1.0\r\n" +
                    "Host: $host:${LanScan.PORT}\r\n" +
                    "User-Agent: dsh-remote-discovery\r\n" +
                    "Connection: close\r\n\r\n"
                socket.getOutputStream().apply {
                    write(request.toByteArray(Charsets.UTF_8))
                    flush()
                }

                val buf = ByteArray(4096)
                val sb = StringBuilder(512)
                var total = 0
                val input = socket.getInputStream()
                while (total < LanScan.MAX_READ_BYTES) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    total += n
                    sb.append(String(buf, 0, n, Charsets.UTF_8))
                    // 两个条件都满足才停：
                    //  1. 响应头收全了（要读 Set-Cookie 判免 PIN，头没收全就判会误判成「要 PIN」）
                    //  2. 正文已能认出是 dsh-pocket（不必等整个 4KB 页面）
                    // 少判第 1 条会让「头与正文被拆成两个 TCP 段」的场景偶然失败。
                    val headerReady = sb.indexOf("\r\n\r\n") >= 0
                    if (headerReady && LanScan.looksLikePocket(sb.toString())) break
                }
                val raw = sb.toString()
                if (!LanScan.looksLikePocket(raw)) return null
                LanHit(host = host, open = LanScan.issuesCredential(raw))
            }
        } catch (e: IOException) {
            null
        }
    }

    private companion object {
        /**
         * 并发度。48 是实测值：/24 共 254 个地址分 6 批，
         * 每批 300ms 超时 → 1.8 秒；再高对低端机的文件描述符不友好。
         */
        const val CONCURRENCY = 48
    }
}
