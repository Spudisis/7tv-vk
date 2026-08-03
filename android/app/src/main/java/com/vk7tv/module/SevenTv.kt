package com.vk7tv.module

import org.json.JSONArray
import org.json.JSONObject

/**
 * Резолв набора по ссылке, ID или нику стримера — портировано из background.js
 * расширения, чтобы наборы добавлялись одинаково и там, и здесь.
 *
 * Ник резолвится в Twitch ID через открытый api.ivr.fi, запасной путь —
 * поиск в GQL самого 7TV.
 */
object SevenTv {

    // ID набора на 7TV — ULID: 26 символов Crockford base32
    private val ULID = Regex("[0-9A-HJKMNP-TV-Z]{26}", RegexOption.IGNORE_CASE)
    private val LOGIN = Regex("^[a-zA-Z0-9_]{1,25}$")

    /** Только не на UI-потоке: ходит в сеть. Бросает исключение с текстом для показа. */
    fun resolve(input: String): SetRef {
        val str = input.trim()
        val m = ULID.find(str)
        if (m != null) return bySetId(m.value.uppercase(), null)
        if (LOGIN.matches(str)) return byLogin(str.lowercase())
        throw RuntimeException("Вставь ссылку на набор с 7tv.app или ник стримера на Twitch")
    }

    fun bySetId(id: String, slugOverride: String?): SetRef {
        val json = JSONObject(Net.get("https://7tv.io/v3/emote-sets/$id"))
        val owner = json.optJSONObject("owner")
        val slug = slugOverride ?: slugify(owner?.optString("username") ?: "")
        return SetRef(json.optString("id", id), slug, json.optString("name", id))
    }

    private fun byLogin(login: String): SetRef =
        try {
            viaIvr(login)
        } catch (t: Throwable) {
            viaGql(login)
        }

    private fun viaIvr(login: String): SetRef {
        val arr = JSONArray(Net.get("https://api.ivr.fi/v2/twitch/user?login=$login"))
        if (arr.length() == 0) throw RuntimeException("Стример «$login» не найден на Twitch")
        val twitchId = arr.getJSONObject(0).optString("id")
        val user = JSONObject(Net.get("https://7tv.io/v3/users/twitch/$twitchId"))
        val es = user.optJSONObject("emote_set")
            ?: throw RuntimeException("У «$login» нет активного набора 7TV")
        val id = es.optString("id")
        if (id.isEmpty()) throw RuntimeException("У «$login» нет активного набора 7TV")
        // ник, по которому добавляли, — самый понятный постфикс
        return bySetId(id, login)
    }

    private fun viaGql(login: String): SetRef {
        val body = JSONObject()
            .put("query", "query(\$q:String!){users(query:\$q){id username}}")
            .put("variables", JSONObject().put("q", login))
            .toString()
        val json = JSONObject(Net.postJson("https://7tv.io/v3/gql", body))
        val users = json.optJSONObject("data")?.optJSONArray("users")
            ?: throw RuntimeException("Стример «$login» не найден на 7TV")
        var userId: String? = null
        for (i in 0 until users.length()) {
            val u = users.optJSONObject(i) ?: continue
            if (u.optString("username") == login) {
                userId = u.optString("id")
                break
            }
        }
        if (userId.isNullOrEmpty()) throw RuntimeException("Стример «$login» не найден на 7TV")

        val user = JSONObject(Net.get("https://7tv.io/v3/users/$userId"))
        val conns = user.optJSONArray("connections")
        for (i in 0 until (conns?.length() ?: 0)) {
            val c = conns!!.optJSONObject(i) ?: continue
            val setId = c.optString("emote_set_id")
            if (c.optString("platform") == "TWITCH" && setId.isNotEmpty()) {
                return bySetId(setId, login)
            }
        }
        throw RuntimeException("У «$login» нет активного набора 7TV")
    }

    fun slugify(s: String): String =
        s.trim().lowercase().replace(Regex("\\s+"), "-").replace(Regex("[^\\p{L}\\p{N}_-]"), "")
}
