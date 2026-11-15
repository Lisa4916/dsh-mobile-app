import { test } from 'node:test'
import assert from 'node:assert/strict'

import { zoneOf, zonesFromPem, pickTunnel, endpointHost } from '../lib/cf-setup.mjs'

/** 造一份 cloudflared 的 cert.pem：PEM 包着一坨 base64 的 JSON。 */
function fakePem(json) {
  const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
  // 按 64 列折行，跟真 cert.pem 一样
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${lines.join('\n')}\n-----END ARGO TUNNEL TOKEN-----\n`
}

test('zoneOf：取最后两段当根域名', () => {
  assert.equal(zoneOf('pocket.example.com'), 'example.com')
  assert.equal(zoneOf('a.b.example.com'), 'example.com')
  assert.equal(zoneOf('example.com'), 'example.com')
})

test('zoneOf：多级后缀的常见错判要兜住', () => {
  // com.cn / co.uk 这类二级后缀，最后两段会切错。这是已知限制，
  // 但至少要保证不会返回空串或抛异常——调用方靠它做「zone 在不在授权范围」的判断，
  // 返回错值只会让提示文案不准，不会写坏配置。
  assert.equal(typeof zoneOf('pocket.example.com.cn'), 'string')
  assert.notEqual(zoneOf('pocket.example.com.cn'), '')
})

test('zoneOf：大小写与末尾点归一', () => {
  assert.equal(zoneOf('Pocket.Example.COM'), 'example.com')
  assert.equal(zoneOf('pocket.example.com.'), 'example.com')
})

test('zoneOf：畸形输入返回空串，不抛', () => {
  assert.equal(zoneOf(''), '')
  assert.equal(zoneOf('   '), '')
  assert.equal(zoneOf(null), '')
  assert.equal(zoneOf(undefined), '')
  assert.equal(zoneOf('localhost'), '')
})

test('zonesFromPem：折行的 base64 能拼回 JSON', () => {
  const pem = fakePem({ zones: [{ id: 'abc', name: 'example.com' }, { id: 'def', name: 'other.net' }] })
  const zones = zonesFromPem(pem)
  assert.equal(zones.length, 2)
  assert.equal(zones[0].name, 'example.com')
  assert.equal(zones[1].id, 'def')
})

test('zonesFromPem：没有 zones 字段返回空数组', () => {
  assert.deepEqual(zonesFromPem(fakePem({ account: { id: 'x' } })), [])
})

test('zonesFromPem：坏 base64 / 坏 JSON / 空串都返回空数组，不抛', () => {
  assert.deepEqual(zonesFromPem(''), [])
  assert.deepEqual(zonesFromPem(null), [])
  assert.deepEqual(zonesFromPem('-----BEGIN X-----\n!!!!\n-----END X-----\n'), [])
  assert.deepEqual(zonesFromPem(fakePem({ zones: 'not-an-array' })), [])
})

test('zonesFromPem：过滤掉没有 name 的条目', () => {
  const pem = fakePem({ zones: [{ id: 'a' }, { id: 'b', name: 'ok.com' }] })
  const zones = zonesFromPem(pem)
  assert.equal(zones.length, 1)
  assert.equal(zones[0].name, 'ok.com')
})

test('pickTunnel：同名直接命中', () => {
  const list = [{ id: '1', name: 'a' }, { id: '2', name: 'dsh-pocket' }]
  assert.equal(pickTunnel(list, 'dsh-pocket')?.id, '2')
})

test('pickTunnel：没有同名返回 null（要新建）', () => {
  assert.equal(pickTunnel([{ id: '1', name: 'a' }], 'dsh-pocket'), null)
})

test('pickTunnel：空列表 / 非数组都返回 null', () => {
  assert.equal(pickTunnel([], 'x'), null)
  assert.equal(pickTunnel(null, 'x'), null)
  assert.equal(pickTunnel(undefined, 'x'), null)
})

test('endpointHost：把 --host 归一成纯主机名', () => {
  assert.equal(endpointHost('  Pocket.Example.COM  '), 'pocket.example.com')
  assert.equal(endpointHost('pocket.example.com.'), 'pocket.example.com')
})

test('endpointHost：畸形输入返回空串', () => {
  assert.equal(endpointHost(''), '')
  assert.equal(endpointHost(null), '')
})
