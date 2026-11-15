# 免费域名 → Cloudflare named 隧道：手把手流程

> 目的：给 `dsh-pocket` 的 Cloudflare 隧道换一个**固定域名**，替掉每次重启都会变的
> `*.trycloudflare.com`。做完之后手机上存的地址永远不用改。
>
> 本文件是**操作流程**，不是代码说明。代码在 `tools/cf-named-api.mjs`。

---

## 0. 现在到哪一步了（2026-11-06 实测状态）

| 事项 | 状态 |
|---|---|
| Cloudflare 账号 | ✅ 已有 `1002465178@qq.com`，account id `1dc3143a67f4a5ffd47f953f0b07919d`，**zone 数 0** |
| DigitalPlat 账号 | ⏳ **注册未完成**——GitHub OAuth KYC 已通过，卡在「完善账户信息」实名表单 + Cloudflare Turnstile |
| 域名 | ❌ 还没有 |
| Cloudflare API Token | ❌ 还没有 |
| 本机 `cloudflared tunnel login` | ❌ 走不通（`dash.cloudflare.com` 的授权页在未登录态只给 403 骨架屏），**已改走 API 路线** |
| 脚本与测试 | ✅ `tools/cf-named-api.mjs` + `tools/lib/cf-api.mjs`（19 条）+ `tools/lib/cf-setup.mjs`（13 条）全绿，已提交 `a0c8428` |

**关键前提：本机 Windows 不可达 `github.com`**（HEAD 超时、浏览器永远空白、mihomo 所有节点 504）。
所以 KYC 那一步必须在**手机**上做（手机经 tun0 出去能到，curl 实测 `200 3.925964s`）。

---

## 1. 完成 DigitalPlat 注册（手机，约 5 分钟）

### 1.1 打开页面

手机 Chrome 打开：

```
https://dashboard.digitalplat.org/auth/register
```

> 页面标题是「DigitalPlat One / 数字平台一」。旧地址 `dash.domain.digitalplat.org`
> 会 301 到同一处，用哪个都行。

### 1.2 用 GitHub 登录（KYC 就这一步）

点 **「使用 GitHub 继续」** → 跳 GitHub 授权页，显示应用名「DigitalPlat FreeDomain」
（作者 爱德华·辛 / EdwardLab），权限是「个人资料信息（只读）」「电子邮件地址（只读）」。

点 **「授权 EdwardLab」**。

> 手机上的 GitHub 账号是 `13032418a-ship-it` / `13032418a@gmail.com`，已登录态。
> ⚠ 别用 `form.submit()` 强行提交这一步——它绕过 React 的 onSubmit，会把参数拼到
> URL 上（`?username=...&cf-turnstile-response=1.NpBb-...`），页面白跑一趟。
> 正常**点按钮**就行。

### 1.3 填「完善账户信息」表单

授权回来会落在 `.../auth/register?oauth=complete`，邮箱已预填。必填 9 项：

| 字段 | name | 填什么 |
|---|---|---|
| 用户名称 | `username` | 已自动填 GitHub 用户名，不用改 |
| 全名 | `fullname` | **真实姓名**（页面明确写「请填写真实姓名」，文档也写 "Do not use fictional textbook values"） |
| 电话国家/地区 | `phone_country` | 选 `中国(+86)` |
| 电话 | `phone` | 手机号（含本地区码，页面提示「请输入包含本地区码的号码」） |
| 国家/地区 | `contact_country` | 选 `中国` |
| 街道地址 | `contact_line1` | 真实街道地址 |
| 城市 | `contact_city` | 城市 |
| 州／省 | `contact_region` | 省 |
| 邮递区号 | `contact_postal_code` | 邮编 |

选填：`contact_line2`（公寓楼层）、`referral_code`（推荐码，可空）。
勾上 **「帐单地址与联系地址相同」**（`billing_same`）。

### 1.4 过 Cloudflare Turnstile

表单最下方有一个 Cloudflare 人机验证框。**等它自己出现绿勾「成功!」**
（实测加载需要几秒；脚本 `api.js` 与 challenge 请求都返回 200，只是渲染慢）。

绿勾出现后，「设立账户」按钮才会从灰变亮。

> 如果一直不出绿勾：下拉刷新一次页面，重新点「使用 GitHub 继续」走一遍。
> 实测刷新会**让 OAuth 会话过期**，页面提示「注册已过期，请重新使用 Google 或 GitHub 继续」，
> 重新授权即可，不用重新填 GitHub 密码。

### 1.5 提交

点 **「设立账户」**。成功后应该跳进控制台首页，右上角能看到自己的账号。

---

