package com.dsh.remote

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
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
        refreshSavedList()

        // 启动即进主界面：不停留在连接列表，直接在后台把 WebView 连上去。
        // 连不上（电脑没开、不在同一 Wi-Fi）才回落到列表页并说明原因，见 onPageError。
        autoconnect()
    }

    /**
     * 开机自动连接。
     *
     * 优先用最后使用过的连接；一个都没有时，用内置的本机示例地址建档并连过去——
     * 用户第一次装完 App 打开就是 DSH 界面，不用先扫码或粘地址。
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
            hint = "http://192.168.50.58:3081/?token=…"
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
        val fillBtn = Button(this).apply {
            text = "填入本机示例"
            setOnClickListener {
                inputUrl.setText(DEFAULT_LAN_URL)
                inputUrl.setSelection(inputUrl.text?.length ?: 0)
                toast("已填入，按「连接」")
            }
        }
        column.addView(fillBtn)

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
            row.addView(TextView(this).apply {
                text = e.label
                textSize = 16f
                setTextColor(INK)
            })
            row.addView(TextView(this).apply {
                text = e.url
                textSize = 12f
                setTextColor(INK_DIM)
            })
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

    private fun saveAndConnect(url: String) {
        val label = labelFromUrl(url)
        val id = EndpointStore.idFor(label, url)
        val ep = Endpoint(id, label, url, System.currentTimeMillis())
        applyList(store.upsert(ep))
        connect(ep, persist = false)
    }

    private fun connect(endpoint: Endpoint, persist: Boolean) {
        current = endpoint
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
    }

    /** 主页加载失败时不要静默黑屏：留在连接列表并说明原因。 */
    internal fun onPageError(code: Int, description: String?) {
        progress.visibility = View.GONE
        android.util.Log.w("DshRemote", "main frame error $code: $description")
        toast("连接失败（$code）：${description ?: "未知原因"}")
        showList()
    }

    internal fun onProgress(p: Int) {
        progress.progress = p
        if (p >= 100) progress.visibility = View.GONE
    }

    internal fun openExternal(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))) }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK &&
            this::webView.isInitialized &&
            webView.visibility == View.VISIBLE
        ) {
            if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
            showList()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            root.removeView(webView)
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
        /** 本机 dsh-pocket 的默认局域网入口；端口/PIN 变了在这里改。 */
        const val DEFAULT_LAN_URL = "http://192.168.50.58:3081/?token=60111186"

        /**
         * 单帧键盘高度跨度超过这个像素数，判定为「系统塞进来的终值」。
         *
         * 依据实测（MIUI + 讯飞，键盘 0→885px 约 470ms 共 60 帧）：
         * 逐帧增量最大 47px（0→14→51→93→137→184→231→277→323…），
         * 而终值一帧就是 885px。取 90 有两倍余量，两头分得开。
         */
        const val KEYBOARD_SNAP_THRESHOLD = 90
    }
}

