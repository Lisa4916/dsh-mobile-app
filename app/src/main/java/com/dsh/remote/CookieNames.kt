package com.dsh.remote

/**
 * dsh-pocket 一侧的 cookie 名字，以及「删哪一类」的判定。
 *
 * 单独一个对象是因为**删错 cookie 的代价是用户重装 App**：
 *  - `dsh-auth-*` 是上游（dsh web）会话，带着旧端口，坏了清掉即可；
 *  - `dsh_pocket_token` 是用户输 PIN 换来的局域网会话，清掉就会回到「访问验证」页，
 *    而那一页没有密码可填（用户早忘了），等于把人永久锁在外面。
 *
 * `CookieManager` 没有「按前缀删」的 API，只能取出 `name=value; name=value` 自己筛。
 * 筛选逻辑做成纯 JVM 函数，单测就能把「别把 pocket cookie 当上游 cookie 删掉」钉死。
 */
internal object CookieNames {
    /** 上游会话前缀（dsh web 下发 `dsh-auth-<随机串>`）。 */
    const val AUTH_PREFIX = "dsh-auth-"

    /** dsh-pocket 的局域网会话名（`HttpOnly`，值 = `sha256(PIN:sessionKey)`）。 */
    const val POCKET = "dsh_pocket_token"

    /**
     * 从 `CookieManager.getCookie(url)` 的返回串里挑出要被删掉的名字。
     *
     * @param pocket true = 只挑 `dsh_pocket_token`；false = 只挑 `dsh-auth-*`
     */
    fun selectForRemoval(all: String?, pocket: Boolean): List<String> {
        if (all.isNullOrBlank()) return emptyList()
        return all.split(';')
            .map { it.substringBefore('=').trim() }
            .filter { name ->
                if (name.isEmpty()) false
                else if (pocket) name == POCKET
                else name.startsWith(AUTH_PREFIX)
            }
    }

    /** 删除某个 cookie 时写回的过期串（只保留作用域，不带值）。 */
    fun expiryDirective(name: String): String = "$name=; Max-Age=0; Path=/"
}
