#!/usr/bin/env node
/**
 * cf-named-setup.mjs —— 一条命令把 dsh-pocket 的公网入口从「quick 随机地址」
 * 切成「named 固定域名」。零依赖，只用本机已有的 cloudflared + pocket-tunnel.mjs。
 *
 * ## 为什么需要它
 *
 * `tools/pocket-tunnel.mjs --host --token` 已经能把配置写对，但它**要你先去
 * Cloudflare 后台手工建 tunnel、手工复制 Token、手工加 Public Hostname**。
 * 三件事都在网页里点，任何一步点错（比如 Service 填成 https、或者域名没托管在
 * 这个账号里）都要等 `restartTunnel` 二十几秒才从报错里看出来。
 *
 * 这三步 cloudflared CLI 全都能做，前提是 `~/.cloudflared/cert.pem` 存在
 * （`cloudflared tunnel login` 授权一次，之后一直有效）。
 *
 * ## 前置（唯一需要人做的一步）
 *
 *   cloudflared tunnel login
 *
 * 它会在浏览器打开授权页，选一个托管在 Cloudflare 上的 zone 点 Authorize，
 * 证书落到 `~/.cloudflared/cert.pem`。**这一步只能人来点**——它要在浏览器里
 * 登录你的 Cloudflare 账号。
 *
 * ## 用法
 *
 *   node tools/cf-named-setup.mjs --status
 *      只体检：cert.pem 在不在、账号下有哪些 zone、已有哪些 tunnel。
 *
 *   node tools/cf-named-setup.mjs --host pocket.example.com
 *      全自动：建 tunnel（已存在则复用）→ 取 Token → 配 DNS → 写进 pocket → 重启自证。
 *
 *   node tools/cf-named-setup.mjs --host pocket.example.com --tunnel dsh-remote
 *      换个 tunnel 名（默认 `dsh-pocket`）。
 *
 *   node tools/cf-named-setup.mjs --host pocket.example.com --dry-run
 *      只打印将要执行的命令，一条都不跑。
 *
 * ## 它会改什么
 *
 * 1. Cloudflare 账号里：新建一个 tunnel（或复用同名的）+ 一条指向它的 DNS 记录；
 * 2. 本机 `~/.dsh/dsh-pocket/settings.json`：`tunnelMode/tunnelHostname/tunnelToken`；
 * 3. 重启 pocket 的隧道进程。
 *
 * **DNS 记录是新建的**。如果那个主机名已经有记录（比如一条指向旧隧道的 CNAME），
 * `cloudflared tunnel route dns` 会直接报错退出，不会覆盖——那时要么换主机名，
 * 要么先去后台删掉旧记录。这条是故意的：静默覆盖 DNS 的脚本比不写脚本更危险。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { endpointHost, pickTunnel, zoneOf, zonesFromPem } from './lib/cf-setup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** cloudflared 的搜索顺序：PATH 里有就用 PATH 的，否则用 dsh-pocket 自己下好的那份。 */
const CLOUDFLARED_CANDIDATES = [
  join(homedir(), '.dsh', 'dsh-pocket', 'bin', 'cloudflared.exe'),
  join(homedir(), '.dsh', 'dsh-pocket', 'cloudflared.exe'),
]

const CERT_PATH = join(homedir(), '.cloudflared', 'cert.pem')
const DEFAULT_TUNNEL_NAME = 'dsh-pocket'
/** pocket 的反代端口。`tunnel route dns` 写的是 DNS，Service 由 pocket 自己起。 */
const POCKET_PORT = 3081

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

const DRY = has('--dry-run')
/** `--host` 归一成纯主机名：去空白、转小写、去末尾的点。规则在 lib 里，可单测。 */
const HOST = endpointHost(valueOf('--host'))
const TUNNEL = valueOf('--tunnel') ?? DEFAULT_TUNNEL_NAME

/** 找到可用的 cloudflared 二进制。找不到就把所有候选列出来，不要静默失败。 */
function findCloudflared() {
  for (const p of CLOUDFLARED_CANDIDATES) {
    if (existsSync(p)) return p
  }
  try {
    // PATH 里那份（如果用户自己装过）
    const out = execFileSync('cloudflared', ['--version'], { encoding: 'utf8' })
    if (/cloudflared version/i.test(out)) return 'cloudflared'
  } catch {
    // 落下去报错
  }
  throw new Error(
    '找不到 cloudflared。候选路径都对不上：\n  '
    + CLOUDFLARED_CANDIDATES.join('\n  ')
    + '\n先开一次 dsh-pocket 的公网隧道，它会自己下到第一个候选路径。',
  )
}

const CF = (() => {
  try {
    return findCloudflared()
  } catch (err) {
    console.error(`[cf-named-setup] ${err.message}`)
    process.exit(1)
  }
})()

