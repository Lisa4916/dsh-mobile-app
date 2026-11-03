#!/usr/bin/env node
/**
 * pocket-tunnel.mjs —— 把 dsh-pocket 的公网隧道从「quick（随机地址）」切到
 * 「named（固定域名）」，或者切回去。零依赖。
 *
 * ## 为什么需要它
 *
 * quick 隧道每次重开都会换一个 `https://<随机名>.trycloudflare.com`，这是**设计如此**，
 * 不是 bug。手机把上一次的地址存下来，隧道一换那条记录就是 NXDOMAIN —— 这是
 * 2026-11-03 那轮「公网连不上」的根因。App 侧已经能做到「有别的 base 就问出新地址、
 * 顺手删掉死条目」，但**一个可达的 base 都没有**时（在外面只插流量、电脑的局域网
 * 地址不可达），仍然谁也救不了。唯一根治办法是让地址不再变：named 隧道。
 *
 * ## 前置（只有你能做，一次性的）
 *
 * 1. 有一个托管在 Cloudflare 上的域名（Zero Trust → Networks → Tunnels 要求 zone 在这个账号里）；
 * 2. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared，
 *    复制那串 **Tunnel Token**；
 * 3. 在该隧道的 Public Hostname 里加一条：Subdomain/Domain 填你要的
 *    `pocket.example.com`，Service 填 `http://127.0.0.1:3081`（就是本机代理端口）。
 *
 * ## 用法
 *
 *   node tools/pocket-tunnel.mjs --status
 *   node tools/pocket-tunnel.mjs --host pocket.example.com --token <TUNNEL_TOKEN>
 *   node tools/pocket-tunnel.mjs --quick
 *
 * `--host/--token` 会先写配置（`tunnel.setConfig`），再重启隧道（`tunnel.stop` →
 * `tunnel.start`），最后回读 `pocket.status` 自证。切换完手机里那条「公网隧道」
 * 档案会在下一次连上时自动换成新域名（`pocket.status` 的 `publicEndpoint` 现在已经
 * 接受自有域名，不再只认 `.trycloudflare.com`）。
 *
 * ## 为什么走 RPC 而不是直接改 settings.json
 *
 * 直接改文件要重启 DSH 才生效，而且 `tunnelToken` 的写入路径带格式校验（≥20 位
 * base64url）。走 `tunnel.setConfig` 让 dsh-pocket 自己校验、自己持久化，还能顺手
 * 把隧道重启到新配置上。
 */

import { request } from 'node:http'

/** 本机代理端口。dsh-pocket 的默认值就是 3081。 */
const DEFAULT_BASE = 'http://127.0.0.1:3081'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

const BASE = (valueOf('--base') ?? DEFAULT_BASE).replace(/\/+$/, '')

/**
 * 用 cookie 罐发一次请求。
 *
 * `pocket.status` / `tunnel.setConfig` 这类 RPC **必须带 `dsh-auth-*` cookie**，
 * 裸 POST 恒 401（实测）。而 Node 的 http 客户端不维护 cookie 罐，所以这里手工
 * 从 `Set-Cookie` 里捡 `dsh-auth-` 开头的那条。先 GET 一次 `/?token=<PIN>` 拿票，
 * 后面的请求都带上。
 */
let cookie = ''

