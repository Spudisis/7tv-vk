package com.vk7tv.module

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

class SetRef(val id: String, val slug: String, val name: String)

/**
 * Свой эмоут. [id] есть, если добавляли ссылкой с 7TV: из него собирается
 * второе имя (`xyz_01H4RX…`), по которому эмоут узнаёт чужой клиент.
 * У картинки не с 7TV id пустой — такой эмоут работает только у владельца.
 */
class CustomEmote(val url: String, val id: String, val zeroWidth: Boolean = false) {
    fun fullName(name: String): String = if (id.isEmpty()) name else "${name}_$id"
}

/**
 * Конфиг живёт в SharedPreferences самого ВК.
 *
 * Сначала он лежал в приложении-модуле и читался через XSharedPreferences,
 * но под LSPatch — это который без рута — так нельзя: модуль встроен прямо
 * в чужой APK и до данных своего приложения не дотягивается. Поэтому всё
 * хранится в процессе ВК. Побочная польза: хранилище стало доступно
 * на запись, так что наборы и избранное правятся прямо из пикера,
 * а отдельное приложение-настройка больше не нужно.
 */
object Config {

    const val PREFS = "vk7tv"

    const val KEY_ENABLED = "enabled"
    const val KEY_USE_GLOBAL = "useGlobal"
    const val KEY_SETS = "sets"
    const val KEY_CUSTOM = "customEmotes"
    const val KEY_FAVORITES = "favorites"
    const val KEY_DOCK = "dockButton"
    const val KEY_SEEDED = "seeded"
    const val KEY_DIAG = "diag"
    const val KEY_SUGGEST = "suggest"
    const val KEY_SUGGEST_PREVIEW = "suggestPreview"
    const val KEY_EVERYWHERE = "everywhere"
    const val KEY_DISMISSED = "dismissedSuggests"
    const val KEY_DISMISSED_EMOTES = "dismissedEmotes"
    const val KEY_CACHE_MB = "cacheCapMb"
    const val KEY_START_ATTEMPTS = "startAttempts"
    const val KEY_UPD_CHECKED = "updateCheckedAt"
    const val KEY_UPD_VERSION = "updateVersion"
    const val KEY_UPD_TOLD = "updateTold"

    // Потолок кэша картинок, МБ. По умолчанию 1 ГБ — паки большие, а память
    // на телефонах давно не 8 ГБ; человек может поменять в настройках.
    const val CACHE_MB_DEFAULT = 1024

    // После скольких вылетов старта подряд уходить в аварийный режим. 1 —
    // хватает одного: клиент-«кирпич» мучительнее, чем разово выключенные
    // эмоуты. Нативный вылет (напр. в декодере картинок) не ловится ни L.safe,
    // ни ловушкой вылетов — процесс просто умирает, и клиент нельзя открыть.
    const val SAFE_MODE_AFTER = 1

    @Volatile
    var enabled = true
        private set

    @Volatile
    var useGlobal = true
        private set

    @Volatile
    var dockButton = true
        private set

    // выключена: своё дело она сделала, а тосты при каждом запуске мешают.
    // Переключатель остался в настройках — пригодится, когда ВК что-нибудь
    // сломает очередным обновлением
    @Volatile
    var diag = false
        private set

    @Volatile
    var suggest = true
        private set

    // Картинка вместо незнакомого слова из чужого набора. Отдельный выключатель,
    // а не часть suggest: рисование чужих эмоутов — это лишние декодирования
    // картинок, а именно на них модуль когда-то ронял клиент нативно
    // (см. аварийный режим). Останется способ выключить только картинки,
    // не теряя сами предложения.
    @Volatile
    var suggestPreview = true
        private set

    // выкл. по умолчанию — коды подменяются ТОЛЬКО в переписке. Включённая
    // снимает ограничение: эмоуты появляются везде (лента, комментарии и т.д.).
    @Volatile
    var everywhere = false
        private set

    @Volatile
    var cacheCapMb = CACHE_MB_DEFAULT
        private set

    // Аварийный режим: подмена, картинки, автоподсказки и пикер выключены,
    // чтобы клиент, падавший на старте, всё-таки открылся. Считается при
    // запуске (beginStartup), сбрасывается временем без вылета или вручную.
    @Volatile
    var safeMode = false
        private set