## 2. 申请域名（手机，约 2 分钟）

### 2.1 先准备好 NS 主机名

DigitalPlat **只做 NS 委派，不提供 A/CNAME/MX 记录编辑器**——所有记录都得在
你指定的外部权威 NS 上配。所以这一步要**先**去 Cloudflare 拿 NS。

先去第 3 节拿 NS，再回来做 2.2。两节顺序是反的，别跳过。

### 2.2 申请

控制台 → **Register**（注册域名）→

1. 填 label：比如 `dshpocket`
2. 选后缀：`.dpdns.org`（主力，推荐）/ `.us.kg`（老后缀，2025-03 曾因滥用停服过一次）/ `.qzz.io` / `.xx.kg` / `.qd.je`
3. 点 **Check availability** 查占用
4. 填第 3 节拿到的两条 NS 主机名
5. 提交

> ⚠ **每账号默认只给 1 个免费域名**（官方 FAQ 原文 "the default limit is 1 domain per user account"），
> 别按早前记的「3 个」来规划。有效期 1 年，到期前 180 天内可 renew。
> ⚠ Star 仓库不是硬性要求（FAQ: "It's not required"），只是作者会看。

申请完在 **Domain List** 里能看到状态和到期日。

---

## 3. 在 Cloudflare 加站点，拿两条 NS（电脑，约 2 分钟）

浏览器打开：

```
https://dash.cloudflare.com/1dc3143a67f4a5ffd47f953f0b07919d/add-site
```

1. 输入你刚申请的完整域名（如 `dshpocket.dpdns.org`）
2. 套餐选 **Free**
3. Cloudflare 会给你两条 NS，形如：

```
ada.ns.cloudflare.com
bob.ns.cloudflare.com
```

（**你实际拿到的名字不一样，照抄页面上的**）

4. 复制下来，回第 2 节填进 DigitalPlat。

> 站点此时状态是 `Pending Nameserver Update`，正常。

---

## 4. 等站点变 Active（10 分钟 ~ 24 小时）

回 Cloudflare → 你的域名 → Overview，等到状态从 **Pending** 变成 **Active**。

- 一般十几分钟到几小时
- DigitalPlat 的 NS 生效偶尔慢，超过 24 小时可以回 DigitalPlat 检查 NS 有没有填错

**Active 之前，第 5 节的 API Token 建了也白建**（Zone 范围里还没有这个域名）。

查证方法（电脑 PowerShell）：

```powershell
Resolve-DnsName -Type NS dshpocket.dpdns.org -Server 1.1.1.1
```

看到的就是你填的那两条 `*.ns.cloudflare.com` 才算通过。

---

## 5. 建 Cloudflare API Token（电脑，约 3 分钟）

浏览器打开：

```
https://dash.cloudflare.com/profile/api-tokens
```

点 **Create Token** → **Create Custom Token**，两段权限：

| Scope | 权限 | 级别 |
|---|---|---|
| Account | Cloudflare Tunnel | **Edit** |
| Zone | DNS | **Edit** |

Zone Resources 选 **Include → Specific zone → 你的域名**（或 All zones）。

Account Resources 选 **Include → 你的账号**。

建完把 token 复制出来——**只显示一次**。

同时记下 account id（页面 URL 里那串，或 Overview 页右边）：

```
1dc3143a67f4a5ffd47f953f0b07919d
```

---

## 6. 跑脚本（电脑）

### 6.1 先体检

```powershell
cd D:\dsh-mobile-app
$env:CF_API_TOKEN = '<粘贴 token>'
$env:CF_ACCOUNT_ID = '1dc3143a67f4a5ffd47f953f0b07919d'
node tools/cf-named-api.mjs --status
```

应该看到：账号名、zone 列表里有你的域名、已有隧道（可能为空）、pocket 当前状况。

### 6.2 空跑一遍看命令

```powershell
node tools/cf-named-api.mjs --host dshpocket.dpdns.org --dry-run
```

只打印五步要做什么，不执行。

### 6.3 真跑

```powershell
node tools/cf-named-api.mjs --host dshpocket.dpdns.org
```

它做五件事：

1. 查 zone（确认域名已 Active）
2. 建或复用隧道 `dsh-pocket`（复用会**排除已删除的**）
3. 写 ingress 配置：`你的域名 → http://127.0.0.1:3081`，兜底 `http_status:404`
4. DNS 建 CNAME `你的域名 → <tunnelId>.cfargotunnel.com`，**proxied**（改前会打印旧值，可从输出改回）
5. 取隧道 token，调 `tools/pocket-tunnel.mjs --host --token` 写进 pocket 并重启自证

