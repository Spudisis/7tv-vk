package com.vk7tv.module

import java.io.File
import java.util.concurrent.Executors

/**
 * «У собеседника есть эмоут, которого нет у тебя».
 *
 * В чат прилетело `non_nicosl`, такого эмоута у нас нет — похоже, у него
 * подключён набор `nicosl`. Прежде чем предлагать, проверяем по API, что
 * стример существует и эмоут с таким именем правда лежит в его наборе:
 * иначе модуль предлагал бы наборы на каждое слово с подчёркиванием.
 *
 * Где проходит граница «эмоут | стример», заранее не понять: в `ok_bratishkinoff`
 * подчёркивание одно, а в `SEXALARM_kanba_mx` ник сам с подчёркиванием —
 * стример тут `kanba_mx`. Поэтому разделители перебираются слева направо
 * и берётся первый вариант, который сходится.
 *
 * Кэш хранит и отрицательный ответ: чат может сыпать одним словом сколько
 * угодно, в сеть ходим один раз. Ответы переживают перезапуск клиента —
 * их держит [SuggestCache], иначе одно и то же сообщение при каждом запуске
 * снова проверялось бы по сети.
 */
object Suggest {

    class Hit(
        val word: String,
        val name: String,
        val ref: SetRef,
        val count: Int,
        val url: String,
    )

    private const val MAX_SPLITS = 3

    // потолок запросов к API на сессию: чат с тысячей незнакомых слов не должен
    // превращаться в тысячу обращений. Считаем только походы в сеть: ответ из
    // кэша на диске лимит не тратит, иначе после перезапуска уже проверенные
    // слова съедали бы его целиком.
    private const val MAX_PROBES = 40

    // Сколько слов держим в памяти за сессию. До кэша на диске границу задавал
    // MAX_PROBES, теперь он только про сеть, а на разбор нужен свой потолок.
    private const val MAX_WORDS = 500

