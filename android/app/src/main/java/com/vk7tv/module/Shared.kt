package com.vk7tv.module

import java.util.concurrent.Executors

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

    // Zero-width — флаг эмоута на 7TV, в самом слове его нет. Спрашиваем один
    // раз на id; пока ответа нет, эмоут рисуется обычным, с ответом чат
    // перерисовывается и эмоут встаёт поверх предыдущего. Кэш живёт до
    // перезапуска клиента и хранит в том числе неудачу — чат с одним и тем же
    // словом не должен долбить API.
    private val zeroWidth = HashMap<String, Boolean>()
    private val asking = HashSet<String>()

    private val io = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "vk7tv-shared").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    fun url(id: String): String = "https://cdn.7tv.app/emote/$id/2x.webp"

    /** Известный флаг zero-width; неизвестный спрашиваем в фоне. */
    fun isZeroWidth(id: String): Boolean {
        synchronized(zeroWidth) {
            zeroWidth[id]?.let { return it }
            if (!asking.add(id)) return false
        }
        io.execute {
            L.safe("флаг эмоута $id") {
                val zw = try {
                    SevenTv.zeroWidthOf(id)
                } catch (t: Throwable) {
                    false
                }
                synchronized(zeroWidth) {
                    zeroWidth[id] = zw
                    asking.remove(id)
                }
                if (zw) Replacer.rerenderAll()
            }
        }
        return false
    }

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
        return Emote(word, url, isZeroWidth(id))
    }

    /** Находки для пикера: без тех, что уже свои или скрыты крестиком. */
    fun hits(): List<Hit> = synchronized(seen) {
        val mine = Config.custom.values.map { it.id }.filter { it.isNotEmpty() }.toSet()
        val hidden = Config.dismissedEmotes
        seen.values.filter { it.id !in mine && it.id !in hidden }.distinctBy { it.id }
    }

    /** Эмоут добавили себе — предлагать его больше не нужно. */
    fun forget(id: String) {
        synchronized(seen) {
            val dead = seen.filterValues { it.id == id }.keys.toList()
            for (k in dead) seen.remove(k)
        }
    }

    /**
     * Крестик на карточке: эмоут не нужен, больше не предлагаем — и в этот
     * раз, и после перезапуска. Сам он в чате продолжает рисоваться: скрываем
     * предложение добавить, а не картинку.
     */
    fun dismiss(id: String) {
        Config.dismissEmote(id)
        forget(id)
    }

    // Crockford base32: без I, L, O, U — их в id не бывает
    private fun Char.isUlidChar(): Boolean {
        val c = uppercaseChar()
        if (c in '0'..'9') return true
        if (c !in 'A'..'Z') return false
        return c != 'I' && c != 'L' && c != 'O' && c != 'U'
    }
}
