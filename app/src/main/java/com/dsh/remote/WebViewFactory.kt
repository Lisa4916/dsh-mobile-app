package com.dsh.remote

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * WebView 的集中配置。
 *
 * 为什么单独放一个类：MainActivity 里如果有多处 new WebView（比如重连时重建），
 * 配置漏一项就会出现「首次能连、重连后白屏」这类难查的问题。
 * 所有 WebView 都从这里出，配置只有一份。
 */
object WebViewFactory {

    /** 目标站点是 dsh-pocket 的移动端适配页面，需要 JS、DOM Storage 与一个现代 UA。 */
    @SuppressLint("SetJavaScriptEnabled")
    fun create(host: MainActivity): WebView {
        val wv = WebView(host)
        wv.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )

        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            cacheMode = WebSettings.LOAD_DEFAULT
            // dsh-pocket 注入的移动端适配依赖 UA 判断，保留系统默认 UA 即可，
            // 但要去掉 “wv” 标记，否则个别站点会判定为不支持内嵌浏览器。
            userAgentString = userAgentString.replace("; wv", "")
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: android.webkit.WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // 只在自己这台电脑的入口里跳转，外部链接交给系统浏览器。
                //
                // 判定必须比 host，不能比「字符串里有没有出现 host」——那是子串包含，
                // https://evil.com/?x=<host> 与 https://<host>.evil.com/ 都会命中，
                // 外部页面就留在没有地址栏的 WebView 里（还挂着 dshNative JS 桥）。
                // 规则与全部反面用例见 HostMatch / HostMatchTest。
                if (HostMatch.shouldOpenExternally(url, host.endpointHost)) {
                    host.openExternal(url)
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                // 页面就绪后再注入回调函数：太早注入会被页面自身的导航覆盖掉
                view.evaluateJavascript(KEYBOARD_HOOK_JS, null)
                // 兜底复查：页面可能已经把焦点放在输入框上（点侧边栏进会话就是这条路径），
                // 造成底部那条键盘区凭空让位。轮询几次，因为聚焦时机在半秒到一秒之间浮动。
                scheduleFocusSweep(view)
                host.onPageFinished(url)
            }

            override fun onReceivedError(
                view: WebView,
                request: android.webkit.WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                // 只关心主页面失败；子资源失败（插件 client.js 之类）不该把页面判死
                if (request.isForMainFrame) {
                    host.onPageError(error.errorCode, error.description?.toString())
                }
            }

            /**
             * 渲染进程被系统回收或崩溃。
             *
             * 不覆盖这个方法的默认后果是**整个 App 进程被杀**（系统的兜底是"宿主也一起死"），
             * 用户看到闪退。这里返回 true 表示「我自己处理了」，把控制权留在 Activity 里，
             * 由 [MainActivity.onRenderProcessGone] 换一个新的 WebView 重新连。
             *
             * 这台机器上渲染进程被清是常态，logcat 抓到过：
             * `ProcessSceneCleaner: SwipeUpClean: kill procName=…:sandboxed_process0:…`
             */
            override fun onRenderProcessGone(
                view: WebView,
                detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
                // didCrash() 是 API 26 才有的；minSdk 24 上这个方法本身就不会被回调
                // （onRenderProcessGone 也是 API 26 加入 WebViewClient 的），
                // 这里的版本判断只是为了让 lint 的 NewApi 检查放行，不是活代码。
                val didCrash = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O &&
                    detail.didCrash()
                host.onRenderProcessGone(didCrash)
                return true
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                host.onProgress(newProgress)
            }

