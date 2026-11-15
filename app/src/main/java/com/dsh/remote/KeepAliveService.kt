package com.dsh.remote

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat

/**
 * 保活前台服务。
 *
 * 目的只有一个：让 App 进后台后，WebView 里的长连接（DSH 的 `/api/remote.mux` WebSocket）
 * 不被系统在内存回收时随手掐掉。它不是后台任务执行器，不跑任何循环，
 * 唯一的动作就是 `startForeground` 挂一条常驻通知。
 *
 * 三个版本分叉（都在 [KeepAlivePolicy.foregroundType] 里钉过）：
 *  - API ≤ 33：`startForeground(id, n)` 语义，type 必须传 0，传非零直接抛；
 *  - API 34+：必须带非零 type，且 manifest 里要声明同名 `foregroundServiceType` 与
 *    `FOREGROUND_SERVICE_SPECIAL_USE` 权限，否则直接 `SecurityException`。
 *
 * 为什么选 `specialUse` 而不是 `dataSync`：Android 15 给 dataSync 加了每天 6 小时额度，
 * 超时被系统掐掉；而「保持一个会话不掉线」被限时反而是 bug。
 */
class KeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val endpoint = readEndpoint(intent)
        if (!KeepAlivePolicy.shouldKeep(endpoint)) {
            // 没有连接就别占着前台位。START_NOT_STICKY：被杀了不要系统自己拉起来。
            stopSelf()
            return START_NOT_STICKY
        }
        val pageTitle = intent?.getStringExtra(EXTRA_PAGE_TITLE)
        val notice = KeepAlivePolicy.notice(endpoint!!, pageTitle)
        TaskNotifier.ensureChannels(this)
        val notification = TaskNotifier.keepAlive(this, notice)
        try {
            ServiceCompat.startForeground(
                this,
                KeepAlivePolicy.notificationId(),
                notification,
                KeepAlivePolicy.foregroundType(Build.VERSION.SDK_INT),
            )
        } catch (e: Exception) {
            // 权限被用户在设置里关掉、或系统拒了这次提升。
            // 这时服务本身还活着（只是没有前台优先级），会话仍在 —— 不能崩。
            Log.w(TAG, "startForeground 被拒，退化为普通服务: ${e.javaClass.simpleName}")
        }
        return START_STICKY
    }

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    /** endpoint 通过 Intent 传（Parcelable 太重，只传必要字段）。 */
    private fun readEndpoint(intent: Intent?): Endpoint? {
        intent ?: return null
        val url = intent.getStringExtra(EXTRA_URL) ?: return null
        val label = intent.getStringExtra(EXTRA_LABEL) ?: ""
        return Endpoint(id = EndpointStore.idFor(label, url), label = label, url = url)
    }

    companion object {
        private const val TAG = "KeepAliveService"
        const val EXTRA_URL = "endpoint_url"
        const val EXTRA_LABEL = "endpoint_label"
        const val EXTRA_PAGE_TITLE = "page_title"

        /** 起服务。已经起着就只是刷新通知文案。 */
        fun start(context: Context, endpoint: Endpoint, pageTitle: String?) {
            context.startService(intentFor(context, endpoint, pageTitle))
        }

        /** 停服务。没起着也安全。 */
        fun stop(context: Context) {
            context.stopService(Intent(context, KeepAliveService::class.java))
        }

        fun intentFor(context: Context, endpoint: Endpoint, pageTitle: String?): Intent {
            return Intent(context, KeepAliveService::class.java).apply {
                putExtra(EXTRA_URL, endpoint.url)
                putExtra(EXTRA_LABEL, endpoint.label)
                putExtra(EXTRA_PAGE_TITLE, pageTitle)
            }
        }
    }
}
