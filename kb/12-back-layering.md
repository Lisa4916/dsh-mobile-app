# 返回导航必须与进入严格互逆：把页面拆成七层，一次只退一层

**用户口径（一句话就是全部规格）**：「返回与进入的步骤相反，不能缺少步骤也不能多；无论进入哪个功能项都应如此。」

这不是「返回键能用」的问题，而是「返回键的层级模型必须与页面的可视层叠结构同构」。下面是从「能用」走到「互逆」的完整过程。

## 一、先说为什么 SPA 的返回最难做对

DSH 是纯 SPA。实测（真机 `ZY22CMK5F` / Android 14 / WebView 117）：

```
首页              location.href = http://host/     history.length = 1
进会话页          location.href = http://host/     history.length = 1   ← 一个字都没变
点侧栏功能页      location.href = http://host/     history.length = 1
```

**`location.href`、`history.length`、`webView.canGoBack()` 全都不动。** 页面自己不用 History API，所有「进入」都是同一文档内的状态切换。于是：

> **不要指望从历史栈推出层级。层级只能从「视觉上压着哪一层」反推。**

这是整件事的第一性结论。任何基于 `canGoBack()` 的写法在这个页面上都拿不到会话页、拿不到功能视图、拿不到抽屉。

## 二、旧版为什么「多退」和「少退」

旧实现只认三档：`session` / `home` / `other`。判据是正文字符串 —— 有「对话 + 轨迹」算会话，有「探索未至之境」算首页，其余算 `other`。真机逐项实测出来的后果：

| 现状 | 按一次返回 | 实际结果 | 属于 |
|---|---|---|---|
| 首页 + 侧栏展开 | 直接退出 App | `topResumedActivity` 变成 `launcher3` | **少退**（跳过了抽屉这一层） |
| 首页 + 弹出菜单 | 直接退出 App | 同上 | **少退** |
| 会话知识库面板开着 | 底下的会话页被拉回首页 | 面板还留着，页面已经换了 | **多退**（面板这层没退就退了会话层） |
| 插件 / Purge 等功能视图 | 直接回首页 | 功能视图一闪而过 | **少退** |
| 会话页 | 回首页 | 正确 | ✅ |

关键点：**「少退」和「多退」是同一个根因的两种表现** —— 判据里没有那几层，`decide()` 只能落到「要么再往前跨一步、要么直接退出」。

## 三、先把「到底有几层」量出来，再改代码

动手前必须能回答「现在最上面压着什么」，否则改判据就是猜。做法：写探测器把页面**构造**到每一种层叠状态，逐项采样。

真机量出来的七层，**按视觉叠放从高到低**：

| 层 | 判据（可执行） | 靠什么退 |
|---|---|---|
| `panel` | 存在**可见**的 `button`/`[role=button]`，其 `aria-label` 以「关闭」开头 | 点它 |
| `overlay` | 存在**可见**的 `[role=menu]` / `[role=listbox]` / `[role=dialog]` | 发 `Escape` |
| `sidebar` | `[class*="_sidebarCol"]` 的 `getBoundingClientRect().left > -40`（收起实测 `-209`、展开 `0`） | 发 `Escape` |
| `session` | 正文同时含「对话」与「轨迹」 | 点侧栏「新建会话」 |
| `feature` | 存在 `[aria-current="page"|"true"]` 或 `[aria-selected="true"]`，且文案不是「新会话」 | 点侧栏「新建会话」 |
| `home` | 正文含「探索未至之境」/「描述你想要构建的内容」/「发消息或创建任务」/「选择一个工作区开始」 | **退出 App** |
| `other` | 其它（加载中） | 退过就退出，没退过先回首页兜底 |

`visible(el)` 是四判，缺一不可：

```js
var cs=getComputedStyle(el), r=el.getBoundingClientRect();
cs.display!=='none' && cs.visibility!=='hidden' && Number(cs.opacity)>=0.05
  && r.width>8 && r.height>8
```

少判 `opacity` 会把 `opacity:0` 的隐藏浮层当成还开着 → 返回键按两次都没反应（自己踩过）。

## 四、两条判据顺序上的硬约束（都是踩过才知道）

### 1. `session` 必须排在 `feature` 之前

**会话页也有 `aria-selected="true"`** —— 就是「对话」那个 tab。实测：

```json
{"title":"手机软件 — DeepSeek Harness","hasDialog":true,"hasTrack":true,
 "cur":null,"sel":"对话","marks":["对话[main]"],"sideL":-209}
```

先判 `feature` 就会把会话页判成功能视图，返回键于是从「回首页」变成「回首页」（看起来一样）但再按一次行为就错位了。首轮探测器 6/7，错的正是这一项。

功能视图与会话页的可分之处：**功能页正文里也有「对话」二字，但没有「轨迹」**：

```json
功能视图 {"hasDialog":true,"hasTrack":false,"cur":"插件","curInSb":true,"sel":"已安装","selInSb":false}
```

### 2. 功能页入口不在侧栏，在侧栏的「更多」菜单里

侧栏实测 `aria-label` 全集只有七个：

```
打开侧边栏 / 新建会话 / 更多 / 搜索会话 / 展开会话知识库 / 导出会话日志 / 账号菜单
```

