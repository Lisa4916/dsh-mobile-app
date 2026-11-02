package com.dsh.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * cookie 筛选的测试。
 *
 * 这段逻辑只有十来行，但**它是「删哪类 cookie」的唯一判据**：
 *  - 把 `dsh_pocket_token` 当成上游 cookie 删掉 → 用户回到「访问验证」页且没有 PIN 可填；
 *  - 漏删 `dsh-auth-*` → 上游一直 401，自愈等于没做。
 * 两条都不该靠真机试错来发现。
 */
class CookieNamesTest {

    private val pocket = CookieNames.POCKET
    private val upstream = "${CookieNames.AUTH_PREFIX}EsoXtJryKJQ28wPg"

    @Test
    fun selectForRemoval_pocketPicksOnlyThePocketCookie() {
        val all = "dsh_pocket_token=abc123; $upstream=v1.eyJ2ZXJzaW9uIjox"
        assertEquals(listOf(pocket), CookieNames.selectForRemoval(all, pocket = true))
    }

    @Test
    fun selectForRemoval_upstreamPicksOnlyAuthPrefixed() {
        val all = "dsh_pocket_token=abc123; $upstream=v1.eyJ2ZXJzaW9uIjox"
        assertEquals(listOf(upstream), CookieNames.selectForRemoval(all, pocket = false))
    }

    @Test
    fun selectForRemoval_keepsEveryAuthCookieWhenSeveralExist() {
        // DSH 重启改端口后可能同时留着新旧两枚
        val all = "dsh-auth-old=1; dsh-auth-new=2"
        assertEquals(
            listOf("dsh-auth-old", "dsh-auth-new"),
            CookieNames.selectForRemoval(all, pocket = false),
        )
    }

    @Test
    fun selectForRemoval_ignoresUnrelatedCookies() {
        val all = "theme=dark; session=x; dsh_pocket_token=v; dsh-auth-abc=y"
        assertEquals(listOf(pocket), CookieNames.selectForRemoval(all, pocket = true))
        assertEquals(listOf("dsh-auth-abc"), CookieNames.selectForRemoval(all, pocket = false))
    }

    @Test
    fun selectForRemoval_prefixMatchIsExact() {
        // 只有真正以前缀开头的才算；`xdsh-auth-` / `dsh_auth-` 都不是
        val all = "xdsh-auth-a=1; dsh_auth-b=2; dsh-auth-c=3"
        assertEquals(listOf("dsh-auth-c"), CookieNames.selectForRemoval(all, pocket = false))
    }

    @Test
    fun selectForRemoval_pocketMatchIsExactNotPrefix() {
        // `dsh_pocket_token_old` 不是那个 cookie，删错了会把真正要清的留下
        val all = "dsh_pocket_token_old=1; dsh_pocket_token=2"
        assertEquals(listOf(pocket), CookieNames.selectForRemoval(all, pocket = true))
    }

    @Test
    fun selectForRemoval_handlesEmptyAndBlankInput() {
        assertTrue(CookieNames.selectForRemoval(null, pocket = true).isEmpty())
        assertTrue(CookieNames.selectForRemoval(null, pocket = false).isEmpty())
        assertTrue(CookieNames.selectForRemoval("", pocket = true).isEmpty())
        assertTrue(CookieNames.selectForRemoval("   ", pocket = false).isEmpty())
    }

    @Test
    fun selectForRemoval_toleratesJunkSegments() {
        // CookieManager 的返回串末尾可能带多余分号、空段
        val all = "dsh_pocket_token=v;;  ; $upstream=x;"
        assertEquals(listOf(pocket), CookieNames.selectForRemoval(all, pocket = true))
        assertEquals(listOf(upstream), CookieNames.selectForRemoval(all, pocket = false))
    }

    @Test
    fun selectForRemoval_doesNotConfuseValueForName() {
        // 值里出现另一类 cookie 的名字也不能被选中
        val all = "dsh_pocket_token=contains${CookieNames.AUTH_PREFIX}inside"
        assertEquals(listOf(pocket), CookieNames.selectForRemoval(all, pocket = true))
        assertTrue(
            "值里出现 dsh-auth- 不代表有上游 cookie",
            CookieNames.selectForRemoval(all, pocket = false).isEmpty(),
        )
    }

    @Test
    fun expiryDirective_expiresOnlyThatName() {
        // 只置空 + 过期，不能带 Path 以外的属性 —— 带错作用域会删不掉
        assertEquals("dsh-auth-x=; Max-Age=0; Path=/", CookieNames.expiryDirective("dsh-auth-x"))
        assertEquals("dsh_pocket_token=; Max-Age=0; Path=/", CookieNames.expiryDirective(pocket))
    }
}
