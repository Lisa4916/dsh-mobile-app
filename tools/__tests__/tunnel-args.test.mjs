// `tools/pocket-tunnel.mjs` 的参数预校验。
//
// 为什么值得单独测：这两个校验的唯一职责就是**在发 RPC 之前把坏输入拦下来**。
// 服务端的 `tunnel.setConfig` 是三步写（mode → hostname → token），不原子：
// 坏值漏过去就会留下「tunnelMode:"named" 却没有 token」这种半残配置，
// 隧道起不来，而且比改之前更坏。
//
// 红→绿：先写这些断言，跑出来 `Cannot find module '../lib/tunnel-args.mjs'`，
// 再写实现。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateHost, validateToken, normalizeHost } from '../lib/tunnel-args.mjs'

// ---- token ----

test('token：形如 Cloudflare 后台那串就通过', () => {
  // 实际长度 100+，这里给一个够长、字符集合法的样例
  const tok = 'eyJhIjoiYWM4ZjFkIn0abc_DEF-123+/456789'
  assert.equal(validateToken(tok), null)
})

test('token：为空要拦', () => {
  assert.notEqual(validateToken(''), null)
})

test('token：太短要拦（服务端要求 ≥20）', () => {
  assert.notEqual(validateToken('abcdefghij'), null)
})

test('token：含非法字符要拦', () => {
  // 空格、中文、花括号都在服务端的字符集之外
  assert.notEqual(validateToken('abcdefghij klmnopqrst'), null)
  assert.notEqual(validateToken('abcdefghij中文补足长度不是问题'), null)
})

test('token：前后空白先 trim 再判，不能因为多了个换行就报错', () => {
  const tok = 'eyJhIjoiYWM4ZjFkIn0abc_DEF-123+/456789'
  assert.equal(validateToken(`  ${tok}\n`), null)
})

// ---- host ----

test('host：正常域名通过', () => {
  assert.equal(validateHost('pocket.example.com'), null)
})

test('host：子域多级也通过', () => {
  assert.equal(validateHost('a.b.c.example.com'), null)
})

test('host：带 https:// 前缀要拦，并提示只填主机名', () => {
  // 这是最容易犯的错：用户从浏览器地址栏整条复制
  const msg = validateHost('https://pocket.example.com')
  assert.notEqual(msg, null)
  assert.match(msg, /主机名/)
})

test('host：带路径要拦', () => {
  assert.notEqual(validateHost('pocket.example.com/foo'), null)
})

test('host：带端口要拦', () => {
  // Cloudflare 隧道只吃主机名，端口由它自己决定
  assert.notEqual(validateHost('pocket.example.com:8443'), null)
})

test('host：含空格要拦', () => {
  assert.notEqual(validateHost('pocket example.com'), null)
})

test('host：单段主机名（无点）要拦', () => {
  // `pocket` 这种在公网 DNS 里解析不出来，写进配置只会起不来
  assert.notEqual(validateHost('pocket'), null)
})

test('host：大写和末尾点算合法，由 normalizeHost 收口', () => {
  // 服务端存的是小写；末尾点在 DNS 里与不带点等价。
  // 这两种不该算错，但必须归一化后再拿去自证，否则回读比对永远不相等。
  assert.equal(validateHost('Pocket.Example.COM.'), null)
  assert.equal(normalizeHost('Pocket.Example.COM.'), 'pocket.example.com')
})

test('host：空要拦', () => {
  assert.notEqual(validateHost(''), null)
})

// ---- normalizeHost ----

test('normalizeHost：去空白、转小写、去末尾点', () => {
  assert.equal(normalizeHost('  Pocket.Example.COM.  '), 'pocket.example.com')
})

test('normalizeHost：IPv6 方括号也去（虽然隧道不会用，但别崩）', () => {
  assert.equal(normalizeHost('[::1]'), '::1')
})
