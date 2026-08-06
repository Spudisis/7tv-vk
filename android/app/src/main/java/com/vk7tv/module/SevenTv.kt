package com.vk7tv.module

import org.json.JSONArray
import org.json.JSONObject

/**
 * Резолв набора по ссылке, ID или нику стримера — портировано из background.js
 * расширения, чтобы наборы добавлялись одинаково и там, и здесь.
 *
 * Ник резолвится сначала через GQL самого 7TV — его API надёжнее. Запасной
 * путь — Twitch ID через сторонний api.ivr.fi: он бывает медленным или лежит,
 * поэтому не на критическом пути.
 */
object SevenTv {

    /**
     * Определённый ответ «такого нет» — в отличие от «не смогли спросить»
     * (нет сети, 5xx). Разница нужна кэшу предложений: первое кэшируется
     * на диск, второе — нет.
     */
    class NotFound(message: String) : RuntimeException(message)

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

    /** Id эмоута из ссылки на 7TV (страница или cdn); не нашёлся — пустая строка. */
    fun emoteId(url: String): String = ULID.find(url)?.value?.uppercase() ?: ""

    /** Свой эмоут: имя с 7TV и id из ссылки. */
    class EmoteRef(
        val id: String,
        val name: String,
        val url: String,
        val zeroWidth: Boolean = false,
    )

    // У самого эмоута zero-width — это флаг 256, а у эмоута внутри набора тот
    // же смысл несёт флаг 1 (см. Emotes.fetchSet): это разные наборы флагов.
    const val ZERO_WIDTH = 256

    /** Флаг zero-width по id. Только не на UI-потоке: ходит в сеть. */
    fun zeroWidthOf(id: String): Boolean {
        val json = JSONObject(Net.get("https://7tv.io/v3/emotes/$id"))
        return (json.optInt("flags") and ZERO_WIDTH) != 0
    }

    /**
     * Эмоут по ссылке с 7TV или прямой ссылке на картинку. Только не на
     * UI-потоке. У картинки не с 7TV id взять неоткуда — такой эмоут
     * останется только у того, кто его добавил, и имя для него обязательно.
     */
    fun resolveEmote(input: String, wanted: String): EmoteRef {
        val str = input.trim()
        val m = ULID.find(str)
        if (m != null) {
            val id = m.value.uppercase()
            val raw = try {
                Net.get("https://7tv.io/v3/emotes/$id")
            } catch (e: Net.HttpException) {
                throw if (e.code == 404) {
                    NotFound("Эмоута с таким id на 7TV нет — проверь ссылку")
                } else {
                    RuntimeException("7TV сейчас недоступен (код ${e.code}), попробуй позже")
                }
            }
            val json = JSONObject(raw)
            val name = wanted.ifEmpty { json.optString("name").ifEmpty { id } }
            val zw = (json.optInt("flags") and ZERO_WIDTH) != 0
            return EmoteRef(id, name, Shared.url(id), zw)
        }
        if (!str.startsWith("http://") && !str.startsWith("https://")) {
            throw RuntimeException("Вставь ссылку на эмоут с 7tv.app или прямую ссылку на картинку")
        }
        if (wanted.isEmpty()) {
            throw RuntimeException("Придумай имя — по нему эмоут вставляется в сообщение")
        }
        return EmoteRef("", wanted, str)
    }

    fun bySetId(id: String, slugOverride: String?): SetRef {
        val raw = try {
            Net.get("https://7tv.io/v3/emote-sets/$id")
        } catch (e: Net.HttpException) {
            throw if (e.code == 404) {
                NotFound("Набор 7TV с таким ID не найден — проверь ссылку")
            } else {
                RuntimeException("7TV сейчас недоступен (код ${e.code}), попробуй позже")
            }
        }
        val json = JSONObject(raw)
        val owner = json.optJSONObject("owner")
        val slug = slugOverride ?: slugify(owner?.optString("username") ?: "")
        return SetRef(json.optString("id", id), slug, json.optString("name", id))
    }

    private fun byLogin(login: String): SetRef =
        try {
            // 7TV-первым: его собственный API надёжнее стороннего ivr
            viaGql(login)
        } catch (first: Throwable) {
            try {
                viaIvr(login)
            } catch (second: Throwable) {
                // отдаём наружу NotFound от 7TV, если он был: это определённый
                // ответ, а недоступность запасного ivr.fi — нет. По нему
                // Suggest решает, кэшировать ли «набора нет» на диск.
                throw if (first is NotFound) first else second
            }
        }

    private fun viaIvr(login: String): SetRef {
        val arr = JSONArray(Net.get("https://api.ivr.fi/v2/twitch/user?login=$login"))
        if (arr.length() == 0) throw NotFound("Стример «$login» не найден на Twitch")
        val twitchId = arr.getJSONObject(0).optString("id")
        val user = JSONObject(Net.get("https://7tv.io/v3/users/twitch/$twitchId"))
        val es = user.optJSONObject("emote_set")
            ?: throw NotFound("У «$login» нет активного набора 7TV")
        val id = es.optString("id")
        if (id.isEmpty()) throw NotFound("У «$login» нет активного набора 7TV")
        // Имя набора уже пришло в этом же ответе — за ним не надо ходить
        // отдельно. Раньше тут вызывался bySetId, и он выкачивал весь набор
        // (у стримеров это сотни килобайт) только ради названия.
        // Ник, по которому добавляли, — самый понятный постфикс.
        return SetRef(id, login, es.optString("name").ifEmpty { login })
    }

    private fun viaGql(login: String): SetRef {
        val body = JSONObject()
            .put("query", "query(\$q:String!){users(query:\$q){id username}}")
            .put("variables", JSONObject().put("q", login))
            .toString()
        val json = JSONObject(Net.postJson("https://7tv.io/v3/gql", body))
        val users = json.optJSONObject("data")?.optJSONArray("users")
            ?: throw NotFound("Стример «$login» не найден на 7TV")
        var userId: String? = null
        for (i in 0 until users.length()) {
            val u = users.optJSONObject(i) ?: continue
            // регистр не сверяем: у ника на 7TV бывает свой (Bratishkinoff),
            // а мы ищем по lowercase — иначе первичный путь мимо цели
            if (u.optString("username").equals(login, ignoreCase = true)) {
                userId = u.optString("id")
                break
            }
        }
        if (userId.isNullOrEmpty()) throw NotFound("Стример «$login» не найден на 7TV")

        val user = JSONObject(Net.get("https://7tv.io/v3/users/$userId"))
        val conns = user.optJSONArray("connections")
        for (i in 0 until (conns?.length() ?: 0)) {
            val c = conns!!.optJSONObject(i) ?: continue
            val setId = c.optString("emote_set_id")
            if (c.optString("platform") == "TWITCH" && setId.isNotEmpty()) {
                return bySetId(setId, login)
            }
        }
        throw NotFound("У «$login» нет активного набора 7TV")
    }

    fun slugify(s: String): String =
        s.trim().lowercase().replace(Regex("\\s+"), "-").replace(Regex("[^\\p{L}\\p{N}_-]"), "")
}
