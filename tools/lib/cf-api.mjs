/**
 * cf-api.mjs —— 用 Cloudflare API Token 建 named 隧道时，构造请求体与挑选返回值的纯逻辑。
 *
 * ## 为什么不用 `cloudflared tunnel login`
 *
 * `tunnel login` 那条路要在浏览器里点 Authorize，而 dash.cloudflare.com 对
 * 未登录请求直接返 403 骨架屏（实测：登录页在 Edge 和 Chrome 里都停在加载动画）。
 * 换成 API Token 之后全程是普通 HTTPS 请求，`api.cloudflare.com` 实测可达。
 *
 * ## 一次性配置（人做，两个值）
 *
 * 1. 在 Cloudflare 后台建一个 API Token，权限给：
 *      Account → Cloudflare Tunnel → Edit
 *      Zone    → DNS               → Edit
 * 2. 拿到 Account ID（后台首页右侧栏或 URL 里）。
 *
 * 然后：
 *   set CF_API_TOKEN=...
 *   set CF_ACCOUNT_ID=...
 *
 * 这两个值只从环境变量读，不落盘、不进 git、不写进任何配置。
 *
 * ## 这个文件负责什么
 *
 * 只负责「请求体长什么样」和「从返回里挑哪个值」。网络请求在 cf-named-api.mjs。
 * 拆开的理由：这几个判断一旦写错，代价是建出连不通的隧道、或者把 DNS 改成死记录，
 * 而那种错要等手机连不上才发现。放这里能直接 `node --test` 钉住。
 */

/** 建隧道。`config_src: 'cloudflare'` 必须给，否则 ingress 只能靠本地 config.yml。 */
export function tunnelCreateBody(name) {
  return { name, config_src: 'cloudflare' }
}

/**
 * 隧道的 ingress 规则。
 *
 * 写的是「cloudflared 收到请求后转发到哪」。pocket 的 3081 是明文 HTTP，
 * 所以 service 必须是 `http://`——写成 `https://` 会让 cloudflared 对 3081 做 TLS
 * 握手，报 x509 或 connection reset，且错误只在隧道日志里可见。
 *
 * 兜底规则 `http_status:404` 必须放最后且不带 hostname：带 hostname 的话它会抢掉
 * 所有没写进规则表的域名，等于把别人的域名也指到 pocket 上。
 */
export function ingressBody(hostname, port) {
  return {
    config: {
      ingress: [
        { hostname, service: `http://127.0.0.1:${port}` },
        { service: 'http_status:404' },
      ],
    },
  }
}

/**
 * DNS 记录：CNAME 到 `<tunnelId>.cfargotunnel.com`。
 *
 * - `proxied: true`：不代理的话这条 CNAME 会把隧道 ID 直接暴露成公网记录，
 *   Cloudflare 的证书和 WAF 也全都用不上。
 * - `ttl: 1` 是 Cloudflare 的「自动」。
 */
export function dnsRecordBody(hostname, tunnelId) {
  return {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
  }
}

/**
 * 从 `/accounts` 列表里挑账号。
 *
 * 只有一个就直接用；多个时按 `hint`（邮箱或账号名）精确匹配；给了 hint 但没匹配上
 * 返回 null——**不瞎猜**，因为用错账号建隧道会在另一个账号下留下垃圾资源，
 * 而且那个 token 往往看不到它。
 */
export function pickAccount(list, hint) {
  if (!Array.isArray(list) || list.length === 0) return null
  if (hint) {
    return list.find((a) => a && a.name === hint) ?? null
  }
  return list.length === 1 ? list[0] : null
}

/**
 * 按主机名找它所属的 zone。
 *
 * 用根域名精确匹配（`pocket.example.com` → zone `example.com`）。
 * 找不到返回 null，调用方据此报「这个域名不在这账号下」，而不是硬建一条注定失败的记录。
 */
export function pickZone(zones, hostname) {
  if (!Array.isArray(zones) || !hostname) return null
  const root = normalize(hostname).split('.').slice(-2).join('.')
  return zones.find((z) => z && normalize(z.name) === root) ?? null
}

/**
 * 在隧道列表里找同名隧道。
 *
 * **必须排除 `deleted_at` 非空的**：删掉的隧道在列表里还会挂一段时间，
 * 复用它建出来的 DNS 会指向一个已经不存在的东西，浏览器访问直接 1033。
 */
export function tunnelFromList(list, name) {
  if (!Array.isArray(list) || !name) return null
  return list.find((t) => t && t.name === name && !t.deleted_at) ?? null
}

/**
 * 取 tunnel token。两种返回形状：
 * - 建隧道时：`result` 是个对象，token 在 `result.token`
 * - 查 token 接口：`result` 直接是那串字符串
 *
 * 拿不到就返回空串（调用方据此中止），绝不返回半截或 `"undefined"`——
 * 那串东西会被写进 pocket 的 settings.json 并在启动时报一句读不懂的错。
 */
export function tokenFromTunnel(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && typeof result.token === 'string') {
    return result.token
  }
  return ''
}

function normalize(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\.+$/, '')
}
