package com.vk7tv.module

import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Что модуль уже выяснил про чужие наборы — на диске.
 *
 * Раньше это жило только в памяти: при каждом запуске клиента модуль заново
 * спрашивал у 7tv.io, что за набор `_nicosl` и есть ли в нём `non`, — два-три
 * запроса на каждое незнакомое слово. Одно и то же сообщение каждый раз
 * сначала показывалось текстом, а без VPN картинка не появлялась вовсе.
 * Теперь ответы лежат рядом с наборами и переживают перезапуск: в сеть за ними
 * не ходим.
 *
 * У чужих наборов низкий приоритет в кэше: их json ([trimSets]) и картинки
 * (порядок вытеснения в EmoteCache) удаляются раньше своих. Набор не подключён,
 * нужен разово для превью, и качается заново дешевле, чем свой.
 */
object SuggestCache {

    private const val FILE = "suggest.json"
    private const val TMP = ".tmp"

    // Потолки на записи в файле: чат нагоняет сколько угодно слов, а файл
    // читается при старте — держим его маленьким. Лишнее вытесняем по давности.
    private const val MAX_SETS = 200
    private const val MAX_WORDS = 300

    // Сколько чужих наборов держать скачанными в sets/. Каждый — сотни
    // килобайт json, а нужен он ради превью пары слов.
    private const val MAX_SET_FILES = 20

    // «Такого набора нет» помним неделю: стример мог завести его после того,
    // как мы спросили. «Есть» не протухает — содержимое наборов и так
    // обновляется только по кнопке «Обновить наборы».
    private const val MISS_TTL_MS = 7L * 24 * 3600 * 1000

    /** Ответ про ник: [ref] = null — «такого набора нет», это тоже знание. */
    class SetEntry(val ref: SetRef?, val ts: Long)

    private class WordEntry(val slug: String, val hit: Suggest.Hit, val ts: Long)

    private val lock = Any()
    private val sets = HashMap<String, SetEntry>()
    private val words = HashMap<String, WordEntry>()

    @Volatile
    private var dir: File? = null

    @Volatile
    private var loaded = false