### 6.4 脚本自己会验的三件事

- `pocket.status` 回读：`mode === 'named'`、`hostname === 你填的`、`tokenSet === true`
- `tunnelUrl` 里包含你的域名
- 失败会直接把 `cloudflare` 的 `errors[].code + message` 原样打出来

---

## 7. 验收

```powershell
# 隧道起来了吗
node tools/pocket-tunnel.mjs --status

# 公网能访问吗（浏览器也行）
curl.exe -sS -o NUL -w "%{http_code}\n" https://dshpocket.dpdns.org/
```

`200` 就成了。

然后手机 App 重新连接，地址填 `https://dshpocket.dpdns.org`。App 侧的域名判据
（`HostMatch.isSameHost`：同域或子域）和「是否易变地址」判据
（`Endpoint.urlIsVolatile` 只把 `*.trycloudflare.com` 算易变）都已经支持自有域名，
**不需要改 App 代码**。

---

## 8. 出问题怎么退

### 8.1 隧道退回 quick

```powershell
node tools/pocket-tunnel.mjs --quick
```

### 8.2 清掉 Cloudflare 上的残留

- 隧道：`https://one.dash.cloudflare.com/1dc3143a67f4a5ffd47f953f0b07919d/networks/tunnels` → 删 `dsh-pocket`
- DNS：你的域名 → DNS → Records → 删那条 CNAME
- 站点：账号首页 → 你的域名 → 最底下 Remove site

---

## 9. 这一路上踩过的坑（都是实测）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 本机不通 GitHub | `github.com` HEAD 超时；Edge/Chrome 永远空白；mihomo 所有节点对 github.com 504 | KYC 用**手机**做；手机上 `curl https://github.com` 是 `200` |
| 本机不通 Cloudflare dashboard 授权页 | `cloudflared tunnel login` 打开是**骨架屏**（虚线圆圈动画），5 分钟后报 `INF Failed to write the certificate.` / `error="Failed to fetch resource"` | 走 API Token 路线（`cf-named-api.mjs`），别在 login 上耗 |
| `dash.cloudflare.com` 裸访问 403 | 页面空白、`document.cookie` 长度 0、无 JS 异常、无网络失败 | 那就是**未登录**。登录后 dashboard 正常渲染。`api.cloudflare.com` 对照：无 token 返 400 `Missing "Authorization" header`，说明只有 dashboard 挡人 |
| 手机 `input tap` 点不动网页元素 | 点「使用 GitHub 继续」没反应，但点输入框能弹键盘 | 手机 Chrome 操作 DOM 走 **CDP**：`adb forward tcp:9222 localabstract:chrome_devtools_remote` |
| PowerShell 传带引号的 JS 被吃 | CDP 报 `SyntaxError: Invalid or unexpected token` | JS 写成 `.js` 文件，用 `--file` 传 |
| `form.submit()` 绕过 React | 表单参数被拼到 URL 上（GET），页面白刷新 | 用真实指针事件链（pointerdown/mousedown/pointerup/mouseup/click）或直接点按钮 |
| Turnstile 不出绿勾 | 容器 `innerHTML` 空、`cf-turnstile-response` 值为空、提交按钮灰着；但 `api.js` 和 challenge 请求都是 200 | 等一下自己会出；实在不出刷新页面重走 GitHub 授权。⚠ 刷新会让 OAuth 会话过期 |
| 用错账号建隧道 | 隧道在别的账号下，token 又看不到 | `--status` 先确认 account id；`pickAccount` 找不到精确匹配时是返回 null，不会瞎猜 |
| ingress 用 `https://` 指 3081 | 隧道起来但全 502，日志里 x509 / connection reset | pocket 的 3081 是**明文**，service 必须写 `http://127.0.0.1:3081` |
| 隧道建成本地配置型 | `tunnel run --token` 读不到 ingress，全 502 | 建隧道时体里必须带 `config_src: 'cloudflare'` |
| DNS 记录没开代理 | 公网直接看到隧道 ID，Cloudflare 证书与 WAF 都用不上 | CNAME 必须 `proxied: true`；`ttl: 1` 是「自动」 |
| 复用了已删除的隧道 | 浏览器访问报 **1033** | 列表里 `deleted_at` 非空的要排除 |

---

## 10. 一句话流程

> 手机注册 DigitalPlat（GitHub 授权即 KYC）→ 电脑 Cloudflare 加站点拿 NS →
> 手机 DigitalPlat 填 NS 申请 `.dpdns.org` → 等 Active → 建 API Token（Tunnel Edit + DNS Edit）→
> `node tools/cf-named-api.mjs --host <域名>`。
