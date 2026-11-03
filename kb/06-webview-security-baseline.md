# WebView 安全基线：把「加载谁的页面」当成唯一的安全边界

WebView 的所有安全问题最终都收敛成一个问题：**这个 WebView 现在加载的是谁的页面？** 只要页面可信，JS 桥、文件访问、cookie 都是工具；页面一旦不可信，同一套配置立刻变成漏洞。所以安全设计的第一步不是「关掉哪些开关」，而是「保证加载的永远是可信页面，并且这件事可验证」。

## 一、同域判定：最容易写错、后果最重的一处

典型错误写法：

```kotlin
val sameHost = url.contains(endpointHost)   // 错
```

`String.contains` 是**子串包含**，下面三种全部会被判成同域：

```
https://evil.com/?x=<你的host>          查询串里带上你的域名
https://<你的host>.evil.com/steal       把你的域名当成子域前缀
https://evil.com/#<你的host>            片段里带上你的域名
```

后果不是「显示了外部页面」这么轻：这个 WebView 通常没有地址栏，用户看不出已经离开了你的站点；而 `addJavascriptInterface()` 注入的桥**仍然挂在里面**，外面那个页面里的任何脚本都能调用它。

正确写法是比对 host，且要求点边界：

```kotlin
host == allowedHost || host.endsWith(".$allowedHost")
```

- `endsWith(".$allowedHost")` 要求点边界，所以 `evilexample.com` **不是** `example.com` 的子域。
- 允许子域是有意为之：动态隧道的域名经常是 `xxxx.trycloudflare.com` 这种，每次重开换一段随机子域。不允许子域就只能写死，写死就会过期失效。
- 规范化顺序要固定：`trim` → `lowercase` → 去掉 IPv6 的 `[]` → 去掉末尾的点 → 空字符串视为无效。
- **不要用 `android.net.Uri` 解析**（如果要单测的话）：它在 JVM 单元测试里是空实现，`host` 恒为 null，测试会全绿而真机行为相反。用 `java.net.URI`。
- 只对 `http://` / `https://` 生效，`mailto:` / `tel:` / `about:` 维持交给系统的旧行为 —— 否则用户点一个电话号码会把浏览器踹出来。

### 反面用例才是这组测试的价值

判同域的测试里，「应该判同域」的用例价值有限（容易过），真正防回归的是这些：

```
host 出现在 query 里        → 必须判外链
host 出现在 fragment 里     → 必须判外链
host 作为子域后缀（a.b.host）→ 必须判外链
host 出现在路径段里         → 必须判外链
相似域名（evilexample.com） → 必须判外链
完全不同的 host             → 必须判外链
```

这六条只要有一条写成「应该同域」，下次重构就会漏。本项目这组测试 17 条，其中 6 条是反面。

## 二、JS 桥的最小化

`addJavascriptInterface()` 从 API 17 起只暴露带 `@JavascriptInterface` 注解的方法（挡住了 CVE-2012-6636 那条反射到 `Runtime.exec` 的路），但**注解只解决「哪些方法可见」，不解决「谁在调用」**。加载不可信页面时，暴露的每一个方法都是攻击面。

三条纪律：

1. **每个暴露方法都要能说清为什么必须暴露。** 本项目的桥只有一个方法 `keyboardHeight()`，返回键盘高度的 CSS px 值 —— 因为键盘避让必须由页面自己做补间动画，原生只负责把终值传过去。没有第二个方法。
2. **方法只读不写、只返回标量。** 不暴露「执行命令」「读写文件」「打开任意 URL」这类能力；能返回一个数字就不要返回对象。
3. **桥的名字也别泄底。** 注入名可预测不是漏洞，但没必要给攻击者省事。

## 三、开关基线

```kotlin
settings.javaScriptEnabled = true            // 页面是 SPA，必须要
settings.domStorageEnabled = true            // 登录态依赖
settings.allowFileAccess = false             // 默认就应该关
settings.allowContentAccess = false
settings.allowFileAccessFromFileURLs = false
settings.allowUniversalAccessFromFileURLs = false   // 这条最危险：开了之后 file:// 页面能 XHR 读任意本地文件再经桥外传
```

> 注意：**WebView 不遵守 `android:usesCleartextTraffic`**。想限制明文 HTTP，得在 `networkSecurityConfig` 里配 `cleartextTrafficPermitted`，或者自己在 `shouldInterceptRequest` 里拦。这一点和 OkHttp 的行为不一致，很容易想当然。

## 四、`shouldInterceptRequest` 与本地资源

如果要从 `assets/` 给 WebView 供页面，用 `WebViewAssetLoader` 把 `https://appassets.androidplatform.net/...` 映射到 assets，**不要**用 `file:///android_asset/`。原因是 `file://` 源在 WebView 里是特殊源，一旦和「允许文件访问」类开关叠加就会出跨源问题；`WebViewAssetLoader` 让资源拥有正常的 https 源，同源策略照常工作。

## 五、这段代码的自检清单

- [ ] 判断「算不算同一个站」只有一处实现，且是 host 精确比对 + 点边界
- [ ] 有 6 条反面单测（query / fragment / 子域后缀 / 路径段 / 相似域名 / 不同 host）
- [ ] `mailto:` / `tel:` 不被当成外链丢给浏览器
- [ ] JS 桥的每个方法都能说出为什么必须存在
- [ ] 文件访问与 universal access 四个开关全关
- [ ] 没有用 `file:///android_asset/` 供页面
- [ ] 明文流量限制写在 `networkSecurityConfig`，不指望 `usesCleartextTraffic`
