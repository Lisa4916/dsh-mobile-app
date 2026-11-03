# Android 外部 Agent 技能包评估：android/skills、MiniMax-AI/skills 与 MCP 类工具

> 适用环境：2026-10 评估；本结论针对**纯原生 View + WebView** 外壳项目（Compose 方案不适用）。
> 来源：GitHub 公开仓库，读过 README 与 `testing-setup` 等技能全文。

## 一句话结论

三类东西价值差异极大：`android/skills` 的方法论层可借；`MiniMax-AI/skills` 中等；MCP 类设备控制工具能力重叠且更弱，**换用是降级**。

## 1. android/skills（Google 官方，唯一高价值）

`https://github.com/android/skills`，共 37 个技能。

选题标准（原文要点）：只做 **"evaluations show LLMs underperform"** 的 use cases / workflows，不写 LLM 已擅长的领域——这决定了它对 AI 编码助手的增益点在哪里。

与本项目痛点直接对应、值得摘取的技能：

| 技能 | 对应问题 |
|---|---|
| `system/edge-to-edge` | WindowInsets / 键盘避让 |
| `testing/testing-setup` | 缺系统化测试分层 |
| `navigation/navigation-event` | 返回导航 |
| `performance/anr-audit-and-fix` | 卡顿排查 |
| `security/android-intent-security`、`security/permissions-security` | 安全边界 |
| `build-system/agp/agp-9-upgrade` | 构建兼容 |

`testing-setup` 里可直接采纳的细节：

- 必测场景包含 **"Back handling / exit through home with multiple backstacks"**；
- 截图测试覆盖 **9 种屏幕尺寸 × 字体 1.5x**；
- **E2E 只占约 5%** 的测试比重。

`edge-to-edge` 可借的是检查顺序：**先扫全部 Activity 与输入框，再动手改代码**。

## 硬约束：Compose 专属代码不可直接套用

`system/edge-to-edge` 明确要求 **Jetpack Compose + targetSdk 35**，方案围绕 `Scaffold` / `PaddingValues`。本项目是**纯原生 View + WebView**，代码套不上，只能借检查清单与方法论。

## 2. MiniMax-AI/skills（中等）

`https://github.com/MiniMax-AI/skills` 的 `android-native-dev` 覆盖 MD3、Kotlin/Compose、Gradle 配置、无障碍、构建排错，更像"项目脚手架指南"；它假设使用 Compose，参考价值中等。

## 3. MCP 类设备控制工具（不采纳）

- `https://github.com/CursorTouch/Android-MCP`
- `https://github.com/tanbro/uiautomator2-mcp-server`
- `https://github.com/TiagoDanin/Android-Debug-Bridge-MCP`

它们做的是"自然语言控制设备：点击、滑动、读 UI 树"。本项目已有 adb + 自写 CDP 工具，能读到 `history.length`、`--dsh-native-keyboard` 这类 UI 树读不到的内部量，能力覆盖更强。**与直觉相反**：MCP 看似"新工具升级"，实际上扔掉的是更强的量测手段。

## 采纳判据（可复用）

评估任何外部技能包，只看两条：

1. 它的运行时假设（Compose / View、targetSdk）与本项目是否一致；
2. 它补的能力是否已被现有工具（adb、CDP）覆盖。

两条都不满足即跳过，不要因为"官方/更新"采纳。
