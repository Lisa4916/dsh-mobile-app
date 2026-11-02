package com.dsh.remote

/**
 * 判定「当前页面处在什么状态」。
 *
 * ## 分成两半，是刻意设计
 *
 * 1. **取值**（[JS_TITLE] / [JS_BODY]）：只把 `document.title` 与
 *    `document.body.innerText` 拿出来。这两句必须跑在真 WebView 里，
 *    由 `androidTest/PageProbeJsTest` 验证。
 * 2. **判状态**（[classify]）：纯 Kotlin，无 Android 依赖，由
 *    `test/PageProbeTest` 覆盖全部页面形态。
 *
 * 早先版本把两者塞在一整段 JS 里（`if (b.indexOf('xx')) return '1'`），
 * 结果是：**判错的代价是删用户 cookie，却只能在真机上试错**。项目已经为一次误判
 * 付过代价 —— 旧版把「访问验证」页当成健康，于是「地址里带着 token 却还要求输密码」
 * 这个故障永远不会自愈。
 *
 * 现在判定逻辑是纯函数，改一行就能被几十条单测立刻指出对错；
 * WebView 那边只剩「把两个字符串取回来」这一件事。
 *
 * ## 判据细节（都是实测逼出来的）
 *
 * - **正文优先，标题只兜底**：DSH 前端是 SPA，页面切换后 `document.title` 会滞后。
 *   真机调试时遇到过「标题还是上一次的失败页标题、正文早已是正常主界面」。
 * - **认出主界面特征就不动手**：只要看到「导出会话日志」或「探索未至之境」，
 *   后面所有可疑信号都不算故障。
 * - **过渡页不算故障**：「正在进入」是握手进行中，等它自己跳。
 * - **用 innerText 不用 textContent**：前者跳过 `display:none` 的文案。
 *   否则页面里藏着的旧告警文字会把健康页判成故障。
 * - **拿不准一律 '0'（不动手）**：误判成故障会删用户 cookie，代价远大于漏判。
 */
internal object PageProbe {

    /** 取标题。求值结果是被 JSON 编码的字符串字面量，用 [decodeJsString] 还原。 */
    const val JS_TITLE = "(document.title || '')"

    /**
     * 取正文。用 `innerText`：它会跳过 `display:none` 的元素，
     * 而 `textContent` 会把隐藏文案一起返回（见 [classify] 的注释）。
     */
    const val JS_BODY = "(document.body ? (document.body.innerText || '') : '')"

    /** 代码里给正文长度设的上限，避免极端页面把整页文本搬进内存。 */
    const val MAX_BODY_LENGTH = 200_000

    /**
     * 把 (标题, 正文) 判成页面状态。
     *
     * 返回值与 [PageState.fromProbe] 的编码一致：
     *  - `"0"` 正常 / 过渡页 → 不动手
     *  - `"1"` 上游 401 或握手失败页 → 清 `dsh-auth-*`
     *  - `"2"` dsh-pocket「访问验证」页 → URL 带 token 时清 `dsh_pocket_token`
     *
     * 真实文案取自 dsh-pocket 2.12 / dsh web 0.2.1-rc.5 实测：
     *  - 失败页：标题「DSH Pocket · 无法完成登录握手」
     *  - 上游 401：「dsh web authentication required」
     *  - 正常主界面：「导出会话日志」/「探索未至之境」
     *  - PIN 页：正文「此局域网地址受访问密码保护」/「访问密码 | Access PIN」，
     *    标题「DSH Pocket · 访问验证」
     *  - 过渡页：标题「DSH Pocket · 正在进入」
     */
    fun classify(title: String?, body: String?): String {
        val t = title.orEmpty()
        val b = body.orEmpty().take(MAX_BODY_LENGTH)

        // 正常主界面：只要认出 DSH 主界面特征就不动手，标题再可疑也不算故障
        if (b.contains("导出会话日志")) return "0"
        if (b.contains("探索未至之境")) return "0"

        // 握手过渡页：正在进行，等它自己跳
        if (t.contains("正在进入")) return "0"

        // 真失败：以正文为准
        if (b.contains("无法完成登录握手")) return "1"
        if (b.contains("dsh web authentication required")) return "1"

        // PIN 页：正文或标题任一命中即可判。
        // 这一页正文很短、渲染很快，而标题「DSH Pocket · 访问验证」是最稳定的特征。
        if (b.contains("受访问密码保护")) return "2"
        if (b.contains("访问密码")) return "2"
        if (t.contains("访问验证")) return "2"

        // 正文还没渲染出来时，才退回用标题判断失败页
        if (b.isEmpty() && t.contains("无法完成登录握手")) return "1"

        // 拿不准一律不动手
        return "0"
    }

    /**
     * 还原 `WebView.evaluateJavascript` 回调里的字符串字面量。
     *
     * 回调给的是 JSON 编码的 JS 值：`"访问验证"`、`""`;
     * 非 ASCII 可能原样返回，也可能被转义成 `\u8bbf\u95ee\u9a8c\u8bc1`。
     * 两种都要能还原，否则中文判据会静默失效 —— 而且失效方式很隐蔽：
     * `classify` 拿到一串 `\u` 转义文本，什么都匹配不上，最终返回 `"0"`（不动手），
     * 看起来"没出错"，实际上自愈永远不触发。
     */
    fun decodeJsString(raw: String?): String {
        val s = raw?.trim().orEmpty()
        if (s.isEmpty() || s == "null") return ""
        // 去外层引号（可能带转义引号）
        val inner =
            if (s.length >= 2 && s.first() == '"' && s.last() == '"') s.substring(1, s.length - 1)
            else s

        val sb = StringBuilder(inner.length)
        var i = 0
        while (i < inner.length) {
            val c = inner[i]
            if (c != '\\' || i == inner.length - 1) {
                sb.append(c)
                i++
                continue
            }
            when (val e = inner[i + 1]) {
                'n' -> { sb.append('\n'); i += 2 }
                'r' -> { sb.append('\r'); i += 2 }
                't' -> { sb.append('\t'); i += 2 }
                'b' -> { sb.append('\b'); i += 2 }
                'f' -> { sb.append('\u000C'); i += 2 }
                'u' -> {
                    // \uXXXX：不足 4 位就按原样保留，不吞字符
                    if (i + 6 <= inner.length) {
                        val hex = inner.substring(i + 2, i + 6)
                        val code = hex.toIntOrNull(16)
                        if (code == null) {
                            sb.append(inner, i, i + 2)
                            i += 2
                        } else {
                            sb.append(code.toChar())
                            i += 6
                        }
                    } else {
                        sb.append(e)
                        i += 2
                    }
                }
                '"', '\\', '/' -> { sb.append(e); i += 2 }
                else -> { sb.append(e); i += 2 }
            }
        }
        return sb.toString()
    }
}
