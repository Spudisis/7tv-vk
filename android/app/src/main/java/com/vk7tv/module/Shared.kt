package com.vk7tv.module

/**
 * Чужой свой эмоут: слово вида `имя_01H4RX…`, где после последнего «_» стоит
 * id эмоута на 7TV.
 *
 * Из id адрес картинки собирается однозначно, поэтому такое слово рисуется
 * сразу — без подключённых наборов, без запросов к API и без общего сервера.
 * Этим оно и отличается от [Suggest], которому нужно спросить 7TV, есть ли
 * у стримера такой эмоут.
 *
 * Правила те же, что в расширении (content.js): иначе один и тот же код
 * у человека с телефона и у человека с десктопа рисовался бы по-разному.
 */
object Shared {

    /** Что видели в чате и чего нет в своих — пикер предлагает это добавить. */
    class Hit(val name: String, val id: String, val url: String)

    // Потолок на сессию: чат из тысячи незнакомых кодов не должен растить
    // список бесконечно. Считаем разобранные слова, а не показанные карточки.
    private const val MAX_WORDS = 200

    // 26 символов Crockford base32 — столько в id эмоута на 7TV
    private const val ID_LEN = 26

    private val seen = LinkedHashMap<String, Hit>() // полное слово -> находка

    fun url(id: String): String = "https://cdn.7tv.app/emote/$id/2x.webp"

    /**
     * Похоже ли слово на `имя_<id>`. Проверяем по месту, без создания строки:
     * через scan проходит весь текст чата.
     */
    fun looksLike(text: CharSequence, start: Int, end: Int): Boolean {
        // имя минимум в один символ плюс «_» плюс сам id
        if (end - start < ID_LEN + 2) return false
        val idAt = end - ID_LEN
        if (text[idAt - 1] != '_') return false
        for (i in idAt until end) if (!text[i].isUlidChar()) return false
        return true
    }

    /**
     * Эмоут для слова, прошедшего [looksLike], и отметка «такое видели».
     * Сюда попадают только чужие эмоуты: свой нашёлся бы раньше в [Emotes]
     * по этому же полному имени.
     */
    fun consider(word: String): Emote {
        val idAt = word.length - ID_LEN
        val name = word.substring(0, idAt - 1)
        val id = word.substring(idAt).uppercase()
        val url = url(id)
        synchronized(seen) {
            if (!seen.containsKey(word) && seen.size < MAX_WORDS) {
                if (Config.custom.none { it.value.id.equals(id, ignoreCase = true) }) {
                    seen[word] = Hit(name, id, url)
                }
            }
        }
        return Emote(word, url, false)
    }

    /** Находки для пикера: без тех, что успели добавить в свои. */
    fun hits(): List<Hit> = synchronized(seen) {
        val mine = Config.custom.values.map { it.id }.filter { it.isNotEmpty() }.toSet()
        seen.values.filter { it.id !in mine }.distinctBy { it.id }
    }

    /** Эмоут добавили себе — предлагать его больше не нужно. */
    fun forget(id: String) {
        synchronized(seen) {
            val dead = seen.filterValues { it.id == id }.keys.toList()
            for (k in dead) seen.remove(k)
        }
    }

    // Crockford base32: без I, L, O, U — их в id не бывает
    private fun Char.isUlidChar(): Boolean {
        val c = uppercaseChar()
        if (c in '0'..'9') return true
        if (c !in 'A'..'Z') return false
        return c != 'I' && c != 'L' && c != 'O' && c != 'U'
    }
}