/** 跑一条 cloudflared 子命令，返回 stdout。失败时把 stderr 原样抛出来。 */
function cf(args, { allowFail = false } = {}) {
  if (DRY) {
    console.log(`  [dry-run] cloudflared ${args.join(' ')}`)
    return ''
  }
  try {
    return execFileSync(CF, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const detail = String(err.stderr ?? err.message ?? '').trim()
    if (allowFail) return ''
    throw new Error(`cloudflared ${args[0]} 失败：\n${detail}`)
  }
}

/** cert.pem 有没有。没有就没法建 tunnel，也没有别的绕法。 */
function requireCert() {
  if (existsSync(CERT_PATH)) return true
  console.error('还没授权：找不到 ' + CERT_PATH)
  console.error('')
  console.error('先跑一次（只需要一次，之后一直有效）：')
  console.error('')
  console.error(`  "${CF}" --no-autoupdate tunnel login`)
  console.error('')
  console.error('它会在浏览器打开授权页，选一个托管在 Cloudflare 上的域名点 Authorize。')
  console.error('这一步只能在浏览器里由你本人完成。')
  return false
}

/** 从 cert.pem 里抠出这个证书授权的 zone 列表。解析逻辑在 lib 里，可单测。 */
function zonesFromCert() {
  try {
    return zonesFromPem(readFileSync(CERT_PATH, 'utf8'))
  } catch {
    return []
  }
}

/** 已有的 tunnel 列表（名字 → id）。 */
function listTunnels() {
  const out = cf(['tunnel', 'list', '--output', 'json'], { allowFail: true })
  if (!out.trim()) return []
  try {
    const arr = JSON.parse(out)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function printStatus() {
  console.log('--- cloudflared ---')
  console.log(`  二进制：${CF}`)
  console.log(`

--- 授权证书 ---`)
  if (existsSync(CERT_PATH)) {
    console.log(`  ${CERT_PATH} ✅`)
  } else {
    console.log(`  ${CERT_PATH} ❌（先 tunnel login）`)
  }
  const zones = zonesFromCert()
  console.log('--- 账号下的 zone ---')
  if (zones.length === 0) {
    console.log('  （cert.pem 里没读到，或还没授权）')
  } else {
    for (const z of zones) console.log(`  ${z.name}  id=${z.id}`)
  }
  console.log('--- 已有 tunnel ---')
  const tunnels = listTunnels()
  if (tunnels.length === 0) {
    console.log('  （没有，或读不到）')
  } else {
    for (const t of tunnels) console.log(`  ${t.name}  id=${t.id}`)
  }
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
  if (!HOST) {
    console.error('要给 --host，例如 --host pocket.example.com')
    process.exit(2)
  }
  if (!DRY && !requireCert()) process.exit(1)

  const zoneName = zoneOf(HOST)
  const zones = zonesFromCert()
  if (zones.length > 0 && !zones.some((z) => z.name === zoneName)) {
    console.error(`域名 ${HOST} 的根 zone 是 ${zoneName}，但它不在 cert.pem 授权的 zone 里。`)
    console.error('已授权的是：' + zones.map((z) => z.name).join(', '))
    console.error('要么换个域名，要么重新 tunnel login 时选对 zone。')
    process.exit(2)
  }

  console.log(`\n[1/4] 建/复用 tunnel「${TUNNEL}」`)
  const existing = pickTunnel(listTunnels(), TUNNEL)
  if (existing) {
    console.log(`  已存在，复用：id=${existing.id}`)
  } else {
    cf(['tunnel', 'create', TUNNEL])
    console.log('  已创建')
  }

  console.log('\n[2/4] 取 Tunnel Token')
  const token = cf(['tunnel', 'token', TUNNEL]).trim()
  if (!DRY && token.length < 20) {
    console.error('  Token 看起来不对（太短），停在这里，不去写坏配置。')
    process.exit(1)
  }
  if (DRY) console.log('  [dry-run] 跳过')

  console.log(`\n[3/4] 把 ${HOST} 指到这条 tunnel`)
  cf(['tunnel', 'route', 'dns', TUNNEL, HOST])
  console.log('  DNS 记录已建（已存在会在这里报错，不会覆盖）')

  console.log('\n[4/4] 写进 dsh-pocket 并重启自证')
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

  console.log('\n完成。手机里那条「公网隧道」档案会在下一次连上任一条入口时自动换成这个域名。')
  console.log(`隧道后端：http://127.0.0.1:${POCKET_PORT}（由 dsh-pocket 自己起，这条脚本不碰）`)
}

if (has('--status') || argv.length === 0) {
  printStatus()
} else {
  setup().catch((err) => {
    console.error(`[cf-named-setup] ${err.message}`)
    process.exit(1)
  })
}
