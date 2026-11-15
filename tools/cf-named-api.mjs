#!/usr/bin/env node
/**
 * cf-named-api.mjs —— 用 Cloudflare API Token 把 dsh-pocket 的公网入口
 * 从「quick 随机地址」切成「named 固定域名」。不需要浏览器、不需要点 Authorize。
 *
 * ## 为什么有这条路线
 *
 * `tools/cf-named-setup.mjs` 走的是 `cloudflared tunnel login`，那条路要在浏览器里
 * 授权。实测 dash.cloudflare.com 对未登录请求返 403 骨架屏（Edge 和 Chrome 都停在
 * 加载动画上），这条路在无痕 profile 里走不通。而 `api.cloudflare.com` 是通的
 * （无 token 请求返 400 而不是超时），所以改成全程走 API。
 *
 * ## 一次性准备（两个值，只从环境变量读）
 *
 * 1. Cloudflare 后台建一个 API Token，权限：
 *      Account → Cloudflare Tunnel → Edit
 *      Zone    → DNS               → Edit
 * 2. Account ID 在后台首页右侧栏。
 *
 *   PowerShell:  $env:CF_API_TOKEN='...'; $env:CF_ACCOUNT_ID='...'
 *   bash:        export CF_API_TOKEN=... CF_ACCOUNT_ID=...
 *
 * 这两个值不落盘、不进 git、不写进任何配置文件。脚本只在内存里用。
 *
 * ## 用法
 *
 *   node tools/cf-named-api.mjs --status
 *       体检：token 有没有、是哪个账号、账号下有哪些 zone、已有哪些隧道。
 *
 *   node tools/cf-named-api.mjs --host pocket.example.com
 *       全自动五步：查 zone → 建/复用隧道 → 设 ingress → 建 DNS → 写进 pocket 并重启。
 *
 *   node tools/cf-named-api.mjs --host pocket.example.com --tunnel dsh-remote
 *       换隧道名（默认 dsh-pocket）。
 *
 *   node tools/cf-named-api.mjs --host pocket.example.com --dry-run
 *       只打印将发的请求，一个都不发。
 *
 * ## 它会改什么
 *
 * 1. Cloudflare 账号里：新建一条 tunnel（同名未删则复用）+ 它的 ingress 配置 +
 *    一条 CNAME（`<你的域名>` → `<隧道ID>.cfargotunnel.com`，开代理）；
 * 2. 本机 `~/.dsh/dsh-pocket/settings.json`：`tunnelMode/tunnelHostname/tunnelToken`；
 * 3. 重启 pocket 的隧道进程并自证。
 *
 * **DNS 是 upsert**：同名记录已存在就改它（不像 `cloudflared tunnel route dns` 那样
 * 直接报错）。改之前会读一次现有记录并打印「旧值 → 新值」，事后可从输出里恢复。
 */

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dnsRecordBody,
  ingressBody,
  pickAccount,
  pickZone,
  tokenFromTunnel,
  tunnelCreateBody,
  tunnelFromList,
} from './lib/cf-api.mjs'
import { endpointHost } from './lib/cf-setup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const API = 'https://api.cloudflare.com/client/v4'
const DEFAULT_TUNNEL_NAME = 'dsh-pocket'
const POCKET_PORT = 3081

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

const DRY = has('--dry-run')
const HOST = endpointHost(valueOf('--host'))
const TUNNEL = valueOf('--tunnel') ?? DEFAULT_TUNNEL_NAME
const TOKEN = String(process.env.CF_API_TOKEN ?? '').trim()
const ACCOUNT_HINT = String(process.env.CF_ACCOUNT_ID ?? '').trim()

function die(msg, code = 1) {
  console.error(`[cf-named-api] ${msg}`)
  process.exit(code)
}

function requireEnv() {
  if (!TOKEN) {
    die(
      '缺 CF_API_TOKEN。\n\n'
      + '去 Cloudflare 后台建一个 API Token，权限给：\n'
      + '  Account → Cloudflare Tunnel → Edit\n'
      + '  Zone    → DNS               → Edit\n\n'
      + '然后：$env:CF_API_TOKEN=\'你的token\'',
      2,
    )
  }
  if (!ACCOUNT_HINT) {
    die('缺 CF_ACCOUNT_ID。后台首页右侧栏那串 32 位十六进制。\n\n$env:CF_ACCOUNT_ID=\'...\'', 2)
  }
}

