package com.dsh.remote

/**
 * 判断 DSH 页面「此刻是否正在生成回答」的探针。
 *
 * 为什么要这个类：DSH 的服务端事件走 WebSocket `/api/remote.mux`（见 `dsh-api-gateway` 的
 * `stream-protocol.js`），协议是自家的 Typert 帧格式，App 侧重放这套协议成本高、易碎。
 * 而页面自己已经把这件事写在 DOM 上了：生成中时输入框主按钮的 `aria-label`
 * 会变成「停止生成」。
 *
 * 判据出处（`dsh-client-ui-conversation/lib/client.js`）：
 * - `:19203` `const primaryStops = running && subagent === null && (empty || blocked !== void 0);`
 * - `:19208` `const primaryLabel = primaryStops ? t("input.stop") : ...`
 * - `:16151` `"input.stop": "停止生成",`
 * - `:16528` `"input.stop": "Stop generating",`
 *
 * 为什么不用「复制」按钮：流式过程中复制按钮就已经存在，不具区分力。
 *
 * [parse] 的契约是**永不抛异常、拿不准就返回 null**。判错的代价是漏一条或多发一条通知；
 * 抛异常的代价是轮询链断掉，之后再也不会有任何通知。
 */
internal object RunStateProbe {

    /** 一次采样的结果。[title] 是页面标题，用作通知副标题；缺失时为 null。 */
    data class Snapshot(val running: Boolean, val title: String?)

    /** 页面标题截断长度。通知栏放不下更长的，也没必要把整串标题搬进 IPC。 */
    const val TITLE_LIMIT = 80

    /** 页面内轮询周期。1.5 秒足够跟手，又不至于把 WebView 主线程占满。 */
    const val POLL_INTERVAL_MS = 1_500

    /**
     * 判据本体（一个 JS 函数表达式），由 [JS] 与 [hookJs] 共用一份。
     *
     * 只碰 `document` 级 API，不碰 `document.body.` —— document-start 阶段 body 可能还是 null。
     */
    private const val DETECT_FN = """
        function () {
          var want = ['停止生成', 'Stop generating'];
          var nodes = document.querySelectorAll('[aria-label]');
          for (var i = 0; i < nodes.length; i++) {
            var label = nodes[i].getAttribute('aria-label');
            if (!label) continue;
            for (var j = 0; j < want.length; j++) {
              if (label === want[j]) return true;
            }
          }
          return false;
        }
    """

    /**
     * 一次性探针：`evaluateJavascript` 注入后返回 `JSON.stringify` 后的字符串。
     *
     * 整段包在 try 里，任何异常都回空串，交给 [parse] 当成「不知道」。
     */
    val JS: String = """
        (function () {
          try {
            var running = ($DETECT_FN)();
            var title = document.title || '';
            if (title.length > $TITLE_LIMIT) title = title.substring(0, $TITLE_LIMIT);
            return JSON.stringify({ running: running, title: title });
          } catch (e) {
            return '';
          }
        })()
    """.trimIndent()

    /**
     * 页面内常驻轮询：状态**发生翻转**时经 JS 桥上报原生，空闲时一个字节都不发。
     *
     * 为什么不从原生侧定时 `evaluateJavascript`：原生轮询在页面切换、WebView 重建时会漏拍，
     * 而且每次求值都要跨进程回一次；页面内定时器跟着页面生命周期走，天然对齐。
     *
     * @param bridgeName `addJavascriptInterface` 注册的名字
     */
    fun hookJs(bridgeName: String): String = """
        (function () {
          try {
            if (window.__dshRunStateHooked) return;
            window.__dshRunStateHooked = true;
            var detect = ($DETECT_FN);
            var last = null;
            function tick() {
              try {
                var running = detect();
                var title = document.title || '';
                if (title.length > $TITLE_LIMIT) title = title.substring(0, $TITLE_LIMIT);
                if (running === last) return;
                last = running;
                var bridge = window.$bridgeName;
                if (bridge && typeof bridge.reportRunState === 'function') {
                  bridge.reportRunState(JSON.stringify({ running: running, title: title }));
                }
              } catch (e) { /* 单次采样失败不算状态翻转 */ }
            }
            setInterval(tick, $POLL_INTERVAL_MS);
          } catch (e) { /* 钩子装不上就让手动刷新兜底 */ }
        })()
    """.trimIndent()

    /**
     * 解析 `evaluateJavascript` 的返回值。
     *
     * 两种形态都要吃得下：
     * - `"{\"running\":true,\"title\":\"…\"}"` —— WebView 常规返回，整串是个 JSON 字符串字面量；
     * - `{"running":true}` —— 裸 JSON（JS 桥直接传过来时是这样）。
     *
     * 返回 null 的场合：空、`null`、`""`（脚本自己 catch 住了）、缺 `running` 字段、半包截断。
     */
    fun parse(raw: String?): Snapshot? {
        var text = raw?.trim() ?: return null
        if (text.isEmpty() || text == "null") return null
        if (text.length >= 2 && text.first() == '"' && text.last() == '"') {
            text = PageProbe.decodeJsString(text).trim()
            if (text.isEmpty() || text == "null") return null
        }
        val running = readBool(text, "running") ?: return null
        return Snapshot(running, readString(text, "title"))
    }

    /** 找 `"key": true|false`。键后面没跟完整字面量（半包）时返回 null。 */
    private fun readBool(text: String, key: String): Boolean? {
        var i = skipToValue(text, key) ?: return null
        return when {
            text.startsWith("true", i) -> true
            text.startsWith("false", i) -> false
            else -> null
        }
    }

    /**
     * 找 `"key": "…"` 并反转义取值。
     *
     * 手写扫描而不是 `org.json`：`org.json` 在单元测试里是空桩（`android.jar` 的方法体全是
     * `throw new RuntimeException("Stub!")`），本仓库至今零 Robolectric，只能自己解。
     */
    private fun readString(text: String, key: String): String? {
        var i = skipToValue(text, key) ?: return null
        if (i >= text.length || text[i] != '"') return null
        i++
        val out = StringBuilder()
        while (i < text.length) {
            val c = text[i]
            when {
                c == '\\' && i + 1 < text.length -> {
                    out.append(c).append(text[i + 1])
                    i += 2
                }
                c == '"' -> return PageProbe.decodeJsString("\"$out\"")
                else -> {
                    out.append(c)
                    i++
                }
            }
        }
        // 引号没闭合 = 半包。标题不完整不如不要。
        return null
    }

    /** 定位 `"key"` 之后冒号之后第一个非空白字符的位置。 */
    private fun skipToValue(text: String, key: String): Int? {
        val token = "\"$key\""
        val at = text.indexOf(token)
        if (at < 0) return null
        var i = at + token.length
        while (i < text.length && text[i].isWhitespace()) i++
        if (i >= text.length || text[i] != ':') return null
        i++
        while (i < text.length && text[i].isWhitespace()) i++
        return i
    }
}
