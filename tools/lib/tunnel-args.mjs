/**
 * tunnel-args.mjs —— `tools/pocket-tunnel.mjs` 的参数预校验。零依赖。
 *
 * ## 为什么单独抽成模块
 *
 * 服务端的 `tunnel.setConfig` 是**三步写、不原子**：先 `setTunnelMode`、
 * 再 `setTunnelHostname`、最后 `setTunnelToken`。中途中任何一步抛错，
 * 前面的已经落盘了——settings.json 会停在 `tunnelMode:"named"` 却没有 token，
 * 隧道直接起不来，而且**比改之前更坏**（改之前 quick 是能跑的）。
 *
 * 所以「值是坏的」必须在**发请求之前**判掉。这段判断必须能单测，
 * 不能埋在 300 行的 CLI 里靠人眼读。
 *
 * 见 `tools/__tests__/tunnel-args.test.mjs`。
 */

/** 服务端 `setTunnelToken` 的同一套规则：≥20 字符，字符集 `A-Za-z0-9+/_=-`。 */
const TOKEN_MIN = 20
const TOKEN_CHARSET = /^[A-Za-z0-9+/_=-]+$/

/**
 * 校验 Tunnel Token。
 *
 * @param {unknown} raw 用户从命令行传入的原值。
 * @returns {string|null} null 表示通过，否则是一句人话原因。
 */
export function validateToken(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return '为空'
  if (v.length < TOKEN_MIN) return `太短（${v.length} 字符，至少要 ${TOKEN_MIN}）`
  if (!TOKEN_CHARSET.test(v)) return '含非法字符（只允许 A-Za-z0-9+/_=-）'
  return null
}

/**
 * 主机名归一化：trim、转小写、去 IPv6 方括号、去末尾点。
 *
 * 末尾点在 DNS 语义里与不带点等价（`example.com.` 是 FQDN 的规范写法），
 * 但服务端存的是不带点的小写形式——不归一化的话，最后回读自证那一步
 * `cfg.hostname !== host.toLowerCase()` 永远不相等，看起来像「配置没写进去」。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeHost(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '')
}

// 只允许 DNS 标签式主机名：字母数字与连字符，段间用点分隔，末段（TLD）不能是纯数字。
// 故意**不**支持 IPv4/IPv6 字面量：Cloudflare 隧道要的是 Public Hostname，
// 给个 IP 它连 DNS 记录都没有，写进去只会起不来。
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * 校验 Public Hostname。
 *
 * @param {unknown} raw
 * @returns {string|null} null 表示通过，否则是一句人话原因。
 */
export function validateHost(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return '为空'

  // 先给最常见的两种错法各自的提示，比统一报「格式不对」有用得多。
  if (/^[a-z]+:\/\//i.test(s)) {
    return '带协议前缀了，这里只填主机名（例如 pocket.example.com）'
  }
  if (s.includes('/')) {
    return '带路径了，这里只填主机名（例如 pocket.example.com）'
  }
  if (s.includes(':')) {
    return '带端口了，这里只填主机名；端口由 Cloudflare 隧道自己决定'
  }

  const h = normalizeHost(s)
  if (!h) return '为空'
  if (!h.includes('.')) {
    return '不是完整域名（缺后缀），公网 DNS 里解析不出来'
  }
  if (!HOST_RE.test(h)) {
    return '不是合法的域名（只允许字母、数字、连字符与点，且末段不能是纯数字）'
  }
  return null
}
