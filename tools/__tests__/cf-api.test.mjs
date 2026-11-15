import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  tunnelCreateBody,
  ingressBody,
  dnsRecordBody,
  pickAccount,
  pickZone,
  tunnelFromList,
  tokenFromTunnel,
} from '../lib/cf-api.mjs'

test('tunnelCreateBody：config_src 必须是 cloudflare', () => {
  // 不给 config_src 时 Cloudflare 建出来的是「本地配置」型隧道，
  // 那样 ingress 只能靠 cloudflared 的 config.yml，pocket 走的是
  // `tunnel run --token`，压根读不到本地配置 → 隧道起来了但全 502。
  const b = tunnelCreateBody('dsh-pocket')
  assert.equal(b.name, 'dsh-pocket')
  assert.equal(b.config_src, 'cloudflare')
})

test('tunnelCreateBody：名字原样传，不 trim 不改大小写', () => {
  // 服务端对隧道名有自己的规则（字母数字连字符），本地擅自加工反而会对不上
  // 后面用同一个名字查列表时的结果
  assert.equal(tunnelCreateBody('DSH Pocket').name, 'DSH Pocket')
})

test('ingressBody：pocket 那条在最前，兜底 404 在后', () => {
  const b = ingressBody('pocket.example.com', 3081)
  const rules = b.config.ingress
  assert.equal(rules.length, 2)
  assert.equal(rules[0].hostname, 'pocket.example.com')
  assert.equal(rules[0].service, 'http://127.0.0.1:3081')
  assert.equal(rules[1].service, 'http_status:404')
  // 兜底规则不能带 hostname，否则它会抢掉所有没匹配上的域名
  assert.equal('hostname' in rules[1], false)
})

test('ingressBody：service 必须走 http 而不是 https', () => {
  // pocket 的 3081 是明文 HTTP。写成 https 会让 cloudflared 去跟它做 TLS
  // 握手，立刻报 x509 / connection reset，而且错误只出现在隧道日志里。
  const b = ingressBody('pocket.example.com', 3081)
  assert.match(b.config.ingress[0].service, /^http:\/\//)
})

test('ingressBody：端口跟着参数走', () => {
  const b = ingressBody('a.example.com', 9999)
  assert.equal(b.config.ingress[0].service, 'http://127.0.0.1:9999')
})

test('dnsRecordBody：CNAME 指向 <tunnelId>.cfargotunnel.com 且走代理', () => {
  const b = dnsRecordBody('pocket.example.com', '6ff42ae2-765d-4adf-8112-31c55c1551ef')
  assert.equal(b.type, 'CNAME')
  assert.equal(b.name, 'pocket.example.com')
  assert.equal(b.content, '6ff42ae2-765d-4adf-8112-31c55c1551ef.cfargotunnel.com')
  // 不代理就等于把隧道 ID 暴露成公网 CNAME，而且 Cloudflare 的 WAF/证书都用不上
  assert.equal(b.proxied, true)
  // ttl=1 是 Cloudflare 的「自动」
  assert.equal(b.ttl, 1)
})

test('pickAccount：只有一个直接用', () => {
  assert.equal(pickAccount([{ id: 'a1', name: 'me@example.com' }])?.id, 'a1')
})

test('pickAccount：多个时按 name 精确挑', () => {
  const list = [
    { id: 'a1', name: 'one@example.com' },
    { id: 'a2', name: 'two@example.com' },
  ]
  assert.equal(pickAccount(list, 'two@example.com')?.id, 'a2')
})

test('pickAccount：给了 hint 但没匹配上返回 null（不瞎猜）', () => {
  const list = [{ id: 'a1', name: 'one@example.com' }]
  assert.equal(pickAccount(list, 'nope@example.com'), null)
})

test('pickAccount：空列表 / 非数组返回 null', () => {
  assert.equal(pickAccount([]), null)
  assert.equal(pickAccount(null), null)
  assert.equal(pickAccount(undefined), null)
})

test('pickZone：按 host 的根域名精确匹配', () => {
  const zones = [
    { id: 'z1', name: 'other.net' },
    { id: 'z2', name: 'example.com' },
  ]
  assert.equal(pickZone(zones, 'pocket.example.com')?.id, 'z2')
})

test('pickZone：zone 名大小写与末尾点不影响匹配', () => {
  const zones = [{ id: 'z2', name: 'Example.COM' }]
  assert.equal(pickZone(zones, 'pocket.example.com')?.id, 'z2')
})

test('pickZone：域名不在账号下返回 null', () => {
  assert.equal(pickZone([{ id: 'z1', name: 'other.net' }], 'pocket.example.com'), null)
})

test('tunnelFromList：命中的那条返回', () => {
  const list = [
    { id: 't1', name: 'a', deleted_at: null },
    { id: 't2', name: 'dsh-pocket', deleted_at: null },
  ]
  assert.equal(tunnelFromList(list, 'dsh-pocket')?.id, 't2')
})

test('tunnelFromList：已删除的同名隧道不能复用', () => {
  // 删掉的隧道在列表里还会出现一段时间（deleted_at 非空）。
  // 复用它建的 DNS 会指向一个不存在的隧道，访问直接 1033。
  const list = [
    { id: 't1', name: 'dsh-pocket', deleted_at: '2026-01-01T00:00:00Z' },
  ]
  assert.equal(tunnelFromList(list, 'dsh-pocket'), null)
})

test('tunnelFromList：没有同名的返回 null', () => {
  assert.equal(tunnelFromList([{ id: 't1', name: 'a', deleted_at: null }], 'dsh-pocket'), null)
})

test('tokenFromTunnel：建隧道时 token 在 result.token 里', () => {
  assert.equal(tokenFromTunnel({ id: 't1', token: 'eyJhIjoidCJ9' }), 'eyJhIjoidCJ9')
})

test('tokenFromTunnel：查 token 接口的 result 是裸字符串', () => {
  assert.equal(tokenFromTunnel('eyJhIjoidCJ9'), 'eyJhIjoidCJ9')
})

test('tokenFromTunnel：拿不到就返回空串，绝不返回半截', () => {
  assert.equal(tokenFromTunnel({ id: 't1' }), '')
  assert.equal(tokenFromTunnel(null), '')
  assert.equal(tokenFromTunnel(undefined), '')
  assert.equal(tokenFromTunnel({ token: 123 }), '')
  assert.equal(tokenFromTunnel({ token: '' }), '')
})
