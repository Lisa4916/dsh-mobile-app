# R8 / ProGuard 规则
#
# 这个文件长期不存在，而 build.gradle.kts 一直在 proguardFiles(...) 里引用它。
# AGP 对缺失文件只打一行 warning（`Supplied proguard configuration does not exist`），
# 构建照样 SUCCESSFUL —— 于是「配置写错了」和「配置根本没生效」看起来一模一样。
# 第 15 步审计时打开 isMinifyEnabled 实跑一次才发现。
#
# 规则取舍原则：只 keep 真正会因为混淆/裁剪而坏掉的东西。
# 多写无害但会掩盖风险 —— 全量 -keep class ** 等于把 R8 关掉，还占着开关的位置。

# ---------------------------------------------------------------------------
# WebView 的 JS 桥
# ---------------------------------------------------------------------------
# Java 侧的方法名要被页面里的 JS 按字符串调（`window.dshNative.keyboardHeight()`），
# R8 看不到这层关系。
#
# 实测（`mapping.txt`，打开 minify 后构建）：
#     com.dsh.remote.WebBridge -> K0.x:                      ← 类名被混淆
#     1:2:boolean isNativeShell():27:27 -> isNativeShell      ← 方法名保留
#     1:5:float keyboardHeight():23 -> keyboardHeight         ← 方法名保留
#
# 也就是说 AGP 内置规则（`@android.webkit.JavascriptInterface <methods>`）已经把方法名
# 保住了，不写下面这条当前也不会坏。但仍然写出来，理由有两条：
#   1. 内置规则是 AGP 的实现细节，换版本可能变；这条是我们的契约，不该外包；
#   2. 显式写出来，读代码的人才知道「桥依赖方法名」这个事实，不会顺手加 @Keep 在错的地方。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 桥对象的类名本身可以混淆（addJavascriptInterface 是按对象实例注册、按第二个参数取名），
# 但保留它让 mapping 可读、崩溃栈能认出是桥。代价几十字节。
-keepnames class com.dsh.remote.WebBridge

# ---------------------------------------------------------------------------
# 不需要额外规则的说明（写在这里，防止后来者"以防万一"乱加）
# ---------------------------------------------------------------------------
# · WebViewClient / WebChromeClient 的回调：它们是**重写父类方法**，R8 不会改重写方法的
#   名字（那是 JVM 语义），只有内部调用点会被内联。本项目已实测 release 包能正常加载、
#   错误回调与 onRenderProcessGone 都触发过。
# · Activity / Application：由 manifest 引用，AGP 会自动 keep，不用手写。
# · Kotlin data class（Endpoint）：没有反射、没有序列化框架，字段名不进 APK 的逻辑。
# · 本项目的 SharedPreferences 用的是手写 TSV（Endpoint.serialize），不是 JSON 反射，
#   所以改字段名不会静默失效。
