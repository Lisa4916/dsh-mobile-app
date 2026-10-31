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
                // 只在自己这台电脑的入口里跳转，外部链接交给系统浏览器
                val sameHost = host.endpointHost?.let { url.contains(it, ignoreCase = true) } ?: false
                if (!sameHost && (url.startsWith("http://") || url.startsWith("https://"))) {
                    host.openExternal(url)
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                // 页面就绪后再注入回调函数：太早注入会被页面自身的导航覆盖掉
                view.evaluateJavascript(KEYBOARD_HOOK_JS, null)
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
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                host.onProgress(newProgress)
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
        wv.addJavascriptInterface(WebBridge(host), "dshNative")

        return wv
    }

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
        }
    }

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