    @Volatile
    var sets: List<SetRef> = emptyList()
        private set

    @Volatile
    var custom: Map<String, CustomEmote> = emptyMap()
        private set

    @Volatile
    var favorites: List<String> = emptyList()
        private set

    // наборы, которые пользователь скрыл из «можно подключить»: не предлагаем
    // и не проверяем по API, пока он сам не подключит их из настроек
    @Volatile
    var dismissedSuggests: Set<String> = emptySet()
        private set

    // чужие эмоуты, которые пользователь скрыл из «можно добавить себе»:
    // хранятся по id эмоута на 7TV
    @Volatile
    var dismissedEmotes: Set<String> = emptySet()
        private set

    private var prefs: SharedPreferences? = null

    fun init(ctx: Context) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        read(p)
    }

    // --- чтение ---

    private fun read(p: SharedPreferences) {
        enabled = p.getBoolean(KEY_ENABLED, true)
        useGlobal = p.getBoolean(KEY_USE_GLOBAL, true)
        dockButton = p.getBoolean(KEY_DOCK, true)
        diag = p.getBoolean(KEY_DIAG, false)
        // Подробные строки в журнале ходят вместе с диагностикой. Раньше
        // L.verbose не включался ниоткуда, и все L.v молчали всегда.
        L.verbose = diag
        suggest = p.getBoolean(KEY_SUGGEST, true)
        suggestPreview = p.getBoolean(KEY_SUGGEST_PREVIEW, true)
        everywhere = p.getBoolean(KEY_EVERYWHERE, false)
        cacheCapMb = p.getInt(KEY_CACHE_MB, CACHE_MB_DEFAULT).coerceAtLeast(64)
        sets = parseSets(p.getString(KEY_SETS, "[]"))
        custom = parseCustom(p.getString(KEY_CUSTOM, "{}"))
        favorites = parseList(p.getString(KEY_FAVORITES, "[]"))
        dismissedSuggests = parseList(p.getString(KEY_DISMISSED, "[]")).toSet()
        dismissedEmotes = parseList(p.getString(KEY_DISMISSED_EMOTES, "[]")).toSet()
        L.i("конфиг: наборов ${sets.size}, своих ${custom.size}, избранных ${favorites.size}")
    }

    val seeded: Boolean
        get() = prefs?.getBoolean(KEY_SEEDED, false) ?: true

    fun markSeeded() {
        prefs?.edit()?.putBoolean(KEY_SEEDED, true)?.apply()
    }

    // --- запись ---

    fun setFlag(key: String, value: Boolean) {
        prefs?.edit()?.putBoolean(key, value)?.apply()
        when (key) {
            KEY_ENABLED -> enabled = value
            KEY_USE_GLOBAL -> useGlobal = value
            KEY_DOCK -> dockButton = value
            KEY_DIAG -> {
                diag = value
                L.verbose = value
            }
            KEY_SUGGEST -> suggest = value
            KEY_SUGGEST_PREVIEW -> suggestPreview = value
            KEY_EVERYWHERE -> everywhere = value
        }
    }

    /**
     * Отметить начало запуска и решить, не пора ли в аварийный режим.
     * Счётчик пишем ДО рискованной работы и синхронно (commit): нативный вылет
     * не даст выполнить apply() позже, а нам важно, чтобы попытка сохранилась.
     * Возвращает true, если модуль уже ронял старт [SAFE_MODE_AFTER] раз подряд.
     */
    fun beginStartup(): Boolean {
        val p = prefs ?: return false
        val old = p.getInt(KEY_START_ATTEMPTS, 0)
        if (old >= SAFE_MODE_AFTER) {
            safeMode = true // остаёмся в аварийном режиме, пока не переживём старт
            return true
        }
        p.edit().putInt(KEY_START_ATTEMPTS, old + 1).commit()
        safeMode = false
        return false
    }

    /** Старт пережили без вылета — обнуляем счётчик неудачных попыток. */
    fun startupSurvived() {
        prefs?.edit()?.putInt(KEY_START_ATTEMPTS, 0)?.apply()
    }

    // --- обновления модуля ---

    /** Когда последний раз спрашивали GitHub про релизы. */
    val updateCheckedAt: Long
        get() = prefs?.getLong(KEY_UPD_CHECKED, 0L) ?: 0L

    /** Найденная в прошлый раз версия — чтобы знать о ней и без сети. */
    val updateVersion: String?
        get() = prefs?.getString(KEY_UPD_VERSION, null)?.ifEmpty { null }

    /** Версия, про которую уже сказали тостом: второй раз не тревожим. */
    val updateTold: String?
        get() = prefs?.getString(KEY_UPD_TOLD, null)

    fun rememberUpdate(version: String?, at: Long) {
        prefs?.edit()?.putString(KEY_UPD_VERSION, version ?: "")?.putLong(KEY_UPD_CHECKED, at)?.apply()
    }

    fun rememberUpdateTold(version: String) {
        prefs?.edit()?.putString(KEY_UPD_TOLD, version)?.apply()
    }

    /** Ручной выход из аварийного режима (кнопка в настройках). */
    fun exitSafeMode() {
        safeMode = false
        startupSurvived()
    }

    /** Сменить потолок кэша картинок (МБ). Подрезку запускает вызывающий. */
    fun setCacheCapMb(mb: Int) {
        val v = mb.coerceAtLeast(64)
        prefs?.edit()?.putInt(KEY_CACHE_MB, v)?.apply()
        cacheCapMb = v
    }

    fun addSet(ref: SetRef) {
        writeSets(sets.filter { it.id != ref.id } + ref)
    }

    fun removeSet(id: String) {
        writeSets(sets.filter { it.id != id })
    }

    /**
     * Новый порядок наборов — им же задаётся порядок вкладок в пикере
     * (Emotes.load идёт по этому списку).
     *
     * Переставляем только те наборы, что перечислены в [ids], и только по их
     * же местам. Набор, который не докачался (7tv.io недоступен), вкладки
     * не получил, в [ids] не попал — и должен остаться там, где стоял:
     * иначе одно перетаскивание молча сбрасывало бы его в конец списка.
     */
    fun reorderSets(ids: List<String>) {
        val moving = ids.toSet()
        val slots = sets.indices.filter { sets[it].id in moving }
        if (slots.size < 2) return
        val byId = sets.associateBy { it.id }
        val ordered = ids.mapNotNull { byId[it] }
        if (ordered.size != slots.size) return
        val out = ArrayList(sets)
        slots.forEachIndexed { n, i -> out[i] = ordered[n] }
        writeSets(out)
    }

    private fun writeSets(list: List<SetRef>) {
        val arr = JSONArray()
        for (s in list) {
            arr.put(JSONObject().put("id", s.id).put("slug", s.slug).put("name", s.name))
        }
        prefs?.edit()?.putString(KEY_SETS, arr.toString())?.apply()
        sets = list
    }

    /** Скрыть набор из предложений «можно подключить» насовсем. */
    fun dismissSuggest(slug: String) {
        if (slug.isEmpty() || dismissedSuggests.contains(slug)) return
        val list = dismissedSuggests + slug
        val arr = JSONArray()
        for (s in list) arr.put(s)
        prefs?.edit()?.putString(KEY_DISMISSED, arr.toString())?.apply()
        dismissedSuggests = list
    }

    /**
     * Добавить свой эмоут. Занятое имя не перетираем: у обоих остаётся своё
     * полное имя с id, а голое достаётся тому, кто добавлен первым, — поэтому
     * второму приписываем номер. Возвращает имя, под которым эмоут записан.
     *
     * Формат в хранилище — тот же, что у расширения ({u, z, id}), чтобы
     * резервная копия ходила между ними без правок.
     */
    fun addCustom(name: String, url: String, id: String, zeroWidth: Boolean = false): String {
        var key = name
        val cur = custom[key]
        if (cur != null && cur.url != url) {
            var i = 2
            while (custom.containsKey(key + i)) i++
            key += i
        }
        val next = LinkedHashMap(custom)
        next[key] = CustomEmote(url, id, zeroWidth)
        writeCustom(next)
        return key
    }

    fun removeCustom(name: String) {
        if (!custom.containsKey(name)) return
        writeCustom(custom.filterKeys { it != name })
    }

    private fun writeCustom(map: Map<String, CustomEmote>) {
        val o = JSONObject()
        for ((name, e) in map) {
            o.put(name, JSONObject().put("u", e.url).put("z", if (e.zeroWidth) 1 else 0).put("id", e.id))
        }
        prefs?.edit()?.putString(KEY_CUSTOM, o.toString())?.apply()
        custom = map
    }

    /** Скрыть чужой эмоут из «можно добавить себе» насовсем. */
    fun dismissEmote(id: String) {
        if (id.isEmpty() || dismissedEmotes.contains(id)) return
        val list = dismissedEmotes + id
        val arr = JSONArray()
        for (s in list) arr.put(s)
        prefs?.edit()?.putString(KEY_DISMISSED_EMOTES, arr.toString())?.apply()
        dismissedEmotes = list
    }

    fun isFavorite(name: String): Boolean = favorites.contains(name)

    /** Возвращает новое состояние: true — эмоут теперь в избранном. */
    fun toggleFavorite(name: String): Boolean {
        val on = !favorites.contains(name)
        val list = if (on) favorites + name else favorites.filter { it != name }
        val arr = JSONArray()
        for (n in list) arr.put(n)
        prefs?.edit()?.putString(KEY_FAVORITES, arr.toString())?.apply()
        favorites = list
        return on
    }

    /**
     * Тот же JSON, что отдаёт «Резервная копия настроек» в попапе расширения.
     * Списки эмоутов оттуда не берём — их модуль качает с 7tv.io сам по id.
     */
    fun importBackup(raw: String): String {
        val json = try {
            JSONObject(raw)
        } catch (t: JSONException) {
            throw RuntimeException("Не похоже на резервную копию — скопируй весь текст из файла целиком")
        }
        val e = prefs?.edit() ?: throw IllegalStateException("конфиг не открыт")
        var setCount = 0
        var favCount = 0
        var customCount = 0

        json.optJSONArray("sets")?.let {
            e.putString(KEY_SETS, it.toString())
            setCount = it.length()
        }
        json.optJSONObject("customEmotes")?.let {
            e.putString(KEY_CUSTOM, it.toString())
            customCount = it.length()
        }
        json.optJSONArray("favorites")?.let {
            e.putString(KEY_FAVORITES, it.toString())
            favCount = it.length()
        }
        if (json.has("useGlobal")) e.putBoolean(KEY_USE_GLOBAL, json.optBoolean("useGlobal", true))
        if (json.has("everywhere")) {
            e.putBoolean(KEY_EVERYWHERE, json.optBoolean("everywhere", false))
        } else if (json.has("messengerOnly")) {
            // старый бэкап: messengerOnly=true → только переписка → everywhere=false
            e.putBoolean(KEY_EVERYWHERE, !json.optBoolean("messengerOnly", false))
        }
        e.putBoolean(KEY_SEEDED, true)
        e.apply()

        prefs?.let { read(it) }
        return "Наборов $setCount, своих $customCount, избранных $favCount"
    }

    // --- разбор ---

    private fun parseSets(raw: String?): List<SetRef> {
        val out = ArrayList<SetRef>()
        L.safe("разбор списка наборов") {
            val arr = JSONArray(raw ?: "[]")
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isEmpty()) continue
                out.add(SetRef(id, o.optString("slug"), o.optString("name", id)))
            }
        }
        return out
    }

    private fun parseCustom(raw: String?): Map<String, CustomEmote> {
        val out = LinkedHashMap<String, CustomEmote>()
        L.safe("разбор своих эмоутов") {
            val o = JSONObject(raw ?: "{}")
            for (k in o.keys()) {
                // расширение хранит либо строку-URL, либо {u, z, id}
                val v = o.get(k)
                val url = if (v is JSONObject) v.optString("u") else v.toString()
                val id = if (v is JSONObject) v.optString("id") else ""
                val zw = v is JSONObject && v.optInt("z") != 0
                if (url.isNotEmpty()) out[k] = CustomEmote(url, id, zw)
            }
        }
        return out
    }

    private fun parseList(raw: String?): List<String> {
        val out = ArrayList<String>()
        L.safe("разбор избранного") {
            val arr = JSONArray(raw ?: "[]")
            for (i in 0 until arr.length()) out.add(arr.optString(i))
        }
        return out.filter { it.isNotEmpty() }
    }
}
