package com.vk7tv.module

import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * [insertName] — что уходит в поле ввода. Отличается от [name] только у своих
 * эмоутов с id: показываем короткое имя, а вставляем полное, иначе у
 * собеседника вместо картинки останется текст.
 */
class Emote(
    val name: String,
    val url: String,
    val zeroWidth: Boolean,
    val insertName: String = name,
)

/**
 * Вкладка пикера. [setId] есть только у подключённых наборов — по нему вкладку
 * можно вернуть к её SetRef; у глобального набора и «своих эмоутов» его нет,
 * и переставлять их нельзя.
 */
class Group(val title: String, val emotes: List<Emote>, val setId: String? = null)

/**
 * Реестр «имя эмоута -> картинка». Собирается ровно по тем же правилам,
 * что и в расширении (content.js), иначе ты с телефона и друг с десктопа
 * увидели бы разные картинки под одним словом:
 *
 *  - глобальный набор и «свои» эмоуты получают голое имя всегда;
 *  - у эмоута из набора всегда есть имя с постфиксом (ok_bratishkinoff);
 *  - голое имя достаётся набору, только если такой код есть ровно
 *    в одном подключённом наборе.
 */
object Emotes {

    private const val API = "https://7tv.io/v3/emote-sets/"

    private val map = HashMap<String, Emote>()

    // постфиксное имя набора -> голое имя эмоута (ok_bratishkinoff -> ok).
    // По нему автоподсказки прячут дубль с постфиксом, пока у кода есть
    // голое имя и человек ещё не начал набирать «_» — как в вебе.
    private val aliasOf = HashMap<String, String>()

    // дешёвый префильтр: до подстроки и хеш-лукапа отсекаем слова,
    // которые эмоутом быть не могут. setText зовётся часто, экономим.
    private var minLen = Int.MAX_VALUE
    private var maxLen = 0
    private val firstAscii = BooleanArray(128)
    private var firstNonAscii = false

    @Volatile
    var ready = false
        private set

    @Volatile
    var groups: List<Group> = emptyList()
        private set

    fun get(name: String): Emote? = map[name]

    fun size(): Int = map.size

    /** Все URL картинок текущих наборов — для предзагрузки в офлайн-кэш. */
    fun allUrls(): List<String> = synchronized(map) { map.values.map { it.url }.distinct() }

    /**
     * Эмоуты, чьё имя начинается с [word], — для автоподсказок при вводе.
     * Правила те же, что в вебе (autocomplete.js): постфиксные имена
     * (ok_bratishkinoff) не засоряют список, пока у кода есть голое имя и
     * человек не начал набирать «_». Порядок: точное совпадение регистра выше,
     * потом короче, потом по алфавиту. Возвращает не больше [limit].
     */
    fun matchPrefix(word: String, limit: Int): List<Emote> {
        if (word.isEmpty()) return emptyList()
        val hasUnderscore = word.contains('_')
        val out = ArrayList<Emote>()
        synchronized(map) {
            for ((name, e) in map) {
                if (name.length < word.length) continue
                if (!name.regionMatches(0, word, 0, word.length, ignoreCase = true)) continue
                if (!hasUnderscore) {
                    val bare = aliasOf[name]
                    if (bare != null && map.containsKey(bare)) continue
                }
                out.add(e)
            }
        }
        out.sortWith(
            compareBy(
                { if (it.name.startsWith(word)) 0 else 1 },
                { it.name.length },
                { it.name },
            ),
        )
        return if (out.size > limit) ArrayList(out.subList(0, limit)) else out
    }

    /** Может ли этот кусок текста вообще быть именем эмоута. */
    fun mayBe(text: CharSequence, start: Int, end: Int): Boolean {
        val len = end - start
        if (len < minLen || len > maxLen) return false
        val c = text[start]
        return if (c.code < 128) firstAscii[c.code] else firstNonAscii
    }