function call(method, path, body, timeoutMs = 8_000) {
  const url = new URL(BASE + path)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const jar = res.headers['set-cookie'] ?? []
        for (const line of jar) {
          const pair = line.split(';', 1)[0].trim()
          if (pair.startsWith('dsh-auth-')) cookie = pair
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 走 `/dsh-pocket/<method>` 的 RPC。返回 `result.value`（剥掉服务端信封）。 */
async function rpc(method, payload = null, timeoutMs = 8_000) {
  const res = await call('POST', `/dsh-pocket/${method}`, { rpcId: 'cli', method, payload }, timeoutMs)
  if (res.status !== 200) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${res.body.slice(0, 200)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    throw new Error(`${method} 返回的不是 JSON：${res.body.slice(0, 200)}`)
  }
  // 信封：{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{…}}}
  const result = parsed?.result ?? parsed
  if (result?.ok === false) {
    throw new Error(`${method} 失败：${result?.error?.message ?? result?.error ?? '未知错误'}`)
  }
  if (result?.ok === true && 'value' in result) return result.value
  return result
}

/** 取票：先 GET 一次首页，让服务端下发 `dsh-auth-*`。 */
async function seed() {
  const pin = valueOf('--pin')
  const path = pin ? `/?token=${encodeURIComponent(pin)}` : '/'
  const res = await call('GET', path)
  if (!cookie) {
    throw new Error(
      `没拿到 dsh-auth-* cookie（GET ${BASE}${path} → ${res.status}）。`
      + '如果设了公网/局域网密码，请加 --pin <PIN>。',
    )
  }
}

function printStatus(s) {
  const cfg = s?.tunnelConfig ?? {}
  console.log('--- pocket.status ---')
  console.log(`  proxyRunning   : ${s?.proxyRunning}`)
  console.log(`  proxyPort      : ${s?.proxyPort}`)
  console.log(`  lanUrl         : ${s?.lanUrl}`)
  console.log(`  tunnelRunning  : ${s?.tunnelRunning}`)
  console.log(`  tunnelUrl      : ${s?.tunnelUrl}`)
  console.log(`  tunnelState    : ${JSON.stringify(s?.tunnelState)}`)
  console.log(`  tunnelConfig   : mode=${cfg.mode} hostname=${cfg.hostname || '(空)'} tokenSet=${cfg.tokenSet}`)
  console.log(`  accessToken    : ${s?.accessToken ? '(已设置)' : '(无)'}`)
}

async function main() {
  await seed()

  if (has('--status') || argv.length === 0) {
    printStatus(await rpc('pocket.status'))
    return
  }

  if (has('--quick')) {
    // 切回 quick 时**顺便清空 hostname**：留着它在 quick 模式下虽然不参与启动，
    // 但会让 --status 与回读比对都变得含糊（看着像还配了固定域名）。
    const before = snapshotConfig(await rpc('pocket.status'))
    const after = await rpc('tunnel.setConfig', { mode: 'quick', hostname: '' })
    console.log('已切回 quick（随机地址，每次重开都会变）：', JSON.stringify(after?.tunnelConfig ?? after))
    await restartTunnel('quick', before)
    printStatus(await rpc('pocket.status'))
    return
  }

  const host = valueOf('--host')
  const token = valueOf('--token')
  if (!host) {
    console.error('用法：node tools/pocket-tunnel.mjs --host <固定域名> --token <Tunnel Token>')
    console.error('      node tools/pocket-tunnel.mjs --quick')
    console.error('      node tools/pocket-tunnel.mjs --status')
    process.exit(2)
  }
  if (!token) {
    console.error('缺 --token：Cloudflare Zero Trust → Networks → Tunnels 里那串 Tunnel Token。')
    process.exit(2)
  }

  // **先本地校验 token，再动配置。**
  //
  // 踩过的坑（2026-11-03）：服务端的 `tunnel.setConfig` 是三步写——先
  // `setTunnelMode`、再 `setTunnelHostname`、最后 `setTunnelToken`，**不原子**。
  // 拿 `--token abc` 去试，前两步成功落盘、第三步抛「格式不对」，结果 settings.json
  // 变成 `tunnelMode:"named"` 却没有 token —— 隧道直接起不来，比改之前更坏。
  // 所以格式问题必须在发请求之前拦掉；同理，任何一步失败都要回滚旧配置。
  const tokenProblem = validateToken(token)
  if (tokenProblem) {
    console.error(`--token ${tokenProblem}`)
    console.error('（这是 Cloudflare 后台复制的整串 Token，通常 100+ 字符）')
    process.exit(2)
  }

  const before = snapshotConfig(await rpc('pocket.status'))
  const after = await rpc('tunnel.setConfig', { mode: 'named', hostname: host, token })
  console.log('已写入配置：', JSON.stringify(after?.tunnelConfig ?? after))
  await restartTunnel('named', before)

  const status = await rpc('pocket.status')
  printStatus(status)
  const cfg = status?.tunnelConfig ?? {}
  if (cfg.mode !== 'named' || cfg.hostname !== host.toLowerCase() || cfg.tokenSet !== true) {
    console.error('!! 回读的配置与期望不一致，请检查上面几行。')
    process.exit(1)
  }
  if (status?.tunnelRunning !== true || !String(status?.tunnelUrl ?? '').includes(host.toLowerCase())) {
    console.error('!! 隧道起来了但地址不是固定域名，看 tunnelState 里的 detail。')
    process.exit(1)
  }
  console.log(`\n固定地址（重启不变）：${status.tunnelUrl}`)
  console.log('手机侧：连任一条能通的入口（局域网/回环）就会自动把「公网隧道」档案换成这个域名。')
}

/**
 * 与 dsh-pocket `lib/settings.mjs` 的 `setTunnelToken` 同一套规则：
 * 非空时至少 20 个 base64url 字符，且只含 `A-Za-z0-9+/_=-`。
 * 返回 null 表示通过，否则返回人话原因。
 */
function validateToken(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return '为空'
  if (v.length < 20) return `太短（${v.length} 字符，至少要 20）`
  if (!/^[A-Za-z0-9+/_=-]+$/.test(v)) return '含非法字符（只允许 A-Za-z0-9+/_=-）'
  return null
}

/** 记下切之前的配置，失败时用来回滚。 */
function snapshotConfig(status) {
  const cfg = status?.tunnelConfig ?? {}
  return {
    mode: cfg.mode === 'named' ? 'named' : 'quick',
    hostname: cfg.hostname ?? '',
    hadToken: cfg.tokenSet === true,
  }
}

/**
 * 停→启。`tunnel.start` 服务端强制要求 `payload.disclaimer === true`。
 *
 * 启动失败时回滚配置——把「本来能跑的 quick」换成「配了一半的 named」是纯粹的
 * 破坏，用户下次开 App 只会看到连不上，看不出是配置残留。
 */
async function restartTunnel(targetMode, before) {
  try {
    await rpc('tunnel.stop')
    console.log('已停止旧隧道。')
  } catch (err) {
    console.log(`停止旧隧道时出错（可能本来就没开）：${err.message}`)
  }
  console.log('正在启动新隧道（cloudflared 注册边缘连接，通常 2-15 秒）…')
  try {
    // 启动要等 cloudflared 跟边缘握手并拿到地址，实测 8 秒不够（会误报超时，
    // 而服务端其实已经起来了）。给 45 秒。
    await rpc('tunnel.start', { disclaimer: true }, 45_000)
  } catch (err) {
    const msg = err.message
    console.error(`\n启动失败：${msg}`)
    if (/429|provisioning failed/i.test(msg)) {
      console.error(
        '\n这条是 Cloudflare 对 **quick 隧道** 的限流（429 quick tunnel provisioning failed）。'
        + '\n短时间内反复 stop/start 会触发它，等几分钟再试即可，不涉及你的账号或配置。'
        + '\n也正因为 quick 隧道有这种配额与随机地址两重麻烦，才建议切到 named 固定域名。',
      )
    }
    if (before.hadToken || before.mode !== targetMode) {
      console.log('\n回滚到切换前的配置…')
      try {
        await rpc('tunnel.setConfig', {
          mode: before.mode,
          hostname: before.hostname,
          ...(before.hadToken ? {} : { token: '' }),
        })
        console.log('已回滚。')
      } catch (rollbackErr) {
        console.error(`回滚也失败了：${rollbackErr.message}`)
      }
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`[pocket-tunnel] ${err.message}`)
  process.exit(1)
})
