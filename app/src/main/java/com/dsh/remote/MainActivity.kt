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
import androidx.appcompat.app.AlertDialog
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

    /**
     * 连接档案的存取口子。界面只通过它读写，不直接抱 `SharedPreferences` ——
     * 这样档案相关的编排（[AutoConnect]）能脱离 `Context` 被单测覆盖。
     */
    private lateinit var connections: ConnectionRepository

    private lateinit var root: FrameLayout
    private lateinit var listRoot: ScrollView
    private lateinit var savedRows: LinearLayout
    private lateinit var emptyHint: TextView
    private lateinit var inputUrl: EditText

    /**
     * 「局域网里找到了一台电脑、等着输 PIN」那一块的容器。
     *
     * 为什么会存在：第一次装 App 的用户手机里没有任何档案，dsh-pocket 又没有
     * mDNS/SSDP 能被发现，所以只能自己扫 /24 找出电脑（254 个地址并发扫完
     * 实测 1.86 秒）。扫到之后**唯一还缺的就是 PIN**——它是 dsh-pocket 进程级的
     * 一把钥匙（`~/.dsh/dsh-pocket/token-lan`），手机侧无法凭空知道。
     *
     * 这一块就是把「知道主机了，只差 PIN」这个中间态显式做出来，
     * 而不是把用户扔回「请扫二维码」的零信息状态。
     */
    private lateinit var foundBox: LinearLayout
    private lateinit var foundLabel: TextView
    private lateinit var inputPin: EditText

    /** 最近一次扫到的主机地址（不含端口）。输入 PIN 后用它拼地址。 */
    private var foundHost: String? = null

    /**
     * 本轮扫描已命中的主机。
     *
     * 为什么不「扫到一台就立刻连」：扫完才知道有没有第二台在 3081 上答话，
     * 而这直接决定「能不能把旧 PIN 搬过去」（多台时搬有可能连到别人家机器上，
     * 见 [LanAdopt]）。留到 onDone 一起判，代价只有不到两秒。
     */
    private val lanFound = mutableListOf<String>()

    /** 局域网扫描器。Activity 销毁时必须停手，否则退出后还在发 254 个 SYN。 */
    private val lanDiscovery = LanDiscovery()

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar

    private var current: Endpoint? = null

    /**
     * 登录握手自愈的执行者。探测结果交给它判断与动手，Activity 只负责
     * 「求值 JS」和「把副作用交给 WebView/CookieManager」这两件必须碰 Android 的事。
     *
     * 这样拆开之后，`healHandshakeIfNeeded` 里原本最难验证的顺序问题
     * （健康必须复位闸门、ASK_USER 绝不能清 cookie、POCKET 与 UPSTREAM 不能混）
     * 全部落到 [RecoveryExecutor] 上，用纯 JVM 单测钉住。
     */
    private lateinit var recovery: RecoveryExecutor

    /**
     * 排队中的「健康复查」任务（见 [onPageFinished]）。
     *
     * 存引用是为了能取消：它延迟 1.4 秒执行，期间可能已经换地址或 Activity 销毁。
     * `isFinishing` / `isDestroyed` 只是兜底判断，不是取消 —— 真到了回调执行的那一刻，
     * WebView 可能已经被 destroy，`evaluateJavascript` 会静默失败，那一轮闸门就永远
     * 卡在「还在同一轮故障里」，后续自愈全部被节流挡掉。
     */
    private var healthRecheck: Runnable? = null

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
        connections = SharedPrefsConnectionRepository(store)
        recovery = RecoveryExecutor(env = uiRecoveryEnvironment())
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
     * 三级回落，每一级都比上一级更依赖用户动手：
     *
     *  1. **用最后使用过的连接**（`connections.lastUsed()`）——装过一次之后永远走这条，
     *     用户完全看不到任何中间界面。
     *  2. **构建时注入的本机示例地址**（`local.properties` 的 `dsh.lanUrl`/`dsh.lanPin`）——
     *     只在自己编译给自己用时存在。CI 包里 [BuildConfig.DEFAULT_LAN_URL] 是空串，
     *     **这是故意的**：内置写死的 `?token=` 会泄漏 dsh-pocket 的局域网 PIN，
     *     也会在换网段后变成一个连不上的地址。
     *  3. **扫局域网找电脑**（[startLanDiscovery]）——走到这里说明是全新安装、
     *     手机里一条档案都没有。这正是「第一次装完 App 必须扫码或手输」的那个场景。
     *     现在改成先自己扫一遍：254 个地址并发扫完实测 1.86 秒，扫到一台就直接进。
     *
     * 扫到之后还差 PIN（它是 dsh-pocket 进程级的一把钥匙，没有 mDNS 可以读到），
     * 但此时用户只需要输 8 位数字，不必再去电脑前扫二维码。
     */
    private fun autoconnect() {
        when (val plan = AutoConnect.decide(connections.lastUsed(), DEFAULT_LAN_URL, System.currentTimeMillis())) {
            is AutoConnectPlan.Connect -> connect(plan.endpoint, persist = false)
            is AutoConnectPlan.Seed -> {
                applyList(connections.upsert(plan.endpoint))
                connect(plan.endpoint, persist = false)
            }
            AutoConnectPlan.ShowList -> {
                showList()
                // 落到列表页说明没有可用档案 —— 这时不该让用户面对「请扫码」发呆，
                // 先自己去局域网里找一趟。
                startLanDiscovery(manual = false)
            }
        }
    }

    /**
     * 扫一遍局域网找 dsh-pocket。
     *
     * @param manual 用户主动点的（true）还是开机自动起的（false）。
     *   两者的差别只在**失败时说不说话**：开机那次没扫到就安静地落回列表，
     *   不应在用户还没打算连接的时候弹 Toast。
     */
    private fun startLanDiscovery(manual: Boolean) {
        val localIp = LanScan.localLanIpv4()
        if (localIp == null) {
            // 没连 Wi-Fi（走流量 / 飞行模式）：扫出来的只会是运营商 NAT 网段，
            // 一台电脑都不会有，白等两秒。这里直接说清原因。
            if (manual) toast("先连上和电脑同一个 Wi-Fi 再找")
            return
        }

        lanFound.clear()
        foundHost = null
        foundBox.visibility = View.GONE
        emptyHint.text = LAN_SEARCHING_HINT

        lanDiscovery.scan(
            localIp = localIp,
            onFound = { host -> runOnUiThread { lanFound.add(host) } },
            onDone = { count ->
                android.util.Log.i("DshRemote", "lan discovery done, found=$count")
                runOnUiThread { onLanScanDone(manual) }
            },
        )
    }

    private fun onLanScanDone(manual: Boolean) {
        emptyHint.text = EMPTY_HINT

        val plan = LanAdopt.plan(
            saved = connections.all().sortedByDescending { it.lastUsedAt },
            foundHosts = lanFound.toList(),
        )
        when (plan) {
            is LanAdoptPlan.Adopt -> {
                // 认识这台电脑（同 IP，或 PIN 能搬过去）：直接进，用户看不到任何中间页。
                applyList(connections.upsert(plan.endpoint))
                connect(plan.endpoint, persist = false)
            }

            is LanAdoptPlan.AskPin -> {
                // 扫到了但没有 PIN：只差这一步，把输入框亮出来。
                // host 从 plan.url 里取，而不是复用 label —— label 是给人看的名字，
                // 以后换成「客厅那台电脑」这类友好名时不该把连接逻辑带崩。
                foundHost = Endpoint.hostOf(plan.url)
                foundLabel.text = "${plan.label} · 电脑上「设置 → 手机访问」里那串 PIN"
                foundBox.visibility = View.VISIBLE
                inputPin.requestFocus()
                toast("找到了 ${plan.label}")
            }

            LanAdoptPlan.None -> {
                if (manual) toast("没找到电脑。确认电脑上 DeepSeek Harness 已开启手机访问")
            }
        }
    }

    /** 用户输入 PIN 之后拼地址并连接。 */
    private fun connectWithPin() {
        val host = foundHost ?: return
        val pin = inputPin.text?.toString()?.trim().orEmpty()
        if (pin.isEmpty()) {
            toast("请输入电脑上显示的 PIN")
            return
        }
        // 必须带上端口：BootstrapUrl.build 只补 scheme，不会补端口，
        // 传裸主机名会拼成 `http://<ip>/?token=…`（80 端口），连不上 3081。
        val url = BootstrapUrl.build("http://$host:${LanScan.PORT}", pin)
        if (url == null) {
            toast("这个 PIN 拼不出可用地址，检查一下有没有输错")
            return
        }
        inputPin.setText("")
        foundBox.visibility = View.GONE
        saveAndConnect(url)
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
            text = EMPTY_HINT
            textSize = 14f
            setTextColor(INK_DIM)
            setPadding(0, dp(4), 0, dp(10))
        }
        savedRows.addView(emptyHint)

        // ---- 扫到了但这台电脑还没有 PIN：只差这一步 ----
        //
        // 布局位置在「已保存的连接」下面、「手动连接」上面：它比手动填一整个 URL
        // 更接近用户此刻的状态（知道了是哪台电脑，只缺密码），但不该抢掉
        // 已有连接的位置。默认 GONE，只有真的扫到才显示。
        foundBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, dp(14), 0, 0)
        }
        foundBox.addView(TextView(this).apply {
            text = "在局域网里找到了一台电脑"
            textSize = 13f
            setTextColor(INK_DIM)
            setPadding(0, 0, 0, dp(4))
        })
        foundLabel = TextView(this).apply {
            text = ""
            textSize = 15f
            setTextColor(INK)
            setPadding(0, 0, 0, dp(6))
        }
        foundBox.addView(foundLabel)
        inputPin = EditText(this).apply {
            hint = "输入电脑上显示的 8 位访问 PIN"
            textSize = 15f
            isSingleLine = true
            setTextColor(INK)
            setHintTextColor(0xFF8A90A0.toInt())
            setBackgroundResource(R.drawable.input_bg)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            inputType = android.text.InputType.TYPE_CLASS_NUMBER or
                android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
        foundBox.addView(inputPin)
        foundBox.addView(Button(this).apply {
            text = "用这个 PIN 连接"
            setOnClickListener { connectWithPin() }
        })
        foundBox.addView(Button(this).apply {
            text = "重新找一次"
            setOnClickListener { startLanDiscovery(manual = true) }
        })
        column.addView(foundBox)

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

        // 「在局域网里找电脑」放在扫码上面：它不需要用户做任何事，
        // 而扫码要用户跑去电脑前对着屏幕。先给最省事的那条路。
        column.addView(Button(this).apply {
            text = "在局域网里找电脑"
            setOnClickListener { startLanDiscovery(manual = true) }
        })

        val scanBtn = Button(this).apply {
            text = "扫码连接"
            setOnClickListener { requestScan() }
        }
        column.addView(scanBtn)

        column.addView(TextView(this).apply {
            // 这段文案说的是**事实**，不是宣传语。
            //
            // 旧文案写「扫码即连，凭 PIN 由网页完成认证，App 不保存任何密钥」——
            // 实测是假的：地址（含 `?token=<PIN>`）原样落在
            // `/data/data/com.dsh.remote/shared_prefs/dsh_endpoints.xml` 里，明文。
            //
            // 为什么不改成「真的不存」：`?token=` 是 dsh-pocket 的**一次性入口凭据**，
            // 消费掉之后靠 cookie 维持会话；而 cookie 寿命等于 dsh web 进程寿命
            // （见 INTEGRATION.md §2.1），电脑一重启就要重新走一次 `?token=`。
            // 不存 token 的代价是「每次电脑重启都要重新扫码」，那比明文落盘更难用。
            // 所以这里选择说实话，并给出用户能自己做的动作（长按删除）。
            text = "电脑端：设置 → 手机访问 → 局域网二维码\n" +
                "地址（含访问 PIN）只保存在本机，不会上传；\n" +
                "换电脑或不再使用这台，长按列表项删除"
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
        val entries = connections.all().sortedByDescending { it.lastUsedAt }

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
                    setTextColor(WARN)
                    setPadding(0, dp(2), 0, 0)
                })
            }
            row.addView(TextView(this).apply {
                text = "长按删除"
                textSize = 11f
                setTextColor(INK_DIM)
                setOnLongClickListener {
                    confirmDelete(e)
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

    /**
     * 长按删除前先问一句。
     *
     * 之前是 `setOnLongClickListener { connections.remove(e.id) }` 直接删 —— 列表项
     * 是整行可长按的，手指在滚动列表时稍微停一下就误触，而删掉的是一条**带 token
     * 的连接地址**：删了就得回去电脑上重新扫码。这类操作没有任何理由不做确认。
     *
     * 用 AlertDialog 而不是 Toast + 撤销，因为撤销需要排队状态，而这里删除是同步写
     * SharedPreferences；确认框更简单也更符合「删除」这种不可逆操作的惯例。
     */
    private fun confirmDelete(endpoint: Endpoint) {
        AlertDialog.Builder(this)
            .setTitle("删除这条连接？")
            .setMessage("${endpoint.label}\n${endpoint.url}\n\n删除后需要重新扫码或手输地址才能连回来。")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ ->
                applyList(connections.remove(endpoint.id))
                toast("已删除 ${endpoint.label}")
            }
            .show()
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
        applyList(connections.upsert(ep))
        connect(ep, persist = false)
    }

    private fun connect(endpoint: Endpoint, persist: Boolean) {
        current = endpoint
        recovery.reset()
        // 换地址时上一次排队中的健康复查已经没有意义：它会拿着新页面去问旧故障的结论。
        healthRecheck?.let { webView.removeCallbacks(it) }
        healthRecheck = null
        if (persist) applyList(connections.touch(endpoint.id))

        listRoot.visibility = View.GONE
        webView.visibility = View.VISIBLE
        progress.visibility = View.VISIBLE
        progress.progress = 0
        applyBarIconTheme(darkBackground = true)
        webView.loadUrl(endpoint.url)
    }

    private fun showList() {
        webView.visibility = View.GONE
        listRoot.visibility = View.VISIBLE
        progress.visibility = View.GONE
        applyBarIconTheme(darkBackground = false)
        refreshSavedList()
    }

    /**
     * 状态栏图标前景跟着**当前可见页面的底色**走。
     *
     * 病灶：`themes.xml` 里 `android:windowLightStatusBar=true` 是静态值，含义是
     * 「背景浅，请用深色图标」——那对白底的连接列表是对的。但 WebView 页面底色是
     * `#151517`，一直沿用深色图标的结果是深灰压近黑。真机截图实测状态栏区域亮度：
     * 主界面 `p50=21 / max=21`（几乎全黑，时间与电量根本看不清），
     * 列表页 `p50=255 / max=255`（正常）。
     *
     * 因为窗口是 edge-to-edge（[applyImeInsets] 里 `setDecorFitsSystemWindows(false)`），
     * 状态栏底下就是页面本身，没有一层系统绘制的背景可以指望，只能靠这里切前景色。
     *
     * @param darkBackground 页面底色是深色时传 true → 用浅色（白）图标。
     */
    private fun applyBarIconTheme(darkBackground: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !darkBackground
            isAppearanceLightNavigationBars = !darkBackground
        }
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

    /**
     * 把自愈要碰的 Android 侧能力包成一个 [RecoveryEnvironment]。
     *
     * 这里的每个方法都只做「翻译」：把执行者的意图落到 CookieManager / WebView / Toast 上。
     * **不放任何判断** —— 判断全在 [RecoveryExecutor]，放这里就又变成测不到的代码了。
     */
    private fun uiRecoveryEnvironment(): RecoveryEnvironment = object : RecoveryEnvironment {
        override fun clearUpstreamCookies(url: String) = clearCookies(url, pocket = false)

        override fun clearPocketCookie(url: String) = clearCookies(url, pocket = true)

        override fun navigate(url: String) {
            runOnUiThread { webView.loadUrl(url) }
        }

        override fun notifyUser(message: String) {
            runOnUiThread { toast(message) }
        }

        override fun log(message: String) {
            android.util.Log.i("DshRemote", message)
        }
    }

    internal fun onPageFinished(url: String?) {
        progress.visibility = View.GONE
        healHandshakeIfNeeded()
        // 复查一次：探测可能被「刚动过手」的静默期挡掉（页面还在过渡稿），
        // 这时代码就再也收不到「已恢复」的信号，闸门会一直以为还在同一轮故障里。
        // 延迟到静默期之后再探一次，保证健康状态一定能被记录。
        if (recovery.needsHealthyConfirmation()) {
            // 一定要存引用：这个 Runnable 活 1.4 秒，期间用户可能已经切到别的地址、
            // 或者 Activity 被销毁。没有引用就没法在 onDestroy 里取消，
            // 回调会在已经拆掉的 WebView 上跑（实测 `isFinishing` 拦得住 Activity 销毁，
            // 但拦不住「换地址后还拿旧 current 探一次」）。
            healthRecheck?.let { webView.removeCallbacks(it) }
            val recheck = Runnable {
                healthRecheck = null
                if (!isFinishing && !isDestroyed) healHandshakeIfNeeded()
            }
            healthRecheck = recheck
            webView.postDelayed(recheck, HandshakeHealGate.PROBE_QUIET_AFTER_ACT_MS + 200L)
        }
    }

    /**
     * 标题到达时也试一次自愈：dsh-pocket 的 503 失败页只有几百字节，onPageFinished
     * 往往比标题回调晚一拍；标题里已经带了「无法完成登录握手」，早点修能少一次白屏。
     */
    internal fun onReceivedTitle(title: String?) {
        if (title != null && title.contains("无法完成登录握手")) healHandshakeIfNeeded()
    }

    /**
     * dsh-pocket 登录握手 / 访问验证页的自愈入口。
     *
     * 现象（两类故障，用户感知是同一件事：「进不去」）：
     *
     * **一、上游 401。** DSH 重启后 `dsh web` 端口会变（实测 54282 → 17169）。dsh-pocket
     * 会把**新**的 launch token 补进请求，上游回 303 下发 `dsh-auth-*` cookie，本该无缝。
     * 但 WebView 里若已经存着**旧端口**签发的 `dsh-auth-*`（authority 字段写的是旧端口），
     * 代理判定「已有 cookie、不需要补 token」，直接转上去 → 上游不认 → 401 →
     * 页面只剩 "dsh web authentication required"。连续失败 3 次后代理进入 60 秒限流，
     * 回 503「无法完成登录握手」。
     *
     * **二、访问验证页。** 残留一枚失效的 `dsh_pocket_token` 时，dsh-pocket 的
     * `maybeSeedAuthCookie` 拒绝下发新 cookie，于是地址里带着 `?token=` 也停在验证页。
     *
     * 这两类故障该清**不同的** cookie，判断与动手都在 [RecoveryExecutor] 里
     * （用纯 JVM 单测钉住了「URL 没有 token 时绝不清 pocket cookie」这条铁律）。
     * 这里只做三件必须有 Android 才能做的事：求值取标题/取正文、把两个字符串
     * 翻译成页面状态、交给执行者。
     *
     * 判据本身（[PageProbe.classify]）是纯函数，不在 JS 里 —— 它在 JVM 单测里被
     * 逐条钉住，不必上真机试错。求值只负责把 `document.title` 与
     * `document.body.innerText` 取回来（[PageProbeJsTest] 在真 WebView 里验证这一段）。
     *
     * 取值分两次求值（标题、正文各一次）而不是拼成一段 JS：这样任一求值失败都只影响
     * 自己那一半，`classify` 收到 null 会走「拿不准一律不动手」的兜底，而不是整段抛异常。
     */
    private fun healHandshakeIfNeeded() {
        val target = current ?: return
        if (!recovery.shouldProbe(target.url)) return

        webView.evaluateJavascript(PageProbe.JS_TITLE) { rawTitle ->
            val title = PageProbe.decodeJsString(rawTitle)
            // 标题就足以定案时不必再取正文（多数健康页面走这条快路）
            val quick = PageProbe.classify(title, "")
            if (quick == "2") {
                // 『DSH Pocket · 访问验证』标题命中：正文不会再改变结论
                recovery.handleProbeResult(quick, target.url)
                return@evaluateJavascript
            }
            webView.evaluateJavascript(PageProbe.JS_BODY) { rawBody ->
                val body = PageProbe.decodeJsString(rawBody)
                recovery.handleProbeResult(PageProbe.classify(title, body), target.url)
            }
        }
    }

    /**
     * 删除某一类 cookie。**判断不在方法里**，`pocket` 由 [RecoveryExecutor] 决定，
     * 这里只负责「取出名字 → 逐个写过期值 → flush」。
     *
     * Android 的 CookieManager 没有「按名字前缀删」的 API，只能把现有 cookie 取出来、
     * 对要删的逐个 setCookie 成过期值。删完要 flush()，否则下个请求可能还带旧值。
     *
     * 为什么只删一类（历史上踩过）：WebView 里除了 `dsh-auth-*` 还有 `dsh_pocket_token` ——
     * 那是用户输 PIN 换来的局域网会话。全清等于把人踢回「访问验证」页，
     * 而那个页面里没有 PIN 可填（用户早忘了），表现就是「自愈之后彻底进不去了」。
     */
    private fun clearCookies(url: String, pocket: Boolean) {
        val cm = CookieManager.getInstance()
        val targets = CookieNames.selectForRemoval(cm.getCookie(url), pocket)
        targets.forEach { name -> cm.setCookie(url, CookieNames.expiryDirective(name)) }
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

    /**
     * 渲染进程没了 —— 重建 WebView，别让整个 App 跟着死。
     *
     * 为什么必须有这个兜底：不覆盖 `WebViewClient.onRenderProcessGone` 时，系统的默认行为是
     * **杀掉宿主进程**，用户看到的就是「用着用着闪退」。而渲染进程被回收在这台机器上是常态，
     * 不是理论风险 —— 第 7e 步的 logcat 里就抓到过：
     *
     * ```
     * ProcessSceneCleaner: SwipeUpClean: kill procName=com.google.android.webview:sandboxed_process0:…
     * ```
     *
     * 渲染进程一死，那个 WebView 实例就永久失效：`loadUrl` 不报错也不加载，界面停在最后一帧，
     * 既不能靠自愈救，也不能靠返回键脱身。唯一出路是换一个新 WebView。
     *
     * 这里**必须**把死掉的 WebView 从视图树里摘掉并 `destroy()`，否则会在 ViewRootImpl 里
     * 留下一个永不绘制的子 View，且它仍持有旧的 client 与 JS 桥。
     *
     * @param didCrash true=渲染进程崩溃（页面代码把它搞挂了），false=被系统回收（内存压力）。
     *   两种都要重建；区分只用于日志——崩溃的话日志里能看到是哪次页面操作引起的。
     */
    internal fun onRenderProcessGone(didCrash: Boolean) {
        android.util.Log.w("DshRemote", "render process gone (didCrash=$didCrash), rebuilding webview")
        val target = current
        rebuildWebView()
        if (target == null) {
            showList()
            return
        }
        // 新 WebView 是干净的，当前入口的 URL 里仍带着 ?token=，直接重新走一遍握手。
        // 这是一次新的连接，闸门预算也要重置，否则会被上一轮的退避挡住。
        recovery.reset()
        listRoot.visibility = View.GONE
        webView.visibility = View.VISIBLE
        progress.visibility = View.VISIBLE
        progress.progress = 0
        applyBarIconTheme(darkBackground = true)
        webView.loadUrl(target.url)
    }

    /**
     * 换一个新的 WebView 进来，旧的销毁。
     *
     * 新实例插在 [progress] 之前，保持 `listRoot → webView → progress` 的层叠顺序
     * （进度条必须在最上层，否则会被整页 WebView 盖住）。
     *
     * 销毁顺序与 [onDestroy] 一致，理由见那里的注释：先摘出视图树、再断开所有指向
     * 本 Activity 的引用，最后 destroy。
     */
    private fun rebuildWebView() {
        if (this::webView.isInitialized) {
            root.removeView(webView)
            webView.webViewClient = android.webkit.WebViewClient()
            webView.webChromeClient = null
            webView.removeJavascriptInterface(WebViewFactory.JS_BRIDGE_NAME)
            webView.stopLoading()
            webView.loadUrl(BLANK_PAGE)
            webView.removeAllViews()
            webView.destroy()
        }
        val fresh = WebViewFactory.create(this).apply { visibility = View.GONE }
        val index = if (this::progress.isInitialized) root.indexOfChild(progress) else -1
        if (index >= 0) root.addView(fresh, index) else root.addView(fresh)
        webView = fresh
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
                    val action = backDecider.decide(isWebViewVisible = true, location = where)
                    android.util.Log.i("DshRemote", "back: layer=$where action=$action")
                    when (action) {
                        // 下面四个分支都是「只退一层」，谁都不许顺手把页面拉回首页
                        BackNavigationDecider.Action.CLOSE_PANEL -> {
                            backDecider.noteWentBack()
                            webView.evaluateJavascript(WebViewFactory.DSH_CLOSE_PANEL_JS, null)
                        }
                        BackNavigationDecider.Action.DISMISS_OVERLAY -> {
                            backDecider.noteWentBack()
                            webView.evaluateJavascript(WebViewFactory.DSH_PRESS_ESCAPE_JS, null)
                        }
                        BackNavigationDecider.Action.COLLAPSE_SIDEBAR -> {
                            backDecider.noteWentBack()
                            webView.evaluateJavascript(WebViewFactory.DSH_PRESS_ESCAPE_JS, null)
                        }
                        BackNavigationDecider.Action.LEAVE_FEATURE,
                        BackNavigationDecider.Action.GO_TO_START -> {
                            backDecider.noteWentBack()
                            // 回首页只能点侧栏「新会话」—— 实测唯一真·轻量切换。
                            // 侧栏此时可能已经收起（上一个返回动作收的），
                            // DSH_GO_HOME_JS 里对屏外元素的 click() 照样生效（第 18 步实测）。
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

    /**
     * 字号 / 深色模式变化时**不重建 Activity**。
     *
     * 病灶：manifest 的 `configChanges` 原来只有 `orientation|screenSize|keyboardHidden|screenLayout`。
     * 用户去系统设置里调一次字体大小，Activity 就被 relaunch —— 实测 logcat
     * `WindowManager: finishDrawing of relaunch: Window{... com.dsh.remote/.MainActivity} 290ms`，
     * 页面重新加载回 `HARNESS / Loading plugins…`，DSH 那边正在跑的会话界面全部丢状态。
     * 这不是「样式没跟上」，是一次完整的重建。
     *
     * 所以把 `fontScale|uiMode` 加进 `configChanges`，并在这里显式处理：
     *   · 字号变了 —— 连接列表是代码构造的 TextView，字号取的是固定 `textSize`（sp），
     *     系统缩放会自然生效，只需重建列表视图让它按新密度量一遍；
     *   · WebView 里的页面自己按 CSS 走，我们不动它（强刷会丢会话状态，那正是要避免的）；
     *   · uiMode（深色/浅色）变了 —— 本项目没有 `values-night`，主题不变，
     *     但状态栏前景跟着页面底色走这件事要重新确认一次。
     *
     * 不做 `super` 之后的额外重建：`onConfigurationChanged` 的契约就是「我自己处理了」。
     */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        if (this::savedRows.isInitialized) refreshSavedList()
        if (this::webView.isInitialized && webView.visibility == View.VISIBLE) {
            applyBarIconTheme(darkBackground = true)
        }
    }

    override fun onDestroy() {
        // 停掉局域网扫描：一轮是 254 个 TCP 连接，用户已经退出还继续发既是浪费，
        // 也会让下一次进入时的日志里混进上一轮的 onDone。
        lanDiscovery.cancel()
        if (this::webView.isInitialized) {
            // 先撤掉还在排队的延迟任务。健康复查那个 Runnable 活 1.4 秒，
            // 不取消就会在已销毁的 WebView 上跑（`isFinishing` 只是兜底，不是取消）。
            healthRecheck?.let { webView.removeCallbacks(it) }
            healthRecheck = null
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
         * 「还没有保存的连接」的默认文案。
         *
         * 单独提出来是因为它会被扫描过程临时改写（见 [LAN_SEARCHING_HINT]），
         * 扫描结束后必须一个字不差地还原 —— 内联两处字面量迟早会改漏一边。
         */
        const val EMPTY_HINT = "还没有保存的连接。\n装好后会自动扫一遍同一 Wi-Fi 下的电脑；\n扫不到就扫电脑上的二维码，或在下方手动填地址。"

        /** 正在扫局域网时占位在「已保存的连接」位置上的文案。 */
        const val LAN_SEARCHING_HINT = "正在同一 Wi-Fi 下查找电脑…（约 2 秒）"

        /**
         * 「提醒但不用报错色」的橙。
         *
         * 与 `@color/warn`（#B45309）语义相同、色值不同 —— 历史遗留。这里统一成一个
         * 常量，代码里不再出现裸的 `0xFFB26B00`，以后要改成 `@color/warn` 只改这一行。
         */
        val WARN = 0xFFB26B00.toInt()

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
         * 上游会话 cookie 的前缀与局域网 PIN 会话的名字都在 [CookieNames] 里 ——
         * 那两类 cookie 一旦搞混就会把用户锁在验证页外，所以连同「怎么筛」
         * 一起做成了纯 JVM 对象，有单测兜着。这里只留指向。
         */
        val AUTH_COOKIE_PREFIX = CookieNames.AUTH_PREFIX

        /**
         * dsh-pocket 的局域网会话 cookie（`HttpOnly`，值 = `sha256(PIN:sessionKey)`）。
         *
         * 它的真实寿命 = **dsh web 进程从启动到关闭**：`sessionKey` 是进程级随机数
         * （dsh-pocket `lib/index.js:331-333`），Harness 一重启就换新，旧的必然失配。
         * 失配本身不可怕，可怕的是 `maybeSeedAuthCookie`（`proxy.mjs:509-525`）看到
         * 请求里**有任何** `dsh_pocket_token` 就 `return`，拒绝下发新的 —— 于是带着
         * `?token=` 也停在「访问验证」页。见 [RecoveryPlanner] 顶部的实测对照。
         */
        val POCKET_COOKIE = CookieNames.POCKET

        /**
         * 用来把 WebView 从 Chromium 内部错误页里推出来。
         *
         * 主页面加载失败后页面会停在 `chrome-error://chromewebdata/`。加载这个空白页
         * 可以清掉那个状态，避免错误页在下次显示时闪一帧。
         * **注意**：曾误以为不清错误页会导致下一次 `loadUrl` 被短路，那是 `input tap`
         * 被 MIUI 拒绝注入造成的假阴性，详见 [onPageError] 的说明。
         */
        const val BLANK_PAGE = "about:blank"
    }
}