    /**
     * Тянет наборы. Только не на UI-потоке.
     *
     * По умолчанию берёт всё, что уже лежит на диске, и ходит в сеть только
     * за тем, чего нет: наборы меняются редко, а проверка каждого при запуске
     * приложения — это запрос к API на набор. Полное обновление — по кнопке
     * «Обновить наборы» в настройках.
     */
    fun load(cacheDir: File, force: Boolean = false) {
        val fresh = LinkedHashMap<String, Emote>()
        val freshAlias = HashMap<String, String>()
        val builtGroups = ArrayList<Group>()

        // Сеть — самое долгое место загрузки. Тянем все наборы разом, а не по
        // очереди: раньше цикл ждал каждый fetchSet последовательно, и при
        // десятке наборов пикер открывался только после последнего.
        val ids = ArrayList<String>()
        if (Config.useGlobal) ids.add("global")
        for (ref in Config.sets) ids.add(ref.id)
        val fetched = fetchAll(cacheDir, ids, force)

        if (Config.useGlobal) {
            val g = fetched["global"]
            if (g != null) {
                for (e in g.emotes) fresh[e.name] = e
                builtGroups.add(Group("Глобальные 7TV", g.emotes))
            }
        }

        // Голое имя (без постфикса) собираем по всем наборам. При коллизии —
        // код есть в нескольких наборах — оно достаётся набору, который выше
        // в списке: «67» покажет «67» из него, а конкретный «67_stream»
        // доступен явно. Раньше решал первый по алфавиту слаг, но тогда
        // перестановка наборов ни на что не влияла и выбрать картинку было
        // нельзя. Глобальный и «свои» голое имя держат за собой — их
        // не перебиваем.
        val bareCandidates = HashMap<String, MutableList<Pair<String, Emote>>>()

        for (ref in Config.sets) {
            val s = fetched[ref.id] ?: continue
            val slug = ref.slug.ifEmpty { s.slug }
            val forPicker = ArrayList<Emote>(s.emotes.size)
            for (e in s.emotes) {
                if (slug.isNotEmpty()) {
                    val full = "${e.name}_$slug"
                    fresh[full] = Emote(full, e.url, e.zeroWidth)
                    freshAlias[full] = e.name
                    forPicker.add(Emote(full, e.url, e.zeroWidth))
                } else {
                    forPicker.add(e)
                }
                bareCandidates.getOrPut(e.name) { ArrayList() }.add(slug to e)
            }
            builtGroups.add(Group(ref.name.ifEmpty { s.name }, forPicker, ref.id))
        }

        for ((name, list) in bareCandidates) {
            if (fresh.containsKey(name)) continue // занято глобальным или своими
            // кандидаты складывались в порядке Config.sets — берём первый
            fresh[name] = (list.firstOrNull() ?: continue).second
        }

        // У своего эмоута, добавленного ссылкой с 7TV, есть второе имя с id
        // эмоута — по нему его узнаёт чужой клиент, у которого этого эмоута
        // нет. В пикер кладём именно его: вставленное слово должно доехать
        // до собеседника, а голое имя работает только у тех, у кого эмоут
        // уже есть под таким же именем.
        if (Config.custom.isNotEmpty()) {
            val own = ArrayList<Emote>()
            for ((name, c) in Config.custom) {
                val full = c.fullName(name)
                // по голому имени эмоут рисуется, но в поле уходит полное:
                // короткое работает только у тех, у кого этот эмоут уже есть
                fresh[name] = Emote(name, c.url, c.zeroWidth, full)
                if (full != name) {
                    fresh[full] = Emote(full, c.url, c.zeroWidth)
                    freshAlias[full] = name
                }
                own.add(Emote(full, c.url, c.zeroWidth))
            }
            // Первой вкладкой: свои эмоуты не перетаскиваются (у них нет
            // setId), а лезть за ними в конец ряда вкладок неудобно.
            // В сам реестр они попали последними и перебивают наборы —
            // это остаётся как было.
            builtGroups.add(0, Group("Свои эмоуты", own))
        }

        synchronized(map) {
            map.clear()
            map.putAll(fresh)
            aliasOf.clear()
            aliasOf.putAll(freshAlias)
            minLen = Int.MAX_VALUE
            maxLen = 0
            java.util.Arrays.fill(firstAscii, false)
            firstNonAscii = false
            for (name in map.keys) {
                if (name.isEmpty()) continue
                if (name.length < minLen) minLen = name.length
                if (name.length > maxLen) maxLen = name.length
                val c = name[0]
                if (c.code < 128) firstAscii[c.code] = true else firstNonAscii = true
            }
            if (map.isEmpty()) minLen = Int.MAX_VALUE
        }
        groups = builtGroups
        ready = map.isNotEmpty()
        L.i("наборы загружены: эмоутов ${map.size}, групп ${builtGroups.size}")
    }

