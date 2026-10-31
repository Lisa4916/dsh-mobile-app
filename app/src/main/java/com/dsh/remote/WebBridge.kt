package com.dsh.remote

import android.webkit.JavascriptInterface

/**
 * WebView ⇄ 原生桥。
 *
 * 目前只有一个用途：把「键盘是否弹出、弹出多高」告诉页面。
 * 原因：DSH 前端自己监听 `window.visualViewport` 做底部安全区，
 * 但 WebView 里 visualViewport 的变化时机比原生 insets 晚一帧，
 * 会出现输入框已经上移、光标还在原地的抖动。原生先推一个明确高度过去，
 * 页面就能一次性把布局摆对。
 */
class WebBridge(private val host: MainActivity) {

    /**
     * 当前键盘高度，单位是 **CSS px**（= 设备像素 / density）。
     *
     * 页面里的 JS 只会用 CSS px 算布局，原生 insets 拿到的是设备像素
     * （本机 885px 对应 CSS 322px）。直接返回 885 会让页面算出 `innerHeight - 885` 这种负数。
     */
    @JavascriptInterface
    fun keyboardHeight(): Float = host.currentKeyboardHeight / host.resources.displayMetrics.density

    /** 让页面知道自己跑在原生外壳里，可用于隐藏「在浏览器打开」之类提示。 */
    @JavascriptInterface
    fun isNativeShell(): Boolean = true
}