            // onReceivedTitle 属于 WebChromeClient（不是 WebViewClient）：用于识别
            // dsh-pocket 的「无法完成登录握手」提示页并自愈，见 MainActivity.onReceivedTitle
            override fun onReceivedTitle(view: WebView, title: String?) {
                host.onReceivedTitle(title)
            }
        }

        // 底色必须与 DSH 页面 body 实测色一致（CDP: rgb(21,21,23)）。
        // 差一点点就会在键盘动画、页面切换、下拉回弹时看到一条异色边。
        wv.setBackgroundColor(0xFF151517.toInt())

        // 启动落点修正：DSH 前端把上次打开的会话记在 localStorage['dsh.sessions.current']，
        // 下次加载就按它自动跳回那个对话——哪怕 URL 是干净的根路径。
        // 用户要的是「打开软件进主界面」，所以在 DSH 读到这个键之前删掉它。
        // 必须 document-start 注入（不是 onPageFinished）：后者太晚，页面已按旧键渲染出
        // 旧对话，删键后还得再刷一次，会「先闪一眼旧对话再跳回主界面」。
        installHomeResetOnStart(wv)

        // 原生桥：页面可查键盘高度（见 WebBridge 注释）
        wv.addJavascriptInterface(WebBridge(host), JS_BRIDGE_NAME)

        return wv
    }

    /**
     * 注入给页面的 JS 桥对象名。
     *
     * 抽成常量是为了 `onDestroy` 里能用同一个名字 `removeJavascriptInterface`
     * —— 名字写两处、改一处忘另一处的话，卸载就静默失效了。
     */
    const val JS_BRIDGE_NAME = "dshNative"

    /**
     * 输入框自动聚焦守卫。
     *
     * 用户要的行为：「进入会话不用直接开启键盘区，点了输入框才开」。
     *
     * 病灶：DSH 前端在会话页渲染完就把焦点抢到输入框上（真机实测 `document.activeElement`
     * 就是 `.GRgSLq_input`），底部那条键盘区在用户什么都没点的情况下已经让出 321px。
     *
     * 判法必须精确到**触摸落点**，不能只看「这段时间里有没有摸过屏幕」。
     * 上一版就是后者，结果漏了一个真实场景：用户点左侧工作区里的某个会话 —
     * 那也是一次触摸，于是给了许可，页面紧接着自动聚焦输入框被放行，
     * 键盘区照样拉起来了。用户的原话是「在左侧工作区点入某个对话还是拉起键盘区」。
     *
     * 所以现在：只有**触摸点落在某个输入框的矩形内**才发许可，且许可是**一次性**的
     * （focusin 用掉就清），过期时间也压短到 1 秒 —— 点完输入框之后再来的自动聚焦
     * 一律照旧回退。
     *
     * 用矩形包含判断而不是 `elementFromPoint`：后者受 pointer-events、遮罩层影响，
     * 而且对 adb 合成的触摸不稳；矩形判断只依赖几何，可靠得多。
     *
     * 必须在 document-start 注册：等到 onPageFinished 时页面已经聚焦过了。
     */
    private const val FOCUS_GUARD_JS = """
        (function(){
          if (window.__dshFocusGuard) return;
          window.__dshFocusGuard = true;

          var allowUntil = 0;

          function isTextField(el){
            if (!el) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return true;
            return el.isContentEditable === true;
          }

          /**
           * 触摸点是否真的点在这个输入框上。
           *
           * 不能只做矩形包含判断 —— 真机上复现过这个坑：点左侧工作区里某个会话时，
           * 手指坐标 (126,533) 恰好压在**下层**输入框的矩形里（输入框 y 484~536、x 16~366），
           * 于是被误判成「用户点了输入框」，许可发出去，页面随后自动聚焦，键盘区就被拉起来了。
           *
           * 侧栏是浮在上面的，所以必须问「这一点的最顶层元素是谁」。
           * elementFromPoint 早先被认为对 adb 合成触摸不稳，问题其实出在别处（坐标单位），
           * 这里坐标已经是 CSS 像素，可以直接用。
           */
          function pointHitsTextField(x, y){
            if (typeof x !== 'number' || typeof y !== 'number') return false;
            if (!document.elementFromPoint) return false;

            // 从命中的最顶层元素往外走几层，看是否落在某个输入框里
            var el = document.elementFromPoint(x, y);
            for (var i = 0; i < 5 && el; i++) {
              if (isTextField(el)) return true;
              el = el.parentElement;
            }
            return false;
          }

          function onDown(e){
            // 坐标来源要挑准：adb 合成的触摸里，touchstart 的 clientX/Y 会是 0,0
            // （真机实测 `touchstart@0,0` 而同一个手势的 `pointerdown@193,825` 才是对的），
            // 拿 0,0 去问 elementFromPoint 只会得到左上角那个元素，判定必然错。
            // 所以优先用 pointer/mouse 事件的坐标，touch 坐标只在它是有效值时才采信。
            var x = null, y = null;
            if (typeof e.clientX === 'number' && typeof e.clientY === 'number' && (e.clientX || e.clientY)) {
              x = e.clientX; y = e.clientY;
            } else if (e.touches && e.touches[0] && (e.touches[0].clientX || e.touches[0].clientY)) {
              x = e.touches[0].clientX; y = e.touches[0].clientY;
            } else if (e.changedTouches && e.changedTouches[0]) {
              x = e.changedTouches[0].clientX; y = e.changedTouches[0].clientY;
            }
            if (x === null || y === null) return;
            if (!pointHitsTextField(x, y)) return;
            // 一次性许可：1 秒内有效，focusin 拿到就作废
            allowUntil = Date.now() + 1000;
            window.__dshFocusGuardLastHit = { x: x, y: y, at: Date.now() };
          }

          ['pointerdown','touchstart','mousedown'].forEach(function(ev){
            window.addEventListener(ev, onDown, true);
          });

          document.addEventListener('focusin', function(e){
            var t = e.target;
            if (!isTextField(t)) return;
            if (Date.now() < allowUntil) {
              allowUntil = 0; // 用掉即作废，后面的自动聚焦不再放行
              return;
            }
            // 非「点输入框」引发的聚焦 → 立刻回退，别让页面为键盘让位
            try {
              t.blur();
              var sel = window.getSelection && window.getSelection();
              if (sel && sel.removeAllRanges) sel.removeAllRanges();
            } catch (err) {}
          }, true);
        })();
    """

    /**
     * 注册「开机落主界面」的 document-start 脚本。
     *
     * 只清一次：用 sessionStorage 做一次性标记。sessionStorage 的寿命是本 WebView 实例，
     * 即一次冷启动——这正好等于「每次打开软件」的语义。
     * 这样进程内后续的页面重载（进某个会话、断线重连）不会反复踢回主界面。
     *
     * 老系统 WebView 不支持该特性时直接放弃：顶多回落到上次的对话，不影响可用性。
     */
    private fun installHomeResetOnStart(wv: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(wv, HOME_RESET_JS, setOf("*"))
            // 输入框自动聚焦守卫必须也走 document-start：DSH 在会话页渲染完成时就会
            // 把焦点抢到输入框上，等到 onPageFinished 再注入已经晚了 —— 那时页面
            // 早就为键盘让出过位（真机实测 rootH 574 / kb 321px，而键盘其实没弹）。
            WebViewCompat.addDocumentStartJavaScript(wv, FOCUS_GUARD_JS, setOf("*"))
            // 新 API 缺失补丁必须也是 document-start：DSH 前端模块在初始化时就会调用
            // Promise.withResolvers，晚一步注入等于没注入（页面已经抛异常停在那儿了）。
            WebViewCompat.addDocumentStartJavaScript(wv, POLYFILL_JS, setOf("*"))
            // 侧栏「启动时滑一下」必须在 document-start 就压住：等 onPageFinished 再注入，
            // 那段 280ms 的过渡早就演完了（实测 3139ms 起、3463ms 结束，而页面 load 事件 2245ms
            // 之后还要等 hydration 才动侧栏 —— 晚一步就完全错过）。
            WebViewCompat.addDocumentStartJavaScript(wv, NO_SIDEBAR_FLASH_JS, setOf("*"))
        }
    }

    /**
     * 给旧系统 WebView 补上 DSH 前端依赖的新 API。
     *
     * 起因（第二台设备 XT2335-3 / Android 14 实测）：系统 WebView 只有
     * **117.0.5938.60**，而 DSH 前端用到了 Chrome 119 才有的 `Promise.withResolvers`。
     * 表现不是白屏，而是页面能画出来、却卡在「正在加载工作区…」，logcat 里反复看到：
     *     Uncaught TypeError: Promise.withResolvers is not a function
     *     [session-controller] control stream failed: ...
     *     archive-manager: load favorites failed ... 服务尚未就绪
     * 也就是说网络与鉴权都是通的（`dsh-auth-*` cookie 正常下发），纯粹是 JS 运行时太旧。
     *
     * 在这台设备上实测探测到的缺失项只有三个：
     *     Promise.withResolvers   (Chrome 119+)
     *     Array.fromAsync         (Chrome 121+)
     *     RegExp.escape           (Chrome 136+)
     * 其余 16 个常用新 API（toSorted / toReversed / Object.groupBy / structuredClone /
     * findLast / AbortSignal.timeout / crypto.randomUUID / Intl.Segmenter …）都已具备。
     *
     * 只补这三个，不做大而全的 core-js —— 补丁越小，越不容易和页面自身的行为冲突。
     * 每一项都先判断「已经有了就跳过」，所以在新设备上这段代码等于空转。
     */
    private const val POLYFILL_JS = """
        (function(){
          try {
            if (typeof Promise.withResolvers !== 'function') {
              // 语义：返回 { promise, resolve, reject }，且 resolve/reject 不依赖 this
              Promise.withResolvers = function(){
                var resolve, reject;
                var promise = new Promise(function(res, rej){ resolve = res; reject = rej; });
                return { promise: promise, resolve: resolve, reject: reject };
              };
            }
          } catch (e) {}

          try {
            if (typeof Array.fromAsync !== 'function') {
              // 语义：对 async iterable / iterable / array-like 逐个 await 后收集
              Array.fromAsync = function(input, mapFn, thisArg){
                return (async function(){
                  var out = [];
                  var i = 0;
                  if (input != null && typeof input[Symbol.asyncIterator] === 'function') {
                    for await (var v of input) {
                      out.push(mapFn ? await mapFn.call(thisArg, v, i++) : v);
                    }
                    return out;
                  }
                  var items = input == null ? [] : Array.from(input);
                  for (var j = 0; j < items.length; j++) {
                    out.push(mapFn ? await mapFn.call(thisArg, items[j], j) : items[j]);
                  }
                  return out;
                })();
              };
            }
          } catch (e) {}

          try {
            if (typeof RegExp.escape !== 'function') {
              // 语义：把字符串转义成可安全嵌入正则的形式；空白与常见元字符都要处理
              RegExp.escape = function(str){
                var s = String(str);
                var out = '';
                for (var i = 0; i < s.length; i++) {
                  var c = s.charAt(i);
                  if ('^$\\.*+?()[]{}|/'.indexOf(c) !== -1) {
                    out += '\\' + c;
                  } else if ('\t\n\v\f\r '.indexOf(c) !== -1) {
                    // 控制字符与空白用 \x 形式表达，避免在字符类里被当成量化目标
                    out += '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
                  } else {
                    out += c;
                  }
                }
                return out;
              };
            }
          } catch (e) {}
        })();
    """

    /**
     * 页面就绪后连查几次焦点，把非用户意图的聚焦压下去。
     *
     * 时序实测：点侧栏进会话后，约 0.3~0.8 秒内键盘区就被拉起（rootH 574 / kb 321px），
     * 而聚焦具体落在哪一拍并不稳定。所以取一组递增延迟 0.2/0.5/0.9/1.4 秒各查一次，
     * 每次都是一句 JS 求值，开销可以忽略。
     */
    private fun scheduleFocusSweep(view: WebView) {
        longArrayOf(200L, 500L, 900L, 1_400L).forEach { delay ->
            view.postDelayed({
                if (view.isAttachedToWindow) {
                    view.evaluateJavascript(FORCE_BLUR_IF_UNTOUCHED_JS, null)
                }
            }, delay)
        }
    }

    /**
     * 页面就绪后的兜底：若焦点停在输入框上、且不是用户刚点过的，就强制失焦。
     *
     * 为什么要轮询而不是查一次：点侧栏进会话是**同页内视图切换**，新视图挂载、
     * 自动聚焦的时机并不固定在 onPageFinished 后 250ms —— 实测会在半秒到一秒之间
     * 陆续发生。查一次很容易扑空，查几次成本几乎为零（一次 JS 求值）。
     *
     * 判定同样只看「用户最近是否点过输入框」：页面把每次合法点击记录在
     * `__dshFocusGuardLastHit`，这里比对时间戳即可。
     */
    const val FORCE_BLUR_IF_UNTOUCHED_JS = """
        (function(){
          try {
            var ae = document.activeElement;
            if (!ae) return '0';
            var isField = ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable === true;
            if (!isField) return '0';
            var hit = window.__dshFocusGuardLastHit;
            // 2 秒内有过「点输入框」的记录 → 这是用户自己要的，不动
            if (hit && Date.now() - hit.at < 2000) return '0';
            ae.blur();
            var sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
            // 焦点清掉后，页面可能还留有键盘让位留下的高度，一并复位
            var r = document.getElementById('root');
            if (r && r.style.height) r.style.height = '';
            document.documentElement.style.setProperty('--dsh-native-keyboard', '0px');
            return '1';
          } catch (e) { return '0'; }
        })();
    """

    /**
     * 检查当前是否停在 DSH 的「开始界面」（会话列表/首页），并返回状态字符串。
     *
     * 返回值约定：
     *  - `"home"`：在开始界面
     *  - `"session"`：在某个会话里
     *  - `"other"`：还没加载完 / 认不出（调用方应当不动手）
     *
     * 判据全部取自真机实测的正文特征：
     *  - 开始界面含「探索未至之境」+「描述你想要构建的内容」（首页 hero 区）
     *  - 会话页含「对话」「轨迹」两个 tab（首页没有这对 tab）
     *
     * 为什么不用 `history.length` / URL：DSH 是纯 SPA，实测进会话后
     * `location.href` 与 `history.length` **都不变**（进会话前后都是 2），
     * 所以 WebView 的历史栈里根本没有「会话」这一层，`canGoBack()` 拿不到它。
     */
    const val DSH_LOCATION_JS = """
        (function(){
          try {
            function visible(el){
              if(!el) return false;
              var cs=getComputedStyle(el), r=el.getBoundingClientRect();
              if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)<0.05) return false;
              return r.width>8 && r.height>8;
            }
            // 1) 带「关闭xxx」按钮的浮层（会话知识库那种面板）
            var closers=document.querySelectorAll('button,[role=button]');
            for(var i=0;i<closers.length;i++){
              var al=closers[i].getAttribute('aria-label')||'';
              if(al.indexOf('关闭')===0 && visible(closers[i])) return 'panel';
            }
            // 2) 菜单 / 下拉 / 对话框
            var ov=document.querySelectorAll('[role=menu],[role=listbox],[role=dialog]');
            for(var j=0;j<ov.length;j++) if(visible(ov[j])) return 'overlay';
            // 3) 左抽屉展开（实测收起态 left≈-209，展开态 0）
            var s=document.querySelector('[class*="_sidebarCol"]');
            if(s && s.getBoundingClientRect().left>-40) return 'sidebar';
            var b = (document.body ? document.body.innerText : '') || '';
            if (b.length === 0) return 'other';
            // 4) 会话页（「对话」「轨迹」这对 tab 只有会话页有）。
            //    ★ 必须排在 feature 之前：会话页也有 aria-selected="true"（「对话」那个 tab），
            //    先判 feature 会把会话页当功能视图 —— 实测就判错过一次。
            if (b.indexOf('对话') !== -1 && b.indexOf('轨迹') !== -1) return 'session';
            // 5) 侧栏功能视图：靠 [aria-current] 认，首页/会话页都没有这个属性
            var cur=document.querySelector('[aria-current="page"],[aria-current="true"],[aria-selected="true"]');
            if(cur){
              var t=((cur.getAttribute('aria-label')||cur.innerText||'')+'').trim();
              if(t && t!=='新会话') return 'feature';
            }
            // 6) 首页
            if (b.indexOf('探索未至之境') !== -1) return 'home';
            if (b.indexOf('描述你想要构建的内容') !== -1) return 'home';
            if (b.indexOf('发消息或创建任务') !== -1) return 'home';
            if (b.indexOf('选择一个工作区开始') !== -1) return 'home';
            return 'other';
          } catch (e) { return 'other'; }
        })();
    """

    /**
     * 给页面发一个 Escape 键 —— 菜单浮层和左抽屉都自己认这个键，语义正好是「退一层」。
     *
     * 为什么优先用 Escape 而不是「找关闭按钮点」：真机实测（`tools/probe-escape.cjs`）
     * 页面自己对 Escape 的处理是**幂等退一层**，而且走的是它自己的关闭动画与状态回收；
     * 我们手动点按钮容易点错同名的元素（页面上有多个 `关闭`）。
     *
     * 实测覆盖：首页+菜单 ✅、首页+抽屉 ✅、会话页+抽屉 ✅（退出到 `feature` 时抽屉收起、
     * 功能视图本身不动 —— 这正是「只退一层」）。
     * **管不了的两层**：会话知识库那种带「关闭xxx」的 panel，以及会话页本身。
     */
    const val DSH_PRESS_ESCAPE_JS = """
        (function(){
          try {
            var o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};
            var t=document.activeElement||document.body||document.documentElement;
            t.dispatchEvent(new KeyboardEvent('keydown',o));
            t.dispatchEvent(new KeyboardEvent('keyup',o));
            return 'sent';
          } catch(e){ return 'err'; }
        })();
    """

    /**
     * 点掉最上面那个浮层自己的「关闭」按钮（会话知识库那种 panel）。
     *
     * 为什么不能用 Escape：实测这一层对 Escape **完全无反应**（`layerN 0→2→2`）。
     * 页面上会同时存在 `关闭` 与 `关闭会话知识库` 两个 aria-label，点哪个都行；
     * 这里取**第一个可见的**，因为 `关闭` 是最外层、语义最明确。
     */
    const val DSH_CLOSE_PANEL_JS = """
        (function(){
          try {
            function visible(el){
              if(!el) return false;
              var cs=getComputedStyle(el), r=el.getBoundingClientRect();
              if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)<0.05) return false;
              return r.width>8 && r.height>8;
            }
            var bs=document.querySelectorAll('button,[role=button]');
            for(var i=0;i<bs.length;i++){
              var al=bs[i].getAttribute('aria-label')||'';
              if(al.indexOf('关闭')===0 && visible(bs[i])){ bs[i].click(); return 'ok'; }
            }
            return 'nf';
          } catch(e){ return 'err'; }
        })();
    """

    /**
     * 把 DSH 退回开始界面（会话列表/首页）—— **轻量视图切换，不重载页面**。
     *
     * 为什么不能用 `location.reload()`：那会让前端重走整个启动流程（插件重新加载、
     * 首屏重绘、再读一次会话恢复键），视觉上就是「退出软件再重进」。用户明确指出过两次。
     *
     * 实测结论（`tools/probe-home-entry.mjs` 探测所得，判据是「页面内挂在 window 上的标记
     * 是否还在」——reload 必丢、视图切换不丢）：
     *  - 点顶部会话切换器 `mOxcpG_main` / `mOxcpG_chevron`：无变化
     *  - 派发 Escape 键：无变化
     *  - **点侧栏「新会话」按钮 `wtg9ga_newSession`：切到 home 且标记仍在 → 真·轻量切换**
     *
     * ## 为什么不能先展开侧栏（2026-11 修正，用户实测反馈「滑动返回时闪屏、侧边栏闪动」）
     *
     * 旧实现是「先点顶部开关把侧栏滑出来 → 轮询等 `newSession` 进入屏幕 → 再点它」。
     * 功能上确实回到了 home，但**视觉上整个侧栏要从左边滑出再滑回**，用户看到的就是
     * 一条黑边横扫屏幕。CDP 连拍抓到的现场（`tools/record-back.cjs`）：
     * ```
     * [1] sideL=-308 side=wtg9ga_fading going=true      ← 侧栏开始滑出
     * [2] sideL=   0 side=wtg9ga_fading                 ← 侧栏完全展开
     * [3] sideL=-216 side=wtg9ga_collapsed              ← 收回
     * [7] … hero=true                                   ← 这时才回 home
     * ```
     * 也就是说「展开侧栏」这个中间步骤纯属多余动作。
     *
     * **修正后：收起态下直接 `.click()` 屏外的 `newSession` 按钮就能回 home。**
     * 实测（`tools/eval-page.cjs`，3 轮全通过）：`sideL` 全程稳定在 -217 不动，
     * window 标记存活（页面未重载），hero 出现。原因很朴素 —— DOM 的 `click()`
     * 派发的是合成事件，**不经过命中测试**，元素在屏幕外照样收到 click；
     * 之前那条「left 是负数所以 click 无效」的结论是错的（当时用坐标点击验的，
     * 屏外坐标本来就点不到，把「坐标点不到」误当成「click 无效」）。
     *
     * ## 保留的兜底
     * 万一将来版本改成「屏外按钮忽略合成 click」，`home()` 会校验结果（`reachedHome()`），
     * 没成功才退回「展开侧栏」的旧路径。这样既保证视觉干净，又不会在某次升级后
     * 变成一个按了没反应的返回键。
     *
     * 用 `setTimeout` 而不是 `requestAnimationFrame`：rAF 在页面不可见 / 窗口过渡动画
     * 期间会被完全暂停，而「按下返回」那一刻恰好就是这种状态，用 rAF 会让整个流程卡死。
     */
    const val DSH_GO_HOME_JS = """
        (function(){
          if (window.__dshGoingHome) return;
          window.__dshGoingHome = true;

          var started = Date.now();
          // 直接点屏外按钮到页面切完，真机实测要 **约 2.0 秒**（DSH 内部有过渡动画，
          // 1996ms / 54 次 25ms 轮询）。这个值必须留足余量，否则会误判成「点了没反应」
          // 而走上兜底路径 —— 那就又把侧栏滑出来了，等于白改。
          var DIRECT_MS = 2400;
          var FALLBACK_MS = 2600; // 兜底路径（展开侧栏）的总时限

          function body(){
            return (document.body ? document.body.innerText : '') || '';
          }

          function reachedHome(){
            var b = body();
            // 顺序不能反：会话页的 DOM 里**同时**留着「探索未至之境」与
            // 「描述你想要构建的内容」（新会话面板没被卸载），所以必须先排除会话页。
            // 这条实测踩过：先查 hero 会把会话页误判成已经在 home，
            // 于是整个函数直接 return，返回键变得完全没反应。
            var tabs = b.indexOf('对话') !== -1 && b.indexOf('轨迹') !== -1;
            if (tabs) return false;
            if (b.indexOf('探索未至之境') !== -1) return true;
            if (b.indexOf('描述你想要构建的内容') !== -1) return true;
            if (b.indexOf('发消息或创建任务') !== -1) return true;
            if (b.indexOf('选择一个工作区开始') !== -1) return true;
            return false;
          }

          function newSession(){
            return document.querySelector('.wtg9ga_newSession');
          }

          function isVisible(el){
            if (!el) return false;
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.left >= 0 && r.left < window.innerWidth;
          }

          // 收起态下，侧栏开关可能是「顶部、无类名」的 button，也可能带 aria-label
          function findHeaderToggle(){
            var byAria = document.querySelector('[aria-label="打开侧边栏"]');
            if (byAria) return byAria;
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
              var b = btns[i];
              if (!b.getBoundingClientRect) continue;
              var r = b.getBoundingClientRect();
              if (r.width < 20 || r.height < 20) continue;
              if (r.top > 60) continue;
              if (b.className) continue;
              if (r.left < 0 || r.left > window.innerWidth) continue;
              return b;
            }
            return null;
          }

          // 阶段一：直接点（不展开侧栏，视觉上零动画）
          function direct(){
            var ns = newSession();
            if (ns) ns.click();
            var t0 = Date.now();
            (function check(){
              if (reachedHome()) { window.__dshGoingHome = false; return; }
              if (Date.now() - t0 > DIRECT_MS) { fallback(); return; }
              setTimeout(check, 40);
            })();
          }

          // 阶段二（兜底）：展开侧栏再点。会有侧栏滑动的视觉，但至少功能可用。
          function fallback(){
            var t0 = Date.now();
            (function tick(){
              if (reachedHome()) { window.__dshGoingHome = false; return; }
              if (Date.now() - t0 > FALLBACK_MS) { window.__dshGoingHome = false; return; }
              var ns = newSession();
              if (isVisible(ns)) { ns.click(); }
              else { var tog = findHeaderToggle(); if (tog) tog.click(); }
              setTimeout(tick, 120);
            })();
          }

          // 已经在 home 就别动 —— 免得平白闪一下侧栏
          if (reachedHome()) { window.__dshGoingHome = false; return; }
          direct();
        })();
    """

    /**
     * 开机落主界面：清掉 DSH 的会话恢复键。
     *
     * 为什么必须在这个时机：DSH 前端在模块初始化时就同步读取
     * `localStorage['dsh.sessions.current']`，读到什么就渲染哪个会话。
     * 只有 document-start 才赶在它前面；onPageFinished 时旧对话已经画完了。
     *
     * 一次性语义：`__dshHomeReset` 打在本 WebView 实例的 window 上。刷新页面会丢，
     * 所以再叠一个 sessionStorage 标记——两者都不落盘，冷启动后自然重置。
     * 这样「每次打开软件进主界面」成立，同时用户点进某个会话后按返回、
     * 或者页面自己重载，都不会被踢回主界面。
     */
    /**
     * 启动时不许侧栏「滑一下」。
     *
     * 现象（真机 ZY22GHMK5F 实测，tools/probe-startup.cjs + tools/probe-sidebar-anim.cjs）：
     * 冷启动约 3.1 秒时，移动端 frame 的侧栏列从 `left=0`（整个露在屏幕里）用一条
     * `transform 0.28s cubic-bezier(0.4,0,0.2,1)` 收到 `-209`。那 280ms 就是用户看到的「闪一下」。
     *
     * 根因不在我们的代码：`data-sidebar-collapsed=true` 在首帧就已经在 DOM 上了
     * （tools/probe-frame-attrs.cjs 抓到 `first-seen` 时 collapsed 已经是 true），
     * 但页面要等 hydration 之后才把 `transform: matrix(...,-208.337,0)` 写上去。
     * DOM 属性先到、样式后到，中间这段就是「展开了又收回去」。
     *
     * 为什么不能改 `DSH_GO_HOME_JS`：启动路径根本不调它（只有按返回键才调），
     * 而且它的入口有 `reachedHome()` 保护。改它只会把返回键弄坏。
     *
     * 为什么只禁 transition、不直接写死 transform：位置该由页面决定，我们只让它「不带动画地就位」。
     * 这样页面以后把侧栏宽度改了、或者用户手动展开，行为都不受影响；
     * 禁掉的仅仅是「第一次就位时的那段过渡」。
     *
     * 选择器用 `[class*="_sidebarCol"]` 而不是完整类名：实测类名是 `mP3x-q_sidebarCol`，
     * 前缀会随 DSH 构建变化，后缀是稳定的语义命名。
     */
    private const val NO_SIDEBAR_FLASH_JS = """
        (function(){
          function mark(){
            try {
              if (document.getElementById('__dshNoSidebarFlash')) return true;
              var parent = document.head || document.documentElement ||
                           document.getElementsByTagName('html')[0];
              if (!parent) return false;
              var st = document.createElement('style');
              st.id = '__dshNoSidebarFlash';
              st.textContent =
                '[data-mobile-nav="frame"] [class*="_sidebarCol"],' +
                '[data-mobile-nav="frame"] [class*="_rightbarCol"] {' +
                'transition:none !important;animation:none !important}';
              parent.appendChild(st);
              return true;
            } catch (e) { return false; }
          }
          if (!mark()) {
            var timer = setInterval(function(){ if (mark()) clearInterval(timer); }, 4);
            document.addEventListener('DOMContentLoaded', mark, { once: true });
          }
        })();
    """

    private const val HOME_RESET_JS = """
        (function(){
          try {
            if (window.__dshHomeReset) return;
            window.__dshHomeReset = true;
            if (sessionStorage.getItem('__dshHomeReset')) return;
            sessionStorage.setItem('__dshHomeReset', '1');
            localStorage.removeItem('dsh.sessions.current');
          } catch (e) {}
        })();
    """

    /**
     * 页面侧的键盘避让控制器。
     *
     * 为什么由页面来动：实测（tools/measure-sync.cjs 同钟对齐）发现，原生改 WebView 高度后
     * `window.innerHeight` 不是逐帧生效的，它把尺寸变化按约 108ms 一批合并提交，
     * 322px 的位移要 897ms 才走完，而键盘本体 456ms 就走完了 —— 界面永远在「一跳一跳地追」。
     * 反过来，页面自己用 rAF 改 CSS 时帧间隔中位数是 12~20ms，与键盘同速。
     *
     * 所以分工是：原生只把「键盘最终多高」推过来一次（跨进程调用不能每帧发），
     * 页面在这里用 rAF 补间 `#root` 的高度。实测 `#root` 高度减多少、输入框就上移多少，1:1。
     *
     * 曲线用 `1-(1-t)^5`，不是拍脑袋：MIUI 输入法窗口走系统传统窗口动画
     * （`wanim=0x01030056` → `res/anim/input_method_enter.xml`，duration=300，
     * interpolator=`decelerate_quint` factor=2.5 → `1-(1-t)^5`）。
     *
     * 另外这一段还挡掉了「进入会话就自动聚焦输入框」：DSH 前端在会话页会把焦点
     * 抢到输入框上，于是用户什么都没点，底部就已经为键盘让出了 321px 的空白
     * （真机实测：`rootH` 574 / `--dsh-native-keyboard` 321px，而 `mInputShown=false`）。
     * 用户要的是「点输入框才开键盘」，所以这里把非用户手势触发的 focus 一律回退，
     * 只放行真实触摸之后的那一次 —— 见下面 __dshAllowFocus 的注释。
     */
    private const val KEYBOARD_HOOK_JS = """
        (function(){
          if (window.__dshKbCtrl) return;
          window.__dshKbCtrl = true;

          var DUR = 300;
          var rafId = 0;
          var curH = 0;
          var targetH = 0;
          var fromH = 0;
          var startT = 0;
          var animating = false;
          var kbH = 0;

          function getRoot(){ return document.getElementById('root'); }
          function ease(t){ return 1 - Math.pow(1 - t, 5); }
          function apply(h){
            var r = getRoot();
            if (r) r.style.height = h.toFixed(1) + 'px';
          }

          function step(now){
            if (!animating) return;
            if (!startT) startT = now;
            var t = Math.min(1, (now - startT) / DUR);
            var h = fromH + (targetH - fromH) * ease(t);
            curH = h;
            apply(h);
            if (t < 1) {
              rafId = requestAnimationFrame(step);
            } else {
              animating = false;
              curH = targetH;
              apply(targetH);
            }
          }

          window.__dshNativeKeyboard = function(h){
            h = h | 0;
            kbH = h;
            var base = window.innerHeight;
            var want = Math.max(0, base - h);
            if (want === targetH && !animating) return;
            var r = getRoot();
            if (!r) return;
            targetH = want;
            fromH = animating ? r.getBoundingClientRect().height : (curH || r.getBoundingClientRect().height || base);
            animating = true;
            startT = 0;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(step);
            try {
              document.documentElement.style.setProperty('--dsh-native-keyboard', h + 'px');
              window.dispatchEvent(new CustomEvent('dsh-native-keyboard', { detail: { height: h } }));
            } catch (e) {}
          };

          window.addEventListener('resize', function(){
            if (animating) return;
            var base = window.innerHeight;
            if (kbH > 0) {
              targetH = Math.max(0, base - kbH);
              curH = targetH;
              apply(targetH);
            } else {
              var r = getRoot();
              if (r) r.style.height = '';
              curH = 0; targetH = 0;
            }
          });
        })();
    """
}
