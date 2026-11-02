package com.dsh.remote

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams

/**
 * 主界面：连接列表 + 全屏 WebView。
 *
 * 设计取舍：不做原生会话列表/流式 Markdown。DSH 前端本身在快速演进，
 * 重写 UI 等于永久追赶；这里只负责把电脑上的同一个界面搬到手机。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var store: EndpointStore

    private lateinit var root: FrameLayout
    private lateinit var listRoot: ScrollView
    private lateinit var savedRows: LinearLayout
    private lateinit var emptyHint: TextView
    private lateinit var inputUrl: EditText

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar

    private var current: Endpoint? = null

    /** 登录握手自愈的闸门，见 healHandshakeIfNeeded。 */
    private val handshakeHeal = HandshakeHealGate()

    /** 最近一次 IME insets 报告的键盘高度（px），供 WebBridge 查询。 */
    internal var currentKeyboardHeight: Int = 0

    /** 上次系统栏高度，用于把状态栏变化和键盘变化分开判断（两者共用一套让位逻辑）。 */
    private var lastBarsTop: Int = -1

    /** 系统最新报告的键盘目标高度。 */
    private var targetKeyboardHeight: Int = 0

    /**
     * IME insets 动画是否正处于进行中（onPrepare 置真、onEnd 置假）。
     *
     * 有它才能把两个 insets 来源分开：动画期间 onProgress 给的是中间态，
     * 而 setOnApplyWindowInsetsListener 给的是终值。两者混用，终值会一帧帧覆盖
     * 中间值 —— 之前「键盘与界面不同步」的第一层原因就是这个。
     * 现在动画期间一律不下发中间态，只认 onPrepare 里拿到的 upperBound 终值。
     */
    private var imeAnimating: Boolean = false

    /** 本次 IME 动画是否已经定下目标高度；onPrepare 清假、认定终值后置真、onEnd 清假。 */
    private var keyboardCommitted: Boolean = false

    /** WebViewClient 用它判断「是不是同一台电脑」，决定 URL 留在 WebView 还是交给外部浏览器。 */
    internal val endpointHost: String? get() = current?.host

    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            handleScanned(result.data?.getStringExtra(ScanActivity.EXTRA_RESULT))
        }
    }

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) launchScanner()
        else toast("没有相机权限，可以手动输入地址")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 调试构建下允许 Chrome DevTools 连进来（chrome://inspect）。
        // 生产发布前必须关掉：开了等于把页面内容与 JS 执行权暴露给 adb 可达的任何人。
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        store = EndpointStore(this)
        setContentView(buildUi())
        applyImeInsets()
        installBackHandling()
        refreshSavedList()

        // 启动即进主界面：不停留在连接列表，直接在后台把 WebView 连上去。
        // 连不上（电脑没开、不在同一 Wi-Fi）才回落到列表页并说明原因，见 onPageError。
        autoconnect()
    }

    /**
     * 开机自动连接。
     *
     * 优先用最后使用过的连接；一个都没有时，用**构建时注入**的本机示例地址建档并连过去。
     *
     * 注入值来自 `local.properties` 的 `dsh.lanUrl` / `dsh.lanPin`（不进仓库，见
     * [BootstrapUrl] 的注释）。没有注入时 [BuildConfig.DEFAULT_LAN_URL] 是空串，
     * 这里会退回连接列表并走「扫码 / 手输」引导 —— **这是故意的**：
     * 内置一个写死的 `?token=` 既会泄漏 dsh-pocket 的局域网 PIN，也会在换网段后
     * 变成一个连不上的地址，让用户以为是网络故障。
     */
    private fun autoconnect() {
        val known = store.lastUsed()
        if (known != null) {
            connect(known, persist = false)
            return
        }
        val url = Endpoint.parseUri(DEFAULT_LAN_URL)
        if (url == null) {
            showList()
            return
        }
        val label = labelFromUrl(url)
        val ep = Endpoint(EndpointStore.idFor(label, url), label, url, System.currentTimeMillis())
        applyList(store.upsert(ep))
        connect(ep, persist = false)
    }

    /**
     * 键盘避让。
     *
     * targetSdk 35 起窗口默认 edge-to-edge，`adjustResize` 不再压缩窗口高度，
     * 键盘会直接盖住内容——DSH 的输入框在屏幕下半部，被盖住就等于没法打字。
     *
     * 关键点：不能只给根布局加 bottomMargin（那样只是整体上移，WebView 视口没变，
     * 页面内部的 fixed 定位元素仍按老高度布局）。必须**真的把 WebView 高度压小**，
     * `window.innerHeight` 变小后，DSH 前端的 flex 布局与 visualViewport 才会把输入框顶上来。
     *
     * 所以这里对 webView / listRoot 分别设置 bottomMargin —— 它们都是 root 的直接子 View，
     * margin 会实际改变它们自身的高度，而不是把整块画布推走。
     */
    private fun applyImeInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // 键盘滑入/滑出是系统动画，insets 在动画过程里本应逐帧插值。
        // 如果只在 onApplyWindowInsets 里「跳变」式地改一次布局，会出现这样的不同步：
        // WebView 已经缩到位、页面内容却还停在旧位置（reflow 要下一帧），中间那条缝露出的
        // 就是容器底色 —— 这就是用户看到的「点输入框时一闪的留白」。
        //
        // 这里顺势把系统的动画参数（时长、插值器）一起接进来，
        // 后面 animateKeyboard 就能用与系统完全相同的曲线补间，而不是拍脑袋用线性。
        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                        imeAnimating = true
                        keyboardCommitted = false
                    }
                }

                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    // 这里给的是**动画中间态**（实测逐帧 0→94→185→279→411→…→884），
                    // 一律忽略。原因见 applyKeyboardInsets 的注释：
                    // 页面要的是目标高度然后在 rAF 里自己补间，中间态只会反复改目标、
                    // 把补间一次次重启，最终表现就是「界面追着键盘一跳一跳」。
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                        imeAnimating = false
                        keyboardCommitted = false
                        // 兜底：用根窗口的 insets 再落一次，保证不会停在半路。
                        ViewCompat.getRootWindowInsets(root)?.let {
                            applyKeyboardInsets(it, animated = false)
                        }
                    }
                }
            },
        )

        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            // 关键认知修正（本轮从 trace-keyboard-calls.cjs 的实测里推翻的）：
            // 这条路径给的是**终值**，而且在动画开始的第一帧就已经是终值。
            // 之前把它当「终值噪声」屏蔽掉、改信 onProgress 的中间态，是彻底的错。
            // 现在反过来：只信这里，动画期间也是它说了算。
            applyKeyboardInsets(insets, animated = imeAnimating)
            insets
        }
    }

    /**
     * 把 insets 换算成键盘高度，然后交给页面。
     *
     * 这里**不做补间**。补间由页面用自己的 rAF 完成 —— 原因见 applyKeyboardHeight 注释：
     * 原生改布局触发的 WebView 尺寸变化会被合并成大颗粒批处理（实测 108ms 一跳、
     * 全程 897ms），比键盘慢一倍，无论怎么补间都追不上；页面侧 rAF 才是逐帧的。
     *
     * 所以这里唯一的任务是：**在动画开始的第一帧就把目标高度定下来，并锁定**。
     *
     * 这个结论是被 tools/trace-keyboard-calls.cjs 推翻重来的。当时的实测调用序列是：
     *   h=321.8 (正确终值) → h=0 (突降) → 34.2 → 67.3 → 101.5 → … → 321.8
     * 后面的 34/67/101 全是 onProgress 喂的动画中间态。页面每收到一个新目标就
     * 把 rAF 补间从当前位置重启，于是它一直在「追一个还在移动的目标」，
     * 表现出来就是界面一跳一跳地跟、追不上键盘。
     *
     * 现在两条规矩：
     *   1. onProgress 的中间态一条都不用（见 applyImeInsets）。
     *   2. 动画期间只认「第一帧那个跨度足够大的值」——它就是终值（onsetWindow 实测：
     *      逐帧增量最大 47px，而终值一帧就是 322px，阈值 90 分得很开）。
     *      认定之后立刻锁定，后续任何值都不再改目标，直到 onEnd 解开。
     *      兜底：onEnd 用根窗口 insets 再校一次，避免锁定值本身有偏差。
     */
    private fun applyKeyboardInsets(insets: WindowInsetsCompat, animated: Boolean) {
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        // 键盘真实高度 = ime 高度 - 已计入的系统栏高度，避免重复让位
        val keyboard = (ime.bottom - bars.bottom).coerceAtLeast(0)

        if (bars.top != lastBarsTop) {
            lastBarsTop = bars.top
            progress.updateLayoutParams<FrameLayout.LayoutParams> {
                topMargin = bars.top
            }
        }

        if (keyboard == targetKeyboardHeight) return

        if (animated) {
            // 已经为这次动画定过目标，锁定，不再被任何后续回调改写。
            if (keyboardCommitted) return
            // 跨度不够大 → 是逐帧中间态，不是终值。
            if (kotlin.math.abs(keyboard - targetKeyboardHeight) <= KEYBOARD_SNAP_THRESHOLD) return
            keyboardCommitted = true
        }

        targetKeyboardHeight = keyboard
        dispatchKeyboard(keyboard)
    }

    /** 把键盘高度交给页面（页面自己 rAF 补间），并同步连接列表的高度。 */
    private fun dispatchKeyboard(keyboard: Int) {
        applyKeyboardHeight(keyboard)
        notifyPageKeyboard(keyboard)
    }

    /**
     * 真正落地键盘高度。
     *
     * 这里**不再改 WebView 的高度**，这是本轮的关键结论。
     * 同钟测量（tools/measure-sync.cjs）证明了：原生逐帧改 bottomMargin 后，
     * WebView 的 `window.innerHeight` 并不是逐帧生效的——它把尺寸变化按约 108ms 一批
     * 合并提交，整段 322px 的位移花了 897ms 才走完，而原生侧 456ms 就走完了。
     * 也就是页面永远在「一跳一跳地追」键盘，这就是用户说的「键盘与界面速度不同步」。
     *
     * 反过来，页面自己用 rAF 改 CSS 时实测帧间隔中位数 14~20ms（tools/test-root-height.cjs），
     * 而且 #root 高度减多少、输入框就上移多少（1:1）。
     * 所以正确的分工是：
     *   - 原生只负责「键盘来了，高度是多少」，通知一次（跨进程调用不能每帧发）；
     *   - 页面自己在 rAF 里补间 #root 的高度，曲线与时长跟原生一致，逐帧完成。
     * WebView 因此全程保持全屏，页面底色与键盘之间不会再有尺寸抖动带。
     *
     * listRoot（连接列表）仍然要避让：那页有手输地址的输入框，键盘会盖住它。
     */
    private fun applyKeyboardHeight(height: Int) {
        if (height == currentKeyboardHeight) return
        currentKeyboardHeight = height

        listRoot.updateLayoutParams<FrameLayout.LayoutParams> {
            bottomMargin = height
        }
    }

    /**
     * 把键盘高度立刻交给页面，由页面自己的 rAF 补间。
     *
     * 单位换算在这里做：原生拿到的是设备像素，页面 CSS 用的是 CSS 像素。
     * 本机实测 density=2.75，键盘 885px 对应 CSS 322px，与 innerHeight 895→573 的差一致。
     * 直接把 885 喂给页面会让它算出 `895 - 885 = 10px`，整个布局崩掉。
     */
    private fun notifyPageKeyboard(keyboardPx: Int) {
        if (webView.visibility != View.VISIBLE) return
        val cssPx = keyboardPx / resources.displayMetrics.density
        webView.evaluateJavascript(
            "window.__dshNativeKeyboard && window.__dshNativeKeyboard($cssPx)",
            null,
        )
    }

    // ---------------------------------------------------------------- UI

    private fun buildUi(): View {
        root = FrameLayout(this)

        // ---- 连接列表（可滚动）----
        // 必须自己铺一层白底：窗口底色已改成 DSH 的深色（避免键盘留白时闪白），
        // 而这里的文字是深色的，不铺白底就会变成深底深字。
        listRoot = ScrollView(this).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
            isFillViewport = true
            setBackgroundColor(SURFACE)
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(30), dp(20), dp(24))
        }

        column.addView(TextView(this).apply {
            text = "DSH 手机遥控"
            textSize = 22f
            setTextColor(INK)
        })
        column.addView(TextView(this).apply {
            text = "连接运行在电脑上的 DeepSeek Harness，同一份会话、同一批文件"
            textSize = 13f
            setTextColor(INK_DIM)
            setPadding(0, dp(6), 0, dp(20))
        })

        // 已保存列表（动态部分）
        column.addView(TextView(this).apply {
            text = "已保存的连接"
            textSize = 13f
            setTextColor(INK_DIM)
            setPadding(0, 0, 0, dp(6))
        })

        savedRows = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(savedRows)

        emptyHint = TextView(this).apply {
            text = "还没有保存的连接。\n先扫电脑上的二维码，或在下方手动填地址。"
            textSize = 14f
            setTextColor(INK_DIM)
            setPadding(0, dp(4), 0, dp(10))
        }
        savedRows.addView(emptyHint)

        // 手动输入区
        column.addView(TextView(this).apply {
            text = "手动连接"
            textSize = 13f
            setTextColor(INK_DIM)
            setPadding(0, dp(24), 0, dp(6))
        })

        inputUrl = EditText(this).apply {
            // 全局示例，不写具体 IP：写死某个地址会让用户以为「必须连这台」。
            hint = "http://电脑IP:3081/?token=…"
            textSize = 14f
            isSingleLine = false
            maxLines = 3
            minLines = 2
            setTextColor(INK)
            setHintTextColor(0xFF8A90A0.toInt())
            setBackgroundResource(R.drawable.input_bg)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            inputType = android.text.InputType.TYPE_TEXT_VARIATION_URI
        }
        column.addView(inputUrl)

        val connectBtn = Button(this).apply {
            text = getString(R.string.connect)
            setOnClickListener {
                val url = Endpoint.parseUri(inputUrl.text?.toString())
                if (url == null) toast("地址要以 http:// 或 https:// 开头") else saveAndConnect(url)
            }
        }
        column.addView(connectBtn)

        // 调试/快速上手用：把上次 dsh-pocket 的局域网入口填进去。
        // 存在的理由不是省事，而是中文输入法下 adb/手工输入长 URL 极易出错，
        // 一个「填入」按钮能让用户先跑通链路，再改端口。
        //
        // 地址来自构建时注入（local.properties 的 dsh.lanUrl/dsh.lanPin，不进仓库）。
        // **没注入就直接不显示这个按钮** —— 给一个空串让用户「填入」比没有按钮更糟。
        val fillBtn = Button(this).apply {
            text = "填入本机示例"
            setOnClickListener {
                inputUrl.setText(DEFAULT_LAN_URL)
                inputUrl.setSelection(inputUrl.text?.length ?: 0)
                toast("已填入，按「连接」")
            }
        }
        if (DEFAULT_LAN_URL.isNotBlank()) {
            column.addView(fillBtn)
        }

        val scanBtn = Button(this).apply {
            text = "扫码连接"
            setOnClickListener { requestScan() }
        }
        column.addView(scanBtn)

        column.addView(TextView(this).apply {
            text = "电脑端：设置 → 手机访问 → 局域网二维码\n" +
                "扫码即连，凭 PIN 由网页完成认证，App 不保存任何密钥"
            textSize = 12f
            setTextColor(INK_DIM)
            setPadding(0, dp(16), 0, 0)
        })

        listRoot.addView(column)
        root.addView(listRoot)

        // ---- WebView（初始隐藏）----
        webView = WebViewFactory.create(this).apply { visibility = View.GONE }
        root.addView(webView)

        // ---- 进度条（顶部 2dp）----
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        root.addView(progress, FrameLayout.LayoutParams(MATCH, dp(2)).apply {
            gravity = android.view.Gravity.TOP
        })

        // ---- 不再放左上角返回按钮 ----
        // 开机自动连接后，用户的主场景就是一直待在 DSH 里；这个按钮常驻会压住
        // DSH 自己的顶部栏（左侧就是「打开侧边栏」），既多余又挡手。
        // 要换电脑地址：系统返回键一路退到不能再退时会回落到连接列表（见 onKeyDown）。

        return root
    }

    /** 重建「已保存的连接」区。只动 savedRows，不碰输入框，避免焦点与已输入文本丢失。 */
    private fun refreshSavedList() {
        savedRows.removeAllViews()
        val entries = store.all().sortedByDescending { it.lastUsedAt }

        if (entries.isEmpty()) {
            savedRows.addView(emptyHint)
            return
        }

        for (e in entries) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(2), dp(10), dp(2), dp(10))
                isClickable = true
                setOnClickListener { connect(e, persist = true) }
            }
            // 标题行：名字 + 落点标签。标签不是装饰 —— 列表里同时存在局域网与公网
            // 两条入口指向同一台电脑时，用户得能一眼分出「哪条在家里用、哪条在外面用」。
            val titleRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
            titleRow.addView(TextView(this).apply {
                text = e.label
                textSize = 16f
                setTextColor(INK)
            })
            titleRow.addView(TextView(this).apply {
                text = kindBadge(e.kind)
                textSize = 10f
                setTextColor(kindColor(e.kind))
                setPadding(dp(8), 0, 0, 0)
            })
            row.addView(titleRow)
            row.addView(TextView(this).apply {
                text = e.url
                textSize = 12f
                setTextColor(INK_DIM)
            })
            if (e.urlIsVolatile) {
                row.addView(TextView(this).apply {
                    text = "快速隧道地址每次重开都会变，变了要重新扫码"
                    textSize = 11f
                    setTextColor(0xFFB26B00.toInt())
                    setPadding(0, dp(2), 0, 0)
                })
            }
            row.addView(TextView(this).apply {
                text = "长按删除"
                textSize = 11f
                setTextColor(INK_DIM)
                setOnLongClickListener {
                    val updated = store.remove(e.id)
                    applyList(updated)
                    toast("已删除 ${e.label}")
                    true
                }
            })
            savedRows.addView(row)
            savedRows.addView(View(this).apply {
                setBackgroundColor(0x14000000)
                layoutParams = LinearLayout.LayoutParams(MATCH, dp(1))
            })
        }
    }

    private fun applyList(updated: List<Endpoint>) {
        // store 已经是唯一真相，这里只需要重建视图
        savedRows.removeAllViews()
        if (updated.isEmpty()) savedRows.addView(emptyHint) else refreshSavedList()
    }

    private fun labelFromUrl(url: String): String = Endpoint.hostOf(url) ?: "电脑"

    /** 列表行上的落点标签。文案要短，一行里还要放得下名字。 */
    private fun kindBadge(kind: Endpoint.Kind): String = when (kind) {
        Endpoint.Kind.LAN -> "局域网"
        Endpoint.Kind.PUBLIC -> "公网"
        Endpoint.Kind.LOOPBACK -> "本机"
    }

    /** 局域网用中性灰、公网用品牌蓝、本机用暗灰 —— 只做区分，不做语义暗示。 */
    private fun kindColor(kind: Endpoint.Kind): Int = when (kind) {
        Endpoint.Kind.LAN -> INK_DIM
        Endpoint.Kind.PUBLIC -> 0xFF2F6BFF.toInt()
        Endpoint.Kind.LOOPBACK -> 0xFF8A90A0.toInt()
    }

    private fun saveAndConnect(url: String) {
        val label = labelFromUrl(url)
        val id = EndpointStore.idFor(label, url)
        val ep = Endpoint(id, label, url, System.currentTimeMillis())
        applyList(store.upsert(ep))
        connect(ep, persist = false)
    }

    private fun connect(endpoint: Endpoint, persist: Boolean) {
        current = endpoint
        handshakeHeal.reset()
        if (persist) applyList(store.touch(endpoint.id))

        listRoot.visibility = View.GONE
        webView.visibility = View.VISIBLE
        progress.visibility = View.VISIBLE
        progress.progress = 0
        webView.loadUrl(endpoint.url)
    }

    private fun showList() {
        webView.visibility = View.GONE
        listRoot.visibility = View.VISIBLE
        progress.visibility = View.GONE
        refreshSavedList()
    }

    private fun requestScan() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchScanner() else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun launchScanner() {
        scanLauncher.launch(Intent(this, ScanActivity::class.java))
    }

    private fun handleScanned(raw: String?) {
        val url = Endpoint.parseUri(raw)
        if (url == null) {
            toast("扫到的不是可用的地址")
            return
        }
        inputUrl.setText(url)
        saveAndConnect(url)
    }

    // ------------------------------------------------------- WebView 回调

    internal fun onPageFinished(url: String?) {
        progress.visibility = View.GONE
        healHandshakeIfNeeded(url)
        // 复查一次：探测可能被「刚动过手」的静默期挡掉（页面还在过渡稿），
        // 这时代码就再也收不到「已恢复」的信号，闸门会一直以为还在同一轮故障里。
        // 延迟到静默期之后再探一次，保证健康状态一定能被记录。
        if (handshakeHeal.needsHealthyConfirmation()) {
            webView.postDelayed({
                if (!isFinishing && !isDestroyed) healHandshakeIfNeeded(url)
            }, HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS + 200L)
        }
    }

    /**
     * 标题到达时也试一次自愈：dsh-pocket 的 503 失败页只有几百字节，onPageFinished
     * 往往比标题回调晚一拍；标题里已经带了「无法完成登录握手」，早点修能少一次白屏。
     */
    internal fun onReceivedTitle(title: String?) {
        if (title != null && title.contains("无法完成登录握手")) healHandshakeIfNeeded(null)
    }

    /**
     * dsh-pocket 登录握手自愈。
     *
     * 现象：DSH 重启后 `dsh web` 端口会变（实测 54282 → 17169）。dsh-pocket 会把**新**的
     * launch token 补进请求，上游回 303 下发 `dsh-auth-*` cookie，于是本该无缝。
     * 但 WebView 里若已经存着**旧端口**签发的 `dsh-auth-*` cookie（authority 字段写的
     * 是旧端口），代理判定「已有 cookie、不需要补 token」，直接把请求转上去 → 上游不认
     * 这个 cookie → 401 → 页面只剩一行 "dsh web authentication required"。
     * 连续失败 3 次后代理进入 60 秒限流，回 503「无法完成登录握手」。
     *
     * 判据（三选一即触发）：
     *  1. 页面标题是握手失败页的标题；
     *  2. 正文出现 dsh web 的裸 401 文案；
     *  3. 标题含 DSH Pocket 且正文含「握手」（过渡页/失败页的兜底形态）。
     *
     * 做法：**只清 dsh-auth-\* 会话 cookie**，再带 `dsh-pocket-retry=1` 重新导航（该参数会清掉
     * 代理侧的失败计数，见 dsh-pocket/lib/proxy.mjs:928）。
     *
     * 为什么不能 removeAllCookies()：WebView 里除了 dsh-auth-* 还有 dsh_pocket_token ——
     * 那是用户输入 PIN 换来的局域网会话。全部清掉等于把用户踢回「访问验证」页，
     * 而那个页面里没有 PIN 可填（用户早忘了），表现就是「自愈之后彻底进不去了」。
     * 这个坑在真机上实测复现过：清完 cookie 页面变成「DSH Pocket · 访问验证」。
     */
    private fun healHandshakeIfNeeded(url: String?) {
        if (!handshakeHeal.mayProbe()) return
        val target = current ?: return
        webView.evaluateJavascript(HEAL_PROBE_JS) { raw ->
            val action = RecoveryPlanner.plan(PageState.fromProbe(raw), target.url)
            if (action == RecoveryAction.NONE) {
                // 页面正常：解除「本次已动手」的锁定，将来再坏还能自动修。
                // 这一步很关键 —— 没有它，第一次自愈成功后 done 永远为真，
                // DSH 下次重启改端口还得手动重启 App。
                handshakeHeal.onHealthy()
                return@evaluateJavascript
            }
            // 故障态确认了，但本次已经动手过就停在这里：重载后的失败页会再次走到这段，
            // 若继续动手就是无限刷新。
            if (!handshakeHeal.mayAct()) {
                android.util.Log.i("DshRemote", "page broken($action) but already healed once, waiting for user")
                return@evaluateJavascript
            }
            if (action == RecoveryAction.ASK_USER) {
                // 地址里没有 token：清掉 dsh_pocket_token 会把用户永久锁在验证页外，
                // 那个页面没有密码可填。只提示，不动 cookie。
                handshakeHeal.onActed()
                android.util.Log.i("DshRemote", "pin page but url has no token, asking user")
                runOnUiThread { toast("地址里没有 token，请重新扫码或粘贴完整地址") }
                return@evaluateJavascript
            }
            handshakeHeal.onActed()
            when (action) {
                RecoveryAction.CLEAR_POCKET_COOKIE -> {
                    // 残留的失效 dsh_pocket_token 会让 dsh-pocket 拒绝下发新 cookie
                    // （proxy.mjs:509-525 `maybeSeedAuthCookie` 第一行就 return），
                    // 于是带着 ?token= 也停在「访问验证」页。清掉它再重新导航即可。
                    android.util.Log.i("DshRemote", "pin page with token in url, clearing dsh_pocket_token and retrying")
                    clearPocketCookie(target)
                }
                else -> {
                    android.util.Log.i("DshRemote", "handshake broken, clearing ONLY dsh-auth-* and retrying")
                    clearAuthCookies(target)
                }
            }
            val retry = RecoveryPlanner.withRetry(target.url) ?: return@evaluateJavascript
            runOnUiThread {
                webView.loadUrl(retry)
                toast("已重新建立与电脑的连接")
            }
        }
    }

    /**
     * 只删除 `dsh_pocket_token`（dsh-pocket 的局域网 PIN 会话），保留 `dsh-auth-*`。
     *
     * **只有 URL 的 query 里确实还带着 `?token=` 时才允许调用**（判据在
     * [RecoveryPlanner.plan]，单测钉住了）。带着 token 重新导航，代理会立刻用
     * `maybeSeedAuthCookie` 下发一枚新的、与当前 sessionKey 匹配的 cookie。
     * 没有 token 就删，用户会被锁在「访问验证」页外 —— 那里没有密码可填。
     */
    private fun clearPocketCookie(target: Endpoint) {
        val cm = CookieManager.getInstance()
        val origin = target.url
        val all = cm.getCookie(origin) ?: return
        all.split(';').forEach { pair ->
            val name = pair.substringBefore('=').trim()
            if (name == POCKET_COOKIE) {
                cm.setCookie(origin, "$name=; Max-Age=0; Path=/")
            }
        }
        cm.flush()
    }

    /**
     * 只删除 `dsh-auth-*`（上游会话），保留 `dsh_pocket_token`（局域网 PIN 会话）。
     *
     * Android 的 CookieManager 没有「按名字前缀删」的 API，只能把现有 cookie 取出来、
     * 对要删的逐个 setCookie 成过期值。删完要 flush()，否则下个请求可能还带旧值。
     */
    private fun clearAuthCookies(target: Endpoint) {
        val cm = CookieManager.getInstance()
        val origin = target.url
        val all = cm.getCookie(origin) ?: return
        all.split(';').forEach { pair ->
            val name = pair.substringBefore('=').trim()
            if (name.startsWith(AUTH_COOKIE_PREFIX)) {
                // 置空 + 过期时间放过去 → 浏览器删除该 cookie
                cm.setCookie(origin, "$name=; Max-Age=0; Path=/")
            }
        }
        cm.flush()
    }

    /**
     * 主页加载失败时不要静默黑屏：留在连接列表并说明原因。
     *
     * 另外把 WebView 从 Chromium 的错误页里推出来，换成 about:blank。加载失败后页面会停在
     * `chrome-error://chromewebdata/`（CDP 可查），而用户看到的是我们的连接列表 ——
     * 那个错误页藏在 GONE 的 WebView 里。留着它没有好处：下次显示可能闪一帧，
     * 且错误页自带的「重试」与列表按钮指向不同 URL，容易混淆状态。
     *
     * 断言边界（不写没验证过的事）：**没有实测证据表明**留在错误页会导致下一次
     * `loadUrl` 失败。曾用 `input tap` 做过三次「点了没反应」的复现，后来查明是
     * MIUI 拒绝了触摸注入（logcat `InputManager: Input event injection from pid N failed`），
     * 按钮根本没被点到；改用 `monkey -f` 精确注入后，清与不清错误页都能连上。
     * 所以这里只是清理状态，不是在修某个已知的导航缺陷。
     */
    internal fun onPageError(code: Int, description: String?) {
        progress.visibility = View.GONE
        android.util.Log.w("DshRemote", "main frame error $code: $description")
        toast("连接失败（$code）：${description ?: "未知原因"}")
        // 顺序有讲究：先离开错误页，再切回列表。反过来会让空白页在可见状态下闪一下。
        webView.loadUrl(BLANK_PAGE)
        showList()
    }

    internal fun onProgress(p: Int) {
        progress.progress = p
        if (p >= 100) progress.visibility = View.GONE
    }

    internal fun openExternal(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
    }

    /**
     * 统一的返回处理：系统返回键与**侧滑手势返回**都走这里。
     *
     * 为什么不能继续用 onKeyDown：手势返回（左边缘内滑）由 `OnBackPressedDispatcher`
     * 派发，根本不产生 KEYCODE_BACK 按键事件，所以旧实现对手势完全失效 ——
     * 表现为「滑动返回」和「按键返回」行为不一致，甚至手势时直接退出。
     *
     * 返回顺序必须与进入顺序相反（后进先出），目标链路是：
     *     会话页  →  开始界面（会话列表/首页）  →  退出 App
     * 注意最后一步是**退出 App**，不是回落到 App 自己的连接列表页。
     *
     * 难点：DSH 是纯 SPA，进会话后 `location.href` 与 `history.length` 都不变
     * （实测两者进会话前后都是同一个值），所以 WebView 历史栈里没有「会话」这一层，
     * `canGoBack()` 指的全是页面级重载，用它做后退只会整页刷新并回到同一个会话。
     * 因此这里改为问**页面自己**当前在哪一级（见 WebViewFactory.DSH_LOCATION_JS）。
     */
    private fun installBackHandling() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val visible = this@MainActivity::webView.isInitialized &&
                    webView.visibility == View.VISIBLE
                if (!visible) {
                    // 停在连接列表页：这里就退出，别再往下走
                    finish()
                    return
                }
                webView.evaluateJavascript(WebViewFactory.DSH_LOCATION_JS) { raw ->
                    val where = BackNavigationDecider.PageLocation.fromRaw(raw)
                    when (backDecider.decide(isWebViewVisible = true, location = where)) {
                        BackNavigationDecider.Action.GO_TO_START -> {
                            backDecider.noteWentBack()
                            // 轻量视图切换（展开侧栏 → 点新会话），约 1–2 秒，不重载页面
                            webView.evaluateJavascript(WebViewFactory.DSH_GO_HOME_JS, null)
                        }
                        BackNavigationDecider.Action.EXIT_APP -> finish()
                        BackNavigationDecider.Action.RECOVER_TO_START ->
                            webView.evaluateJavascript(WebViewFactory.DSH_GO_HOME_JS, null)
                    }
                }
            }
        })
    }

    /** 返回决策逻辑（纯 JVM 类，可被单测覆盖，见 BackNavigationDecider）。 */
    private val backDecider = BackNavigationDecider()

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            // 顺序有讲究：先把 WebView 从视图树摘掉，再断开所有指向本 Activity 的引用，
            // 最后才 destroy。少做一步都会让 Activity 在配置变更（旋转）后被 WebView
            // 的 client / JS 接口悄悄持有，表现为「转屏几次后内存持续上涨」。
            root.removeView(webView)
            webView.webViewClient = android.webkit.WebViewClient()
            webView.webChromeClient = null
            webView.removeJavascriptInterface(WebViewFactory.JS_BRIDGE_NAME)
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.removeAllViews()
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private companion object {
        const val MATCH = FrameLayout.LayoutParams.MATCH_PARENT
        val INK = 0xFF111318.toInt()
        val INK_DIM = 0xFF5A6070.toInt()
        val SURFACE = 0xFFFFFFFF.toInt()

        /**
         * 首次启动时尝试自动连接的地址，**构建时注入**：
         * `local.properties` 里的 `dsh.lanUrl` + `dsh.lanPin`（`app/build.gradle.kts`
         * 注入两个原始字段，由 [BootstrapUrl.build] 拼成完整 URL）。
         *
         * 没填时这里是空串，App 直接落到连接列表走「扫码 / 手输」引导。
         *
         * 历史：这里原来是 `"http://192.168.50.58:3081/?token=12345678"`，
         * 硬编码的 PIN 等于把 dsh-pocket 的局域网访问密码写进公开仓库，
         * 写死的 IP 也让它换网段就报废。**别再把它写回来。**
         */
        val DEFAULT_LAN_URL: String = BootstrapUrl.build(BuildConfig.LAN_HOST, BuildConfig.LAN_PIN).orEmpty()

        /**
         * 单帧键盘高度跨度超过这个像素数，判定为「系统塞进来的终值」。
         *
         * 依据实测（MIUI + 讯飞，键盘 0→885px 约 470ms 共 60 帧）：
         * 逐帧增量最大 47px（0→14→51→93→137→184→231→277→323…），
         * 而终值一帧就是 885px。取 90 有两倍余量，两头分得开。
         */
        const val KEYBOARD_SNAP_THRESHOLD = 90

        /**
         * 上游会话 cookie 的名字前缀（dsh web 用 `dsh-auth-<随机串>`）。
         * 自愈只删这一类，保留 `dsh_pocket_token` 这个局域网 PIN 会话 —— 详见 clearAuthCookies。
         */
        const val AUTH_COOKIE_PREFIX = "dsh-auth-"

        /**
         * dsh-pocket 的局域网会话 cookie（`HttpOnly`，值 = `sha256(PIN:sessionKey)`）。
         *
         * 它的真实寿命 = **dsh web 进程从启动到关闭**：`sessionKey` 是进程级随机数
         * （dsh-pocket `lib/index.js:331-333`），Harness 一重启就换新，旧的必然失配。
         * 失配本身不可怕，可怕的是 `maybeSeedAuthCookie`（`proxy.mjs:509-525`）看到
         * 请求里**有任何** `dsh_pocket_token` 就 `return`，拒绝下发新的 —— 于是带着
         * `?token=` 也停在「访问验证」页。见 [RecoveryPlanner] 顶部的实测对照。
         */
        const val POCKET_COOKIE = "dsh_pocket_token"

        /**
         * 用来把 WebView 从 Chromium 内部错误页里推出来。
         *
         * 主页面加载失败后页面会停在 `chrome-error://chromewebdata/`。加载这个空白页
         * 可以清掉那个状态，避免错误页在下次显示时闪一帧。
         * **注意**：曾误以为不清错误页会导致下一次 `loadUrl` 被短路，那是 `input tap`
         * 被 MIUI 拒绝注入造成的假阴性，详见 [onPageError] 的说明。
         */
        const val BLANK_PAGE = "about:blank"

        /**
         * 探测页面处于什么状态。返回值经 [PageState.fromProbe] 翻译：
         *  `'0'` 正常 / 握手过渡（不动手）、`'1'` 上游 401 握手损坏（清 dsh-auth-*）、
         *  `'2'` dsh-pocket「访问验证」页（URL 带 token 时清 dsh_pocket_token）。
         *
         * 判据以**正文**为主，标题只做辅助 —— 这是实测逼出来的结论：
         * DSH 前端是 SPA，`document.title` 在页面切换后可能滞后或残留。真机调试时遇到过
         * 「标题还是上一次的失败页标题、正文早已是正常主界面」，若信标题就会无故清掉
         * 用户 cookie，把人踢回登录页。
         *
         * 各形态的真实正文（均取自 dsh-pocket 2.12 / dsh web 0.2.1-rc.5 实测）：
         *  - 失败页：标题「DSH Pocket · 无法完成登录握手」，正文含「无法完成登录握手」
         *  - 上游 401：「dsh web authentication required」
         *  - 正常主界面：含「导出会话日志」/「探索未至之境」
         *  - PIN 登录页：正文「此局域网地址受访问密码保护」/「访问密码 | Access PIN」，
         *    标题「DSH Pocket · 访问验证」—— 残留坏 cookie 的典型症状，返回 '2'
         *  - 过渡页：标题「DSH Pocket · 正在进入」—— 握手进行中，不能当故障
         */
        const val HEAL_PROBE_JS = """
            (function(){
              try {
                var t = (document.title || '');
                var b = (document.body ? document.body.innerText : '') || '';
                // 正常主界面：只要认出 DSH 主界面特征就不动手，标题再可疑也不算故障
                if (b.indexOf('导出会话日志') !== -1) return '0';
                if (b.indexOf('探索未至之境') !== -1) return '0';
                // 握手过渡页：正在进行，等它自己跳
                if (t.indexOf('正在进入') !== -1) return '0';
                // 真失败：以正文为准
                if (b.indexOf('无法完成登录握手') !== -1) return '1';
                if (b.indexOf('dsh web authentication required') !== -1) return '1';
                // PIN 页：正文或标题任一命中即可判（这一页正文很短，渲染很快；
                // 而标题「DSH Pocket · 访问验证」是它最稳定的特征）
                if (b.indexOf('受访问密码保护') !== -1) return '2';
                if (b.indexOf('访问密码') !== -1) return '2';
                if (t.indexOf('访问验证') !== -1) return '2';
                // 正文还没渲染出来时，才退回用标题判断失败页
                if (b.length === 0 && t.indexOf('无法完成登录握手') !== -1) return '1';
                return '0';
              } catch (e) { return '0'; }
            })()
        """
    }
}

