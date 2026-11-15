package com.dsh.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * 系统通知的统一出口：一条常驻（会话保持），一条一次性（任务完成）。
 *
 * 分成两个渠道而不是一个：
 *  - 「会话保持」必须是 LOW + 常驻 + 不可滑掉，否则被滑掉就等于失去前台优先级；
 *  - 「任务完成」需要能响（默认重要性），且必须可滑掉。
 * 合成一个渠道的话，用户想留一个关一个就做不到。
 */
internal object TaskNotifier {

    const val CHANNEL_DONE = "dsh-task-done"
    const val CHANNEL_DONE_NAME = "任务完成"
    const val DONE_NOTIFICATION_ID = 0x4454 // "DT"

    /**
     * 建渠道。重复调用是安全的：同 ID 同配置再 create 一次不会有任何变化。
     *
     * 只在 API 26+ 需要；再往前由框架自己按优先级处理。
     */
    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return

        nm.createNotificationChannel(
            NotificationChannel(
                KeepAlivePolicy.CHANNEL_ID,
                KeepAlivePolicy.CHANNEL_NAME,
                // 直接写平台常量而不是 KeepAlivePolicy.channelImportance()：
                // lint 的 WrongConstant 只认字面量/常量，认不出包装函数，
                // 而它只是移动端 lint 的一条规则，为它加 @SuppressLint 反而更脏。
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "保持与 DSH 的网页会话不被系统回收"
                setShowBadge(false)
                enableVibration(false)
                setSound(null, null)
            }
        )

        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_DONE,
                CHANNEL_DONE_NAME,
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "DSH 回答完成时提醒"
            }
        )
    }

    /** 常驻通知：会话保持中。 */
    fun keepAlive(context: Context, notice: KeepAlivePolicy.Notice): Notification {
        return NotificationCompat.Builder(context, KeepAlivePolicy.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openApp(context))
            .build()
    }

    /**
     * 一次性通知：任务完成。
     *
     * @param title 会话/服务器名
     * @param text 页面标题（回答所属的会话）
     * @return 是否真的发出去了。Android 13+ 没给 POST_NOTIFICATIONS 时这里是 false ——
     *         调用方据此决定要不要提示用户去开权限，但**绝不能因此影响会话本身**。
     */
    fun notifyDone(context: Context, title: String, text: String): Boolean {
        if (!canPost(context)) return false
        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openApp(context))
            .build()
        return try {
            NotificationManagerCompat.from(context).notify(DONE_NOTIFICATION_ID, n)
            true
        } catch (e: SecurityException) {
            // 权限在这一刻被撤销（用户刚进设置关掉）。吞掉，会话不受影响。
            false
        }
    }

    /** 有没有发通知的资格。API 32 及以下恒为 true（安装即授权）。 */
    fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** 点通知回到 App，而不是新开一个 Activity。 */
    private fun openApp(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
