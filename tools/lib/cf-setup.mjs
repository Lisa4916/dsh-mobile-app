/**
 * cf-setup.mjs —— `tools/cf-named-setup.mjs` 里能单测的那部分纯逻辑。
 *
 * 三个函数都只做字符串/结构处理，不碰网络、不碰文件：
 * - `zoneOf`         从主机名取根域名，用来判断「这个域名在不在 cert.pem 授权的 zone 里」
 * - `zonesFromPem`   把 cloudflared 的 cert.pem 解出 zone 列表
 * - `pickTunnel`     在 `tunnel list` 的结果里找同名隧道（找到就复用，找不到就新建）
 * - `endpointHost`   归一 `--host` 参数
 *
 * 拆出来的原因：这些判断一旦写错，代价是「把用户的 DNS 记录改坏」或
 * 「在错误的 zone 下建 tunnel」。放在 .mjs 里直接 `node --test` 就能钉住。
 */

/**
 * 取根域名。
 *
 * 简单做法是「拿最后两段」，对 `pocket.example.com` → `example.com` 是对的。
 * 对 `com.cn` / `co.uk` 这类二级后缀会切错（`example.com.cn` → `com.cn`），
 * 但这里的结果只用于**提示文案**和「zone 是否在授权范围」的软判断，
 * 切错最多让提示不准，不会导致写坏配置——所以不值得引入公共后缀表（那要一个
 * 几十 KB 的数据文件，对一个单文件工具脚本来说不划算）。
 *
 * 畸形输入（空串、单段、非法值）返回空串，绝不抛：调用方拿空串就知道「判断不了」。
 */
export function zoneOf(host) {
  const h = endpointHost(host)
  if (!h) return ''
  const parts = h.split('.')
  if (parts.length < 2) return ''
  return parts.slice(-2).join('.')
}

/**
 * 从 cert.pem 里读 zone 列表。
 *
 * cert.pem 的形状是：`-----BEGIN ARGO TUNNEL TOKEN-----` 包着一坨 base64，
 * base64 解出来是 `{ zones: [{id, name}], account: {...} }` 的 JSON。
 * 按 64 列折行，所以必须先把所有空白去掉再解。
 *
 * 任何一步失败（文件是空的、base64 坏了、JSON 坏了、zones 不是数组）
 * 都返回 `[]`——「读不到 zone」和「没有 zone」在这里是同一个后果：
 * 跳过 zone 校验，交给 cloudflared 自己报错。
 */
export function zonesFromPem(pem) {
  if (typeof pem !== 'string' || pem.length === 0) return []
  try {
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    if (!body) return []
    const json = JSON.parse(Buffer.from(body, 'base64').toString('utf8'))
    if (!Array.isArray(json?.zones)) return []
    return json.zones.filter((z) => z && typeof z.name === 'string' && z.name.length > 0)
  } catch {
    return []
  }
}

/**
 * 在 `tunnel list` 的结果里找同名隧道。
 *
 * 找到返回那一条（调用方复用它，不再 `tunnel create`——同名重复创建会报错）；
 * 找不到返回 `null`（调用方去创建）。非数组一律当空列表。
 */
export function pickTunnel(list, name) {
  if (!Array.isArray(list) || typeof name !== 'string' || !name) return null
  return list.find((t) => t && t.name === name) ?? null
}

/**
 * 归一 `--host` 参数：去首尾空白、转小写、去末尾的点。
 *
 * 末尾的点在 DNS 里等价（`example.com.` 就是 `example.com`），但 Cloudflare 的
 * API 收到带点的值建出来的记录会多一个点，回读自证时永远对不上——
 * 所以这里就抹平，和 `tools/lib/tunnel-args.mjs` 的 `normalizeHost` 保持一致。
 */
export function endpointHost(host) {
  if (typeof host !== 'string') return ''
  return host.trim().toLowerCase().replace(/\.+$/, '')
}