    // Запись откладываем: за один заход в чат находок может быть десяток, а
    // файл целиком переписывается — незачем делать это десять раз подряд.
    private val saver = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "vk7tv-suggest-save").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }
    private val saveScheduled = AtomicBoolean(false)

    fun init(cacheDir: File) {
        dir = cacheDir
    }

    /** Разово поднять кэш с диска. Дисковый ввод-вывод — только не на UI-потоке. */
    fun warm() {
        if (loaded) return
        val d = dir ?: return
        synchronized(lock) {
            if (loaded) return
            loaded = true // и при битом файле: перечитывать его смысла нет
            val f = File(d, FILE)
            if (!f.isFile) return
            L.safe("чтение кэша предложений") { read(JSONObject(f.readText())) }
        }
    }

    /** Что знаем про ник, или null, если не спрашивали (или ответ протух). */
    fun set(slug: String): SetEntry? = synchronized(lock) { sets[slug] }

    /** Запоминаем ответ про ник. [ref] = null — «набора нет». */
    fun putSet(slug: String, ref: SetRef?) {
        synchronized(lock) { sets[slug] = SetEntry(ref, System.currentTimeMillis()) }
        saveSoon()
    }

    /**
     * Находка по слову с прошлого раза: ни сети, ни разбора набора.
     * Заодно освежает время записи — активные слова вытесняются последними.
     */
    fun word(word: String): Suggest.Hit? = synchronized(lock) {
        val e = words[word] ?: return null
        words[word] = WordEntry(e.slug, e.hit, System.currentTimeMillis())
        e.hit
    }

    fun putWord(slug: String, hit: Suggest.Hit) {
        synchronized(lock) { words[hit.word] = WordEntry(slug, hit, System.currentTimeMillis()) }
        saveSoon()
    }

    /** Набор подключили или скрыли — знание про него больше не нужно. */
    fun forget(slug: String) {
        synchronized(lock) {
            sets.remove(slug)
            val dead = words.filterValues { it.slug == slug }.keys.toList()
            for (k in dead) words.remove(k)
        }
        saveSoon()
    }

    /** Освежить время файла набора: [trimSets] удаляет по давности обращения. */
    fun touch(id: String) {
        val d = dir ?: return
        L.safe("освежить набор $id") {
            File(d, "sets/$id.json").setLastModified(System.currentTimeMillis())
        }
    }

    /**
     * Держим не больше [MAX_SET_FILES] чужих наборов в sets/, лишние удаляем
     * по давности обращения. Свои (подключённые и глобальный) не трогаем:
     * они читаются при каждом запуске, без них пикер пустой.
     */
    fun trimSets() {
        val d = dir ?: return
        L.safe("подрезка чужих наборов") {
            val own = ownFiles()
            val files = (File(d, "sets").listFiles() ?: return@safe).filter { it.name !in own }
            if (files.size <= MAX_SET_FILES) return@safe
            val old = files.sortedBy { it.lastModified() }.take(files.size - MAX_SET_FILES)
            var n = 0
            for (f in old) if (f.delete()) n++
            L.v("чужих наборов удалено: $n")
        }
    }

    /**
     * Забыть всё про чужие наборы: и разобранные ответы, и скачанные json.
     * Возвращает, сколько байт освободили. Свои наборы не трогает.
     */
    fun clear(): Long {
        synchronized(lock) {
            sets.clear()
            words.clear()
            loaded = true
        }
        val d = dir ?: return 0L
        var freed = 0L
        L.safe("очистка кэша предложений") {
            for (f in listOf(File(d, FILE), File(d, FILE + TMP))) {
                val len = f.length()
                if (f.delete()) freed += len
            }
            val own = ownFiles()
            File(d, "sets").listFiles()?.forEach { f ->
                if (f.name in own) return@forEach
                val len = f.length()
                if (f.delete()) freed += len
            }
        }
        return freed
    }

    /** Имена json'ов своих наборов — их не вытесняем никогда. */
    private fun ownFiles(): Set<String> {
        val out = HashSet<String>()
        out.add("global.json")
        for (s in Config.sets) out.add("${s.id}.json")
        return out
    }

    private fun read(json: JSONObject) {
        val now = System.currentTimeMillis()
        json.optJSONObject("sets")?.let { js ->
            for (slug in js.keys()) {
                val o = js.optJSONObject(slug) ?: continue
                val ts = o.optLong("ts")
                val id = o.optString("id")
                if (id.isEmpty()) {
                    if (now - ts < MISS_TTL_MS) sets[slug] = SetEntry(null, ts)
                } else {
                    val ref = SetRef(id, o.optString("slug", slug), o.optString("name", slug))
                    sets[slug] = SetEntry(ref, ts)
                }
            }
        }
        json.optJSONObject("words")?.let { jw ->
            for (word in jw.keys()) {
                val o = jw.optJSONObject(word) ?: continue
                val slug = o.optString("slug")
                // набор протух или не сохранился — слово без него бессмысленно
                val ref = sets[slug]?.ref ?: continue
                val name = o.optString("name")
                val url = o.optString("url")
                if (name.isEmpty() || url.isEmpty()) continue
                val hit = Suggest.Hit(word, name, ref, o.optInt("n"), url)
                words[word] = WordEntry(slug, hit, o.optLong("ts"))
            }
        }
        L.i("кэш предложений: ников ${sets.size}, слов ${words.size}")
    }

    private fun saveSoon() {
        if (!saveScheduled.compareAndSet(false, true)) return
        L.safe("очередь записи кэша предложений") {
            saver.schedule({
                saveScheduled.set(false) // изменения во время записи попадут в следующую
                L.safe("запись кэша предложений") { save() }
            }, 3, TimeUnit.SECONDS)
        }
    }

    private fun save() {
        val d = dir ?: return
        val text = synchronized(lock) {
            dropOld()
            val js = JSONObject()
            for ((slug, e) in sets) {
                val o = JSONObject().put("ts", e.ts)
                e.ref?.let { o.put("id", it.id).put("slug", it.slug).put("name", it.name) }
                js.put(slug, o)
            }
            val jw = JSONObject()
            for ((word, e) in words) {
                jw.put(
                    word,
                    JSONObject()
                        .put("ts", e.ts)
                        .put("slug", e.slug)
                        .put("name", e.hit.name)
                        .put("url", e.hit.url)
                        .put("n", e.hit.count),
                )
            }
            JSONObject().put("v", 1).put("sets", js).put("words", jw).toString()
        }
        // через .tmp + rename: оборванная запись не оставит огрызок json,
        // на котором кэш потом не поднимется вовсе
        val tmp = File(d, FILE + TMP)
        tmp.writeText(text)
        if (!tmp.renameTo(File(d, FILE))) tmp.delete()
    }

    /** Держим файл в рамках: лишнее — по давности обращения. */
    private fun dropOld() {
        if (sets.size > MAX_SETS) {
            val dead = sets.entries.sortedBy { it.value.ts }.take(sets.size - MAX_SETS).map { it.key }
            for (k in dead) sets.remove(k)
        }
        if (words.size > MAX_WORDS) {
            val dead = words.entries.sortedBy { it.value.ts }.take(words.size - MAX_WORDS).map { it.key }
            for (k in dead) words.remove(k)
        }
        // слово без набора не нарисовать — выкидываем вслед за ним
        val orphans = words.filterValues { !sets.containsKey(it.slug) }.keys.toList()
        for (k in orphans) words.remove(k)
    }
}
