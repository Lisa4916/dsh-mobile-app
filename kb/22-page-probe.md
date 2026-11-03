# 页面判据（page probe）的可测化设计：拆成「取值」与「判状态」两半

> 适用环境：任何「在 WebView / 浏览器里读页面状态并据此做决策」的 App。本项目是 dsh-mobile-app 的自愈判据。
> 最后验证：2026-11，`PageProbeTest` 20 例 + 真机 `PageProbeJsTest` 7 例全绿。

## 症状：判据写在 JS 字符串里，只能靠真机试错

最初的 `HEAL_PROBE_JS` 是一整段 JS：读 `document.title` 和 `document.body.innerText`，在里面串七八个 `indexOf`，返回 `'0'/'1'/'2'`。

它有 20 种分支组合，其中「判错就删用户 cookie」。但这段逻辑只能通过「装 APK → 造故障 → 看结果」来验证，一次 20 分钟，覆盖不到边界。

## 决策：把「取值」与「判状态」拆开

```
取值（必须真 WebView）        判状态（纯 Kotlin，可单测）
  JS_TITLE = "(document.title || '')"
  JS_BODY  = "(document.body ? (document.body.innerText || '') : '')"
                                      ↓  PageProbe.decodeJsString(raw)
                            PageProbe.classify(title, body): String
```

三件事因此变成可能：

1. **判据可以穷举测试**：`classify` 是纯函数，20 例覆盖所有顺序冲突（主界面文案里含「访问密码」、会话页残留 home 文案、标题与正文互相矛盾、超长正文、null/空输入）。
2. **取值失败不再拖垮判据**：两次 `evaluateJavascript` 分开求值，任一失败只影响自己那一半（`classify` 收到 `null` 走兜底）。标题先求值还有个额外好处——PIN 页只看标题就能定案，省一次跨进程调用。
3. **instrumented 测试只需要验「取值」**：真机只跑 7 例（中文/中间点往返、空标题、`innerText` 跳过隐藏元素、重页面截断、六种页面形态、`about:blank` 不抛异常），成本从「每次改判据都要跑」降到「只在动取值时跑」。

## 实现要点

### `decodeJsString` 必须自己写

`evaluateJavascript` 的回调参数是 **JSON 编码过的 JS 字符串**，不是原始文本。用之前必须还原：

- 外层引号要剥；
- `null` 是字面量 `null`，不是空串；
- `\uXXXX`（中文在部分路径下会以转义形式回来）要解；
- `\\`、`\n`、`\t`、`\"` 要解；
- **缺位的 `\u`（后面不足 4 位十六进制）不能吞字符**，要把 `\u` 原样吐回去——否则畸形输入会让后半段正文整体错位。

这一段有 5 条专门用例（`decodeJsString_plainUtf8` / `_unicodeEscaped` / `_emptyAndNull` / `_escapes` / `_malformedEscape_keepsText`）。前两条是正常路径，后三条是「输入不按预期来时不要变得更糟」。

### 正文要截断

`document.body.innerText` 在长文档上可达数 MB，跨进程传回来会明显卡顿，而且判据只需要开头一段。

```kotlin
const val MAX_BODY_LENGTH = 200_000
val b = body.orEmpty().take(MAX_BODY_LENGTH)
```

截断放在 `classify` 里（而不是 JS 里），这样「截断后是否仍然判对」也能单测（`veryLongBody_doesNotThrowAndStillClassifies`）。

### 判据顺序本身就是规格

`classify` 里的 `if` 顺序是硬约束，不是随手排的：

- 主界面判据（`导出会话日志` / `探索未至之境`）**必须**排在最前——主界面的设置页正文里含有「访问密码」，顺序错了会误判成「要 PIN」→ 删 cookie → 用户锁死；
- 「正在进入」过渡页必须挡住——那是正常握手流程中的一帧，动手等于打断它；
- 兜底一律返回「健康」——拿不准就不动手，宁可不动也不能误删。

这些顺序在代码里用注释写明「为什么是这个顺序」，并且每一条都有反向用例锁住。

## 反面教材：直接对整段 JS 做 instrumented 测试

第一版 `PageProbeJsTest` 就是直接跑整段 `JS`，结果：

```
<no result>
INSTRUMENTATION_RESULT: shortMsg=Process crashed
```

两个原因叠在一起：固定 300ms 延时求值时页面还没加载完；以及反复创建/销毁 WebView 导致进程崩溃。

修法是次要的（改成在 `onPageFinished` 里求值）。**真正该吸取的教训是：把「需要真机」和「不需要真机」的部分混在一个字符串里，会让测试成本变成二者之和，而不是只需要真机的那一小部分。** 拆开之后，真机测试只剩 7 例、只验取值，逻辑判据 20 例在 JVM 里 0.1 秒跑完。

## 另一个真机坑：`loadDataWithBaseURL` 加载的文档上 `document.title` 读回空串

`<title>` 标签在这种加载方式下不生效。不要用它构造测试页的标题——改用 `evaluateJavascript("document.title = <JSON 字面量>")` 设置，这也正是 SPA 真实产生标题的方式（比塞 `<title>` 更接近生产环境）。