    /**
     * Переставить вкладки наборов под новый порядок id.
     *
     * Вкладки двигаются сразу, чтобы перетаскивание не ждало ничего. Само
     * «имя -> картинка» от порядка теперь зависит (голое имя достаётся набору
     * выше по списку, см. bareCandidates), поэтому вызывающий следом просит
     * перезагрузку — она идёт из дискового кэша, без сети.
     *
     * Глобальный набор и «свои эмоуты» остаются на своих местах: у них нет
     * setId, и переставлять их нельзя. Наборы, которых нет в [ids] (только что
     * подключили), сортировка оставит в хвосте — она устойчивая.
     */
    fun reorderGroups(ids: List<String>) {
        val cur = groups
        val slots = cur.indices.filter { cur[it].setId != null }
        if (slots.size < 2) return
        val rank = HashMap<String, Int>()
        ids.forEachIndexed { i, id -> rank[id] = i }
        val ordered = slots.map { cur[it] }.sortedBy { rank[it.setId] ?: Int.MAX_VALUE }
        val out = ArrayList(cur)
        slots.forEachIndexed { n, i -> out[i] = ordered[n] }
        groups = out
    }

    /** Эмоуты набора по имени — для проверки предложений. Кэш общий с загрузкой. */
    fun emotesOf(cacheDir: File, id: String): Map<String, Emote>? =
        fetchSet(cacheDir, id)?.emotes?.associateBy { it.name }

    private class Fetched(val name: String, val slug: String, val emotes: List<Emote>)

    /**
     * Тянет несколько наборов параллельно и возвращает id -> набор.
     * Каждый набор пишет свой файл в кэше, общего состояния нет, так что
     * гонок нет; при пустом кэше выигрыш — во столько раз, сколько наборов.
     */
    private fun fetchAll(cacheDir: File, ids: List<String>, force: Boolean): Map<String, Fetched> {
        val distinct = ids.distinct()
        if (distinct.size <= 1) {
            val out = HashMap<String, Fetched>()
            distinct.firstOrNull()?.let { id -> fetchSet(cacheDir, id, force)?.let { out[id] = it } }
            return out
        }
        val out = ConcurrentHashMap<String, Fetched>()
        val pool = Executors.newFixedThreadPool(minOf(distinct.size, 6)) { r ->
            Thread(r, "vk7tv-set").apply { isDaemon = true }
        }
        try {
            distinct.map { id ->
                pool.submit { fetchSet(cacheDir, id, force)?.let { out[id] = it } }
            }.forEach { f -> L.safe("ожидание набора") { f.get() } }
        } finally {
            pool.shutdown()
        }
        return out
    }

    private fun fetchSet(cacheDir: File, id: String, force: Boolean = false): Fetched? {
        val file = File(cacheDir, "sets/$id.json")

        if (force || !file.isFile) {
            L.safe("загрузка набора $id") {
                val body = Net.get(API + id)
                file.parentFile?.mkdirs()
                file.writeText(body)
            }
        }
        if (!file.isFile) return null

        return L.safe("разбор набора $id") {
            val json = JSONObject(file.readText())
            val arr = json.optJSONArray("emotes")
            val list = ArrayList<Emote>(arr?.length() ?: 0)
            for (i in 0 until (arr?.length() ?: 0)) {
                val e = arr!!.optJSONObject(i) ?: continue
                val name = e.optString("name")
                val eid = e.optString("id")
                if (name.isEmpty() || eid.isEmpty()) continue
                // флаг 1 у эмоута в 7TV — ZERO_WIDTH: не занимает своё место,
                // а накладывается поверх предыдущего
                val zw = (e.optInt("flags") and 1) != 0
                list.add(Emote(name, "https://cdn.7tv.app/emote/$eid/2x.webp", zw))
            }
            val owner = json.optJSONObject("owner")
            Fetched(json.optString("name", id), SevenTv.slugify(owner?.optString("username") ?: ""), list)
        }
    }

}