/** 发一个 API 请求。失败时把 Cloudflare 的 errors 数组原样打出来。 */
async function api(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`
  if (DRY && method !== 'GET') {
    console.log(`  [dry-run] ${method} ${path}`)
    if (body) console.log(`            ${JSON.stringify(body)}`)
    return {}
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    die(`${method} ${path} 返回的不是 JSON（HTTP ${res.status}）：\n${text.slice(0, 400)}`)
  }
  if (!json.success) {
    const detail = (json.errors ?? []).map((e) => `  ${e.code}: ${e.message}`).join('\n')
    die(`${method} ${path} 失败（HTTP ${res.status}）：\n${detail || text.slice(0, 400)}`)
  }
  return json.result
}

async function resolveAccountId() {
  const accounts = await api('/accounts')
  const picked = pickAccount(accounts, ACCOUNT_HINT)
  if (!picked) {
    const names = (accounts ?? []).map((a) => a.name).join(', ')
    die(`CF_ACCOUNT_ID=${ACCOUNT_HINT} 在 token 可见的账号里没找到。可见的是：${names || '（一个都没有）'}`, 2)
  }
  return picked.id
}

async function status() {
  requireEnv()
  const accounts = await api('/accounts')
  console.log('--- 账号 ---')
  for (const a of accounts ?? []) console.log(`  ${a.name}  id=${a.id}`)

  const accountId = await resolveAccountId()
  const zones = await api(`/zones?account.id=${accountId}&per_page=50`)
  console.log('--- zone ---')
  if (!zones || zones.length === 0) console.log('  （这个账号下没有 zone）')
  else for (const z of zones) console.log(`  ${z.name}  id=${z.id}  status=${z.status}`)

  const tunnels = await api(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`)
  console.log('--- 已有隧道 ---')
  const alive = (tunnels ?? []).filter((t) => !t.deleted_at)
  if (alive.length === 0) console.log('  （没有）')
  else for (const t of alive) console.log(`  ${t.name}  id=${t.id}  status=${t.status ?? '-'}`)

  console.log('--- 当前 pocket 隧道 ---')
  try {
    const out = execFileSync(
      process.execPath,
      [join(REPO, 'tools', 'pocket-tunnel.mjs'), '--status'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    console.log(out.trim().split('\n').map((l) => '  ' + l).join('\n'))
  } catch (err) {
    console.log(`  读不到：${String(err.stderr ?? err.message).trim().split('\n')[0]}`)
  }
}

async function setup() {
  if (!HOST) die('要给 --host，例如 --host pocket.example.com', 2)
  requireEnv()

  const accountId = await resolveAccountId()
  console.log(`账号 ${ACCOUNT_HINT} ✅`)

  console.log(`\n[1/5] 找 ${HOST} 所属的 zone`)
  const zones = await api(`/zones?account.id=${accountId}&per_page=50`)
  const zone = pickZone(zones, HOST)
  if (!zone) {
    const names = (zones ?? []).map((z) => z.name).join(', ')
    die(`${HOST} 的根域名不在这账号下。已有 zone：${names || '（一个都没有）'}`, 2)
  }
  console.log(`  zone ${zone.name}  id=${zone.id}`)

  console.log(`\n[2/5] 建/复用隧道「${TUNNEL}」`)
  const tunnels = await api(`/accounts/${accountId}/cfd_tunnel?is_deleted=false`)
  let tunnel = tunnelFromList(tunnels, TUNNEL)
  if (tunnel) {
    console.log(`  已存在，复用：id=${tunnel.id}`)
  } else {
    tunnel = await api(`/accounts/${accountId}/cfd_tunnel`, {
      method: 'POST',
      body: tunnelCreateBody(TUNNEL),
    })
    console.log(`  已创建：id=${tunnel.id ?? '(dry-run)'}`)
  }
  const tunnelId = tunnel.id ?? 'TUNNEL_ID'

  console.log('\n[3/5] 设 ingress')
  console.log(`  ${HOST} → http://127.0.0.1:${POCKET_PORT}（兜底 404）`)
  await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: ingressBody(HOST, POCKET_PORT),
  })

  console.log('\n[4/5] 建/更新 DNS 记录')
  const existing = await api(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(HOST)}`)
  const old = (existing ?? []).find((r) => r.name === HOST)
  if (old) {
    console.log(`  已有记录：${old.type} ${old.name} → ${old.content}${old.proxied ? ' (proxied)' : ''}`)
    console.log('  将改成上面的 cfargotunnel 地址（旧值记在这里，可随时改回）')
  }
  const body = dnsRecordBody(HOST, tunnelId)
  if (old) {
    await api(`/zones/${zone.id}/dns_records/${old.id}`, { method: 'PUT', body })
  } else {
    await api(`/zones/${zone.id}/dns_records`, { method: 'POST', body })
  }
  console.log(`  ${body.type} ${body.name} → ${body.content} proxied=${body.proxied}`)

  console.log('\n[5/5] 取 tunnel token 并写进 dsh-pocket')
  const tokenResult = await api(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)
  const token = tokenFromTunnel(tokenResult)
  if (!DRY && token.length < 20) die('拿到的 token 太短，停在这里，不去写坏配置')
  if (DRY) {
    console.log(`  [dry-run] node tools/pocket-tunnel.mjs --host ${HOST} --token <上面那串>`)
    console.log('\n（dry-run，什么都没改）')
    return
  }
  execFileSync(
    process.execPath,
    [join(REPO, 'tools', 'pocket-tunnel.mjs'), '--host', HOST, '--token', token],
    { stdio: 'inherit' },
  )

  console.log(`\n完成。手机里那条「公网隧道」档案会在下次连上任一入口时换成 https://${HOST}/`)
  console.log('（隧道后端仍由 dsh-pocket 自己起在 127.0.0.1:' + POCKET_PORT + '，这条脚本不碰）')
}

const run = has('--status') || argv.length === 0 ? status : setup
run().catch((err) => die(err.message))
