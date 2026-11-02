import java.io.File
import java.net.URI
import java.util.Properties

plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

/**
 * 内置连接地址：从 local.properties 读，不进仓库。
 *
 * 原来这行是硬编码的 `http://192.168.50.58:3081/?token=12345678`，
 * 既泄漏 dsh-pocket 的局域网 PIN，又把 IP 钉死。现在按下面顺序取值：
 *
 *   1. `-Pdsh.lanUrl=` / `-Pdsh.lanPin=`（命令行或 CI secret，优先级最高）
 *   2. `local.properties` 里的 `dsh.lanUrl` / `dsh.lanPin`
 *   3. 都没有 → BuildConfig.DEFAULT_LAN_URL = ""，App 走「扫码 / 手输」引导
 *
 * **故意不设默认值**：与其内置一个过期地址让用户以为是网络故障，
 * 不如让 App 一进来就明确要求扫码。
 */
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { stream -> load(stream) }
}

fun propFrom(name: String): String? =
    (findProperty(name) as String?)?.takeIf { value -> value.isNotBlank() }
        ?: localProps.getProperty(name)?.takeIf { value -> value.isNotBlank() }

android {
    namespace = "com.dsh.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dsh.remote"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // 注入的是**两个原始字段**，不是拼好的 URL。
        // 拼装交给 com.dsh.remote.BootstrapUrl（纯 JDK，有单测覆盖），
        // 避免 Gradle 与 Kotlin 各拼一份、两边行为不一致（曾经就漏了 ?token=）。
        val lanHost = propFrom("dsh.lanUrl") ?: ""
        val lanPin = propFrom("dsh.lanPin") ?: ""
        if (lanHost.isNotBlank() && validateLanHost(lanHost) == null) {
            throw GradleException(
                "dsh.lanUrl 不像一个地址：\"$lanHost\"。请填 IP[:端口] 或完整 URL，例如 192.168.50.58:3081"
            )
        }
        if (lanHost.isNotBlank() && lanPin.isBlank()) {
            throw GradleException("填了 dsh.lanUrl 却没填 dsh.lanPin，拼不出能连的地址。两个都填，或都留空走扫码。")
        }
        buildConfigField("String", "LAN_HOST", "\"$lanHost\"")
        buildConfigField("String", "LAN_PIN", "\"$lanPin\"")
    }

    /**
     * release 签名。
     *
     * 现实：这个项目没有自己的 keystore，也没有分发渠道 —— 它是本机自用工具。
     * 但「release 包签不出来」会让 `assembleRelease` 只产出 `app-release-unsigned.apk`
     * （`apksigner verify` 报 `Missing META-INF/MANIFEST.MF`，装不上），
     * 于是「R8 打开后桥还工作吗」这类问题永远没人能验。
     *
     * 所以：**用 debug keystore 给 release 签名**，但只在本机没配 `dsh.releaseStoreFile`
     * 时生效。真要分发时在 local.properties 里填四个字段（见下方 propFrom），
     * 就会自动切到正式签名 —— 不改代码。
     *
     * 为什么这不算「把不安全的东西留在仓库里」：
     *  - debug keystore 是 SDK 自带的公开密钥（口令 android/androiddebugkey），本来就不是秘密；
     *  - 用它签的包**无法上架**（Play 拒绝 debug 证书），所以不会被误当正式版发布；
     *  - 代价只是「同一台机器上 debug 与 release 可以互相覆盖安装」，自用场景反而是优点。
     */
    signingConfigs {
        create("releaseLocal") {
            val storePath = propFrom("dsh.releaseStoreFile")
            if (storePath != null) {
                storeFile = rootProject.file(storePath)
                storePassword = propFrom("dsh.releaseStorePassword")
                keyAlias = propFrom("dsh.releaseKeyAlias")
                keyPassword = propFrom("dsh.releaseKeyPassword")
            } else {
                // SDK 自带的 debug keystore，**位置不是 SDK 目录** —— 实测在
                // `~/.android/debug.keystore`（Windows: C:\Users\<user>\.android\debug.keystore）。
                // AGP 生成它的时机是「第一次跑 debug 构建」，所以先试用户目录，再兜底找 SDK。
                val home = System.getProperty("user.home")
                val candidates = listOfNotNull(
                    home?.let { File(File(it, ".android"), "debug.keystore") },
                    (System.getenv("ANDROID_SDK_ROOT") ?: System.getenv("ANDROID_HOME")
                        ?: localProps.getProperty("sdk.dir"))?.let { File(it, "debug.keystore") },
                )
                val keystore = candidates.firstOrNull { it.exists() }
                if (keystore != null) {
                    storeFile = keystore
                    storePassword = "android"
                    keyAlias = "androiddebugkey"
                    keyPassword = "android"
                } else {
                    // 一个都没有：不静默失败，直接告诉使用者跑一次 debug 构建即可生成。
                    logger.warn(
                        "release 签名未配置，且找不到 debug.keystore。" +
                            "先跑一次 :app:assembleDebug 由 AGP 生成它，或在 local.properties 里配 dsh.releaseStoreFile。"
                    )
                }
            }
        }
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
        getByName("release") {
            // 第 15 步审计前这里是 false —— release 与 debug 除了签名完全一样，
            // 于是 R8 相关的坑（keep 规则写错、反射/字符串约定被改）在真机上永远暴露不出来。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("releaseLocal")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

/**
 * 校验 `dsh.lanUrl` 是个能解析出 host 的地址，返回规范化后的 base（不含 query/fragment），
 * 不可解析时返回 null。
 *
 * **只做校验，不拼最终 URL** —— 拼装是 `com.dsh.remote.BootstrapUrl.build` 的职责，
 * 那边有单测（BootstrapUrlTest 10 条）。这里曾经也拼了一份，结果漏掉 `?token=`，
 * 注进去的是 `http://192.168.50.58:3081`，App 连上去只会落到「访问验证」页。
 * 教训：同一个逻辑不要在两处各写一遍，一处负责拼、另一处只负责早失败。
 */
fun validateLanHost(host: String): String? {
    val h = host.trim()
    if (h.isEmpty()) return null
    val withScheme = if (h.startsWith("http://") || h.startsWith("https://")) h else "http://$h"
    val cut = withScheme.indexOfFirst { ch -> ch == '?' || ch == '#' }
    val base = (if (cut >= 0) withScheme.substring(0, cut) else withScheme).trimEnd('/')
    return try {
        val uri = URI(base)
        if (uri.host.isNullOrBlank()) null else base
    } catch (e: Exception) {
        null
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // 二维码扫描：CameraX + ZXing 解码核心（不引第三方扫码 UI，自己画）
    implementation("androidx.camera:camera-core:1.4.0")
    implementation("androidx.camera:camera-camera2:1.4.0")
    implementation("androidx.camera:camera-lifecycle:1.4.0")
    implementation("androidx.camera:camera-view:1.4.0")
    implementation("com.google.zxing:core:3.5.3")
    // document-start 脚本：要在 DSH 前端读 localStorage 之前动手，只能靠这个 API
    implementation("androidx.webkit:webkit:1.12.0")
    testImplementation("junit:junit:4.13.2")

    // 真机 instrumented 测试：WebView 的行为（document.title 对中文与 SPA 反复跳转的
    // 表现、innerText 是否含被 CSS 隐藏的文案）在纯 JVM 单测里根本跑不出来，
    // 而「页面判据」判错的代价是删用户 cookie，必须真跑一遍。
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}
