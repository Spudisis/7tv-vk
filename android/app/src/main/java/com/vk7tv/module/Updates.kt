package com.vk7tv.module

import org.json.JSONArray

/**
 * «Вышла новая версия модуля».
 *
 * Установщик человек открывает раз в месяц, а ВК — каждый день, поэтому про
 * обновление честнее сказать здесь. Сам модуль обновиться не может: он вшит
 * в APK клиента, перекладывает его установщик — поэтому всё, что мы делаем,
 * это показываем версию и отправляем в установщик.
 *
 * Ходим в GitHub не чаще раза в сутки и только в фоне: релизы выходят реже,
 * чем запускают клиент, а без сети или с заблокированным GitHub проверка
 * молча ничего не меняет.
 */
object Updates {

    private const val API = "https://api.github.com/repos/Spudisis/7tv-vk/releases?per_page=30"
    private const val STABLE = "android-v"
    private const val DEV = "android-dev-v"
    private const val CHECK_EVERY_MS = 24L * 3600 * 1000

    /** Версия новее текущей или null. Читают настройки и пикер. */
    @Volatile
    var available: String? = null
        private set

    /** Страница релиза — запасной путь, если установщик не стоит. */
    @Volatile
    var page: String? = null
        private set

    /**
     * Проверить, если пора. Зовётся при старте из фонового потока; результат
     * прошлой проверки уже поднят из конфига, так что первый запуск за сутки
     * ничего не задерживает.
     */
    fun checkSoon() {
        val remembered = Config.updateVersion
        if (remembered != null && newer(remembered, BuildConfig.VERSION_NAME)) {
            available = remembered
        }
        val now = System.currentTimeMillis()
        if (now - Config.updateCheckedAt < CHECK_EVERY_MS) {
            tell()
            return
        }
        Thread({
            L.safe("проверка обновлений") { check(now) }
        }, "vk7tv-updates").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }.start()
    }

    /**
     * Проверить прямо сейчас, мимо суточного окна (кнопка в настройках).
     * Ходит в сеть — только не на UI-потоке. Возвращает найденную версию.
     */
    fun checkNow(): String? {
        check(System.currentTimeMillis())
        return available
    }

    private fun check(now: Long) {
        val body = Net.get(API)
        val arr = JSONArray(body)
        var stable: Pair<String, String>? = null // версия -> ссылка
        var dev: Pair<String, String>? = null
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val tag = o.optString("tag_name")
            val url = o.optString("html_url")
            val pair = when {
                tag.startsWith(DEV) -> DEV to tag.removePrefix(DEV)
                tag.startsWith(STABLE) -> STABLE to tag.removePrefix(STABLE)
                else -> continue
            }
            val (kind, version) = pair
            if (version.isEmpty()) continue
            val slot = if (kind == DEV) dev else stable
            if (slot == null || newer(version, slot.first)) {
                if (kind == DEV) dev = version to url else stable = version to url
            }
        }

        // На пробной сборке модуль новее любого стабильного релиза — значит и
        // сравнивать надо с пробным каналом, иначе человеку на 0.7.7 предлагали
        // бы «обновиться» на 0.5.21 или молчали бы о свежих пробных сборках.
        val mine = BuildConfig.VERSION_NAME
        val target = if (stable == null || newer(mine, stable.first)) dev ?: stable else stable
        val found = target?.takeIf { newer(it.first, mine) }

        available = found?.first
        page = found?.second
        Config.rememberUpdate(found?.first, now)
        L.i("проверка обновлений: своя $mine, доступна ${found?.first ?: "нет"}")
        tell()
    }

    /**
     * Сказать про версию один раз. Тост при каждом запуске — это ровно то, от
     * чего мы уходили; про одну и ту же версию человек услышит однажды, дальше
     * она висит в настройках и подсвеченной шестерёнкой в пикере.
     */
    private fun tell() {
        val v = available ?: return
        if (Config.updateTold == v) return
        Config.rememberUpdateTold(v)
        Diag.warn("вышла версия $v — обновить можно в установщике")
    }

    /** Больше x, чем y? Версии вида 0.7.10; недостающие части считаем нулями. */
    private fun newer(x: String, y: String): Boolean {
        val a = parts(x)
        val b = parts(y)
        for (i in 0 until maxOf(a.size, b.size)) {
            val l = a.getOrElse(i) { 0 }
            val r = b.getOrElse(i) { 0 }
            if (l != r) return l > r
        }
        return false
    }

    private fun parts(v: String): List<Int> =
        v.trim().split('.').map { p -> p.takeWhile { it.isDigit() }.toIntOrNull() ?: 0 }
}
