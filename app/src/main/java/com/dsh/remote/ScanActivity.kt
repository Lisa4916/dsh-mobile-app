package com.dsh.remote

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Size
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 扫码页：CameraX 预览 + ZXing 解码。
 *
 * 不使用第三方扫码 Activity，原因是要控制三件事：
 * 1) 只在解出 http(s) 地址时才回调，扫到别的二维码不打断用户；
 * 2) 第一次解出就立刻停掉分析，避免同一帧连续回调；
 * 3) 没有相机权限/没有相机时给出可操作的提示，而不是白屏。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private val analyzer = Executors.newSingleThreadExecutor()
    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }
    private val consumed = AtomicBoolean(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Toast.makeText(this, "需要相机权限才能扫码", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        previewView = PreviewView(this).apply {
            layoutParams = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }

        val container = android.widget.FrameLayout(this)
        container.setBackgroundColor(android.graphics.Color.BLACK)
        container.addView(previewView)

        container.addView(android.widget.TextView(this).apply {
            text = getString(R.string.scan_title) + "\n" + getString(R.string.scan_hint)
            setTextColor(android.graphics.Color.WHITE)
            textSize = 15f
            gravity = android.view.Gravity.CENTER
            setPadding(dp(24), dp(48), dp(24), 0)
            layoutParams = android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = android.view.Gravity.TOP }
        })

        container.addView(android.widget.Button(this).apply {
            text = getString(R.string.cancel)
            setOnClickListener { finish() }
            layoutParams = android.widget.FrameLayout.LayoutParams(
                dp(120), dp(48),
            ).apply {
                gravity = android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(40)
            }
        })

        setContentView(container)
        startCamera()
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            val provider = runCatching { providerFuture.get() }.getOrNull() ?: run {
                Toast.makeText(this, "相机启动失败", Toast.LENGTH_LONG).show()
                finish()
                return@addListener
            }

            val preview = Preview.Builder()
                .setTargetResolution(Size(1280, 720))
                .build()
                .also { it.setSurfaceProvider(previewView.surfaceProvider) }

            val analysis = ImageAnalysis.Builder()
                .setTargetResolution(Size(1280, 720))
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(analyzer, ::analyze) }

            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
            }.onFailure {
                Toast.makeText(this, "无法绑定相机：${it.message}", Toast.LENGTH_LONG).show()
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** 每帧转成 ZXing 的灰度源做解码；解出地址就回调并结束。 */
    private fun analyze(image: ImageProxy) {
        if (consumed.get()) {
            image.close()
            return
        }
        try {
            val text = decode(image)
            if (text != null && Endpoint.parseUri(text) != null && consumed.compareAndSet(false, true)) {
                runOnUiThread {
                    setResult(
                        RESULT_OK,
                        android.content.Intent().putExtra(EXTRA_RESULT, text),
                    )
                    finish()
                }
            }
        } catch (_: Throwable) {
            // 解码失败是常态（没对准/光线不足），静默跳过该帧
        } finally {
            image.close()
        }
    }

    private fun decode(image: ImageProxy): String? {
        val bytes = toLuminance(image) ?: return null
        val source = PlanarYUVLuminanceSource(
            bytes, image.width, image.height, 0, 0, image.width, image.height, false,
        )
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return runCatching { reader.decodeWithState(bitmap)?.text }.getOrNull()
    }

    /** YUV_420_888 → 纯 Y 平面。扫码只需要亮度通道。 */
    private fun toLuminance(image: ImageProxy): ByteArray? {
        val plane = image.planes.firstOrNull() ?: return null
        val buffer = plane.buffer
        val data = ByteArray(buffer.remaining())
        buffer.get(data)
        return data
    }

    override fun onDestroy() {
        analyzer.shutdown()
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_RESULT = "scan_result"
    }
}