    // три потока: в чате обычно несколько незнакомых слов, и в одну очередь
    // они складывались в заметное ожидание
    private val io = Executors.newFixedThreadPool(3) { r ->
        Thread(r, "vk7tv-suggest").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    private val cache = HashMap<String, Hit?>() // слово -> находка или null
    private val inFlight = HashSet<String>()
    private val probedSets = HashMap<String, SetRef?>() // ник -> набор или null
    private var probes = 0

    @Volatile
    private var dir: File? = null

    fun init(cacheDir: File) {
        dir = cacheDir
        SuggestCache.init(cacheDir)
        // читаем кэш в фоне: старт клиента и так тяжёлый, а нужен он только
        // к первому незнакомому слову в чате
        io.execute { L.safe("подъём кэша предложений") { SuggestCache.warm() } }
    }

    /** Найденные предложения, по одному на набор; скрытые не показываем. */
    fun hits(): List<Hit> = synchronized(cache) {
        val hidden = Config.dismissedSuggests
        cache.values.filterNotNull()
            .filter { it.ref.slug.lowercase() !in hidden }
            .distinctBy { it.ref.slug }
    }

    /**
     * Находка по слову или null, если про слово ещё не спрашивали, набор
     * не нашёлся или его скрыли. Скрытые отсекаем и здесь: раньше проверка
     * жила только в [hits], и скрытый набор переставал предлагаться в пикере,
     * но слово в сообщении оставалось подсвеченным.
     */
    fun hitOf(word: String): Hit? = synchronized(cache) {
        cache[word]?.takeIf { it.ref.slug.lowercase() !in Config.dismissedSuggests }
    }

    /** Набор подключили — предложения по нему больше не нужны. */
    fun forget(slug: String) {
        synchronized(cache) {
            val dead = cache.filterValues { it?.ref?.slug == slug }.keys.toList()
            for (k in dead) cache.remove(k)
        }
        synchronized(probedSets) { probedSets.remove(slug) }
        SuggestCache.forget(slug)
    }

    /**
     * Забыть всё про чужие наборы — и в памяти, и на диске (кнопка очистки
     * кэша в настройках). Возвращает, сколько байт освободили.
     */
    fun clearCache(): Long {
        synchronized(cache) { cache.clear() }
        synchronized(probedSets) { probedSets.clear() }
        return SuggestCache.clear()
    }

    /**
     * Пользователь скрыл набор из предложений: запоминаем навсегда (переживёт
     * перезапуск), чистим кэш и перерисовываем чат, чтобы подсветка слова ушла.
     */
    fun dismiss(slug: String) {
        Config.dismissSuggest(slug.lowercase())
        forget(slug)
        Replacer.rerenderAll()
    }

    /**
     * Похоже ли слово на эмоут из чужого набора. Проверяем по месту,
     * без создания строки: через scan проходит вообще весь текст чата.
     */
    fun looksLike(text: CharSequence, start: Int, end: Int): Boolean {
        val len = end - start
        if (len < 5 || len > 60) return false
        // Имя эмоута может начинаться с пунктуации и содержать её; конкретную
        // границу «эмоут | ник» перебирает splits(), а сам ник от пунктуации
        // защищает validSlug — здесь пускаем весь набор символов имени.
        if (!text[start].isEmoteNameChar()) return false
        // Хвостовые и подряд идущие «_» раньше отсекались как «не наш формат»,
        // но ник стримера бывает и таким (peeb_iluci____ → ник iluci____).
        var underscores = 0
        for (i in start until end) {
            val c = text[i]
            if (c == '_') { underscores++; continue }
            if (!c.isEmoteNameChar()) return false
        }
        return underscores > 0
    }

    fun consider(word: String) {
        synchronized(cache) {
            if (cache.containsKey(word)) return
            if (cache.size >= MAX_WORDS) return
            if (!inFlight.add(word)) return
        }
        io.execute {
            // весь раннабл под L.safe: вылет тут ушёл бы глобальному
            // обработчику и уронил бы процесс ВК
            L.safe("предложение $word") {
                val hit = L.safe("проверка $word") { probe(word) }
                synchronized(cache) {
                    cache[word] = hit
                    inFlight.remove(word)
                }
                // проверка могла скачать чужой набор — сносим лишние
                SuggestCache.trimSets()
                // нашлось — перерисуем чат, чтобы слово подсветилось
                if (hit != null) Replacer.rerenderAll()
            }
        }
    }

    private fun probe(word: String): Hit? {
        val cacheDir = dir ?: return null
        SuggestCache.warm()
        val connected = Config.sets.map { it.slug }.toSet()
        val dismissed = Config.dismissedSuggests

        // это слово уже разбирали в прошлый раз — ни сети, ни чтения набора
        SuggestCache.word(word)?.let { known ->
            val slug = known.ref.slug.lowercase()
            // набор с тех пор подключили или скрыли — предлагать нечего
            if (slug in connected || slug in dismissed) return null
            SuggestCache.touch(known.ref.id)
            return known
        }

        for ((name, slug) in splits(word)) {
            // набор уже подключён — значит эмоута в нём просто нет; пробуем
            // следующий разделитель, вдруг граница проходит не здесь
            if (slug in connected) continue
            // пользователь скрыл этот набор — не тратим на него запрос к API
            if (slug in dismissed) continue
            val ref = probeSet(slug) ?: continue
            if (ref.slug.lowercase() in dismissed) continue
            // Набор кладётся в тот же дисковый кэш, из которого потом читает
            // Emotes.load, — поэтому подключение по кнопке уже не качает ничего.
            val emotes = Emotes.emotesOf(cacheDir, ref.id) ?: continue
            SuggestCache.touch(ref.id) // набор в ходу — вытеснится позже других
            // имя сверяем с учётом регистра: подключим набор — эмоут должен
            // отрендериться ровно тем словом, которое пришло в сообщении
            val em = emotes[name] ?: continue
            val hit = Hit(word, name, ref, emotes.size, em.url)
            SuggestCache.putWord(slug, hit)
            return hit
        }
        return null
    }

    /**
     * Ник -> набор. Определённый ответ 7TV («вот набор», 404, «такого стримера
     * нет») кэшируется на диск — второй раз за ним не ходим. Сбой связи и 5xx
     * не кэшируем: это не ответ «набора нет», спросим при следующем запуске.
     */
    private fun probeSet(slug: String): SetRef? = synchronized(probedSets) {
        if (probedSets.containsKey(slug)) return probedSets[slug]
        SuggestCache.set(slug)?.let { known ->
            probedSets[slug] = known.ref
            return known.ref
        }
        if (probes >= MAX_PROBES) return null
        probes++
        var definite = true
        val ref = try {
            SevenTv.resolve(slug)
        } catch (t: SevenTv.NotFound) {
            null
        } catch (t: Net.HttpException) {
            definite = t.code == 404
            null
        } catch (t: Throwable) {
            definite = false
            null
        }
        probedSets[slug] = ref
        if (definite) SuggestCache.putSet(slug, ref)
        ref
    }

    private fun splits(word: String): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>(MAX_SPLITS)
        var i = word.indexOf('_')
        while (i > 0 && out.size < MAX_SPLITS) {
            val name = word.substring(0, i)
            val slug = word.substring(i + 1).lowercase()
            if (validSlug(slug)) out.add(name to slug)
            i = word.indexOf('_', i + 1)
        }
        return out
    }

    private fun validSlug(slug: String): Boolean {
        if (slug.length < 3 || slug.length > 25) return false
        val c0 = slug[0]
        if (!(c0.isAsciiLetter() || c0.isAsciiDigit())) return false
        // хвостовой «_» в нике допустим — стример iluci____ реален
        for (c in slug) if (!(c.isAsciiLetter() || c.isAsciiDigit() || c == '_')) return false
        return true
    }

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'
    private fun Char.isAsciiDigit() = this in '0'..'9'

    // Символы, из которых 7TV собирает имя эмоута: буквы, цифры, «_» и
    // немного пунктуации (-F, ellen?, (7TV), D:). Точку/запятую/слэш/собаку
    // не берём намеренно — это обычный текст или ссылка, а не эмоут, и на них
    // не стоит тратить лимит запросов к API.
    private const val NAME_PUNCT = "-()!?:"
    private fun Char.isEmoteNameChar() =
        isAsciiLetter() || isAsciiDigit() || this == '_' || this in NAME_PUNCT
}