`插件 / 自动化任务 / XD Pool / Purge / 知识库` 全在「更多」弹出的 `[role=menu]` 里。想直接 `aria-label=='插件'` 点侧栏会一直 `nf`（找不到），而**构造失败会被误读成产品缺陷**（见下一节）。

## 五、`Escape` 能退什么、不能退什么（必须逐层实测）

页面自己监听 `Escape`，语义恰好是「退一层」。逐个构造后发键，实测：

```
首页 + 侧栏展开        home|side1      → home|side0        ✅
首页 + 弹出菜单        home|menu1      → home|menu0        ✅
功能视图 + 侧栏        feature:插件|side1 → feature:插件|side0  ✅（只收抽屉，视图不动）
会话页 + 侧栏展开      session|side1   → session|side0     ✅
首页 + 会话知识库面板  home|panel2     → home|panel2       ❌ 完全无反应（layerN 0→2→2）
会话页                 session         → session           ❌ tabs 仍 true
```

结论：**抽屉与菜单交给页面自己的 `Escape`（幂等、走它自己的关闭动画与状态回收）；面板与会话页必须我们动手。**

为什么不统一「找关闭按钮点」：页面上同时存在 `关闭` 与 `关闭会话知识库` 两个同名 aria-label，手动点容易点错层；而 `Escape` 由页面自己决定退哪一层，天然正确。

## 六、架构上的分工（可单测的部分与不可单测的部分）

```
DSH_LOCATION_JS      只回答「现在最上面是哪一层」—— 一个字符串
BackNavigationDecider：「层 → 动作」纯函数，零 Android 依赖，18 条 JVM 单测
MainActivity         只负责把动作落成副作用（点/发键/loadUrl/finish）
```

这个切法与「把 Android API 挤出纯 JVM」是同一套：**判据（JS 取值 + Kotlin 决策）与执行（WebView 副作用）分离**。改层级的风险全部落在能跑单测的那一半。

`decide()` 的形状要写成「一次只退一层」，而不是「算出目标位置」：

```kotlin
fun decide(isWebViewVisible: Boolean, location: PageLocation): Action = when {
    !isWebViewVisible -> EXIT_APP
    location == PANEL   -> CLOSE_PANEL
    location == OVERLAY -> DISMISS_OVERLAY
    location == SIDEBAR -> COLLAPSE_SIDEBAR
    location == FEATURE -> LEAVE_FEATURE
    location == SESSION -> GO_TO_START
    location == HOME    -> EXIT_APP          // 只有它退出
    backSteps > 0       -> EXIT_APP
    else                -> RECOVER_TO_START
}
```

**每个分支只对应一个动作，谁都不许顺手把页面拉回首页。** 旧版把所有非会话状态都塞进「回首页」，这才是多退/少退的根源。

## 七、验证脚本自身的四个坑（比产品 bug 更常见）

写「逐层返回」的验证脚本时，**大部分失败是脚本自己的问题，不是产品的**。这次踩到四个，全部会伪装成产品缺陷：

1. **CDP 转发要随 pid 重建。** `am force-stop` 后 pid 变，`webview_devtools_remote_<pid>` 跟着变。不重建时每条 `evaluateJavascript` 吃满 8 秒超时，外面看就是「脚本卡死」。
2. **判「App 在不在前台」只能读 `topResumedActivity` 那一行。** `dumpsys activity activities` 整段里留着历史 `ActivityRecord`，用整段 `indexOf('com.dsh.remote')` 会把「已退到桌面」当成「还在前台」，然后拿一个后台被冻结的 WebView 反复求值、永远等不到首页。
3. **构造没成功不许判产品对错。** 上一版把「点插件没点上」记成了产品缺陷。现在每个构造步骤后都断言期望层已出现，失败就打印「构造失败，跳过」。
4. **复位要按层分别做。** 只用「点新会话」复位时，菜单浮层会把点击吃掉 → 循环空转到上限。正确做法：`overlay` 发 `Escape`、`panel` 点「关闭」、其余才点新会话；每轮上限 10 次。

最终判据只有一条：**7 种层叠状态各按一次真实返回键，落点必须刚好是「上一层」，一项不过就算失败。**

```
首页+菜单    overlay → home      ✅
首页+抽屉    sidebar → home      ✅
功能视图     feature → home      ✅
功能视图+抽屉 sidebar → feature  ✅（只收抽屉，视图不动）
会话页       session → home      ✅
会话页+抽屉  sidebar → session   ✅
会话页+面板  panel   → session   ✅
```

## 八、可迁移的通用结论

1. **SPA 的返回层级必须显式建模**，不能从 `history` 推。层级 = 视觉叠放顺序，判据写在页面侧，决策写纯函数。
2. **「一次只退一层」是唯一不会错的形状。** 任何「算出目标位置再跳过去」的实现，都会在某一层上多退或少退。
3. **同一份「退一层」的能力可能有多个来源**（页面自带的 `Escape` vs 我们自己点按钮）。**按层实测谁行谁不行，不要统一用一种** —— 交给页面处理的那几层不会跟它的动画和状态回收打架。
4. **判据顺序就是规格。** 顺序写错的表现不是「报错」，而是「某一类页面上行为微妙地不对」，且只在真机上复现。
5. **验证工具的可信度要单独建。** 一层没构造出来，看起来和「产品有 bug」完全一样。先让工具能证明自己构造对了，再去判产品。
