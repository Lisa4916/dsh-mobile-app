# 构建环境：Gradle / AGP / JDK / SDK 版本锁定

> 适用环境：Windows 10/11 本机，Android Studio 未使用（纯命令行构建），目标 Android 15 / SDK 35 / arm64-v8a。
> 最后验证：2026-10（dsh-mobile-app 项目实测）

## 一句话结论

Android 构建失败里**绝大多数不是代码问题，是四个版本号互相打架**：Gradle 版本、AGP 版本、JDK 版本、compileSdk。改代码之前先确认这四项。

## 现象与判据

### 现象 1：`Unsupported class file major version`

- **根因**：JDK 版本高于 Gradle 版本能解析的字节码上限。Gradle 8.x 不认 JDK 22+ 编出来的 class。
- **判据**：报错行里带 `major version XX`。JDK 17 是 61、JDK 21 是 65、JDK 22 是 66。
- **正确做法**：把 JDK 钉在 Gradle 官方支持矩阵内。Gradle 8.9 配 JDK 17 是稳定组合，不要升 JDK 去追新语法。

### 现象 2：Gradle 9.x 与 AGP 8.7.3 不兼容

- **根因**：AGP 8.7.x 的 Gradle API 调用面在 Gradle 9 里被移除/改签名。
- **判据**：Gradle 启动后立刻报 AGP 内部类 `NoSuchMethodError` 或 `Could not create task`，还没进入编译阶段。
- **正确做法**：AGP 8.7.3 配 Gradle 8.9。缓存里同时存在 gradle-9.4.1 时**不要**因为"版本更新"去用它。

### 现象 3：`gradle` 不在 PATH

- **根因**：没装系统级 Gradle，只在临时目录解压过一份。
- **判据**：`gradle -v` 报 `CommandNotFoundException`；或 `Test-Path "$env:TEMP\gradle-short"` 返回 False。**`%TEMP%` 里的工具链会被系统清理**——实测 `%TEMP%\gradle-short` 已被清空过，此时同一条构建命令报的是「路径不存在」，与「没装 Gradle」是同一副面孔，极易被误判成代码问题或版本冲突。
- **恢复做法**：目录消失时从 Gradle 发行镜像重新下载 8.9 解压回**同一短路径**，再重跑 `assembleDebug` + `testDebugUnitTest` 确认测试基线，不要临时改用缓存里另一份 Gradle 顶替。
- **正确做法**：用绝对路径调用，不要改 PATH：

```powershell
& "C:\Users\<user>\AppData\Local\Temp\gradle-short\gradle-8.9\bin\gradle.bat" -p <PROJECT_DIR> :app:assembleDebug
```

### 现象 4：`JAVA_HOME` 未设置导致构建直接失败

- **根因**：AGP 启动时需要 `JAVA_HOME` 定位 javac，`local.properties` 里的 `sdk.dir` 不覆盖它。
- **判据**：`ERROR: JAVA_HOME is not set and no 'java' command could be found`。
- **正确做法**：在**同一条命令里**导出，不依赖 shell 环境：

```powershell
$env:JAVA_HOME = 'D:\AndroidDev\jdk17'
$env:ANDROID_HOME = 'D:\AndroidDev\sdk'
& "...\gradle.bat" -p D:\myapp :app:assembleDebug --console=plain
```

## 判断"构建成功"的正确判据

**`-q` 模式下无输出即成功。** 不要用"看到 BUILD SUCCESSFUL"判断，因为 `-q` 会把成功日志也压掉；反过来，有输出就一定是问题。

```powershell
& gradle.bat -p D:\myapp :app:assembleDebug :app:testDebugUnitTest --console=plain -q
# 退出码 0 且无任何 stdout → 通过
```

单测通过与否要看 XML 报告，不要看控制台：

```powershell
Select-String -Path 'D:\myapp\app\build\test-results\testDebugUnitTest\*.xml' -Pattern 'tests=|failures=|errors='
```

## 版本组合（实测可用）

| 组件 | 版本 | 说明 |
|---|---|---|
| Gradle | 8.9 | 与 AGP 8.7.3 稳定 |
| AGP | 8.7.3 | |
| JDK | Temurin 17.0.20.1 | |
| build-tools | 35 / 36 / 37 | 装多个无害 |
| platforms | android-35、android-37.0 | android-37.0 的目录名带版本后缀，不是 `android-37` |
| Kotlin | 与 AGP 内置一致 | 不要单独升级 kotlin 插件 |

## 相关坑

- `local.properties` 里的路径要用**双反斜杠**转义或正斜杠；写成单反斜杠会静默失效，然后报找不到 SDK。
- 构建产物路径 `app\build\outputs\apk\debug\app-debug.apk`，装到真机前先确认文件大小非零——构建"成功"但 APK 为 0 字节的情况在磁盘满时会出现。
