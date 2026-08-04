package com.vk7tv.installer

import android.content.Context
import org.json.JSONArray
import java.io.File

/**
 * Релизы на GitHub. Отсюда установщик берёт две вещи:
 *  - свежий APK модуля (тег вида android-v*), чтобы патчить последней версией
 *    без ручного скачивания;
 *  - свежий APK самого установщика (тег installer-v*), чтобы обновлять и его
 *    прямо из приложения.
 */
object Releases {

    const val REPO = "Spudisis/7tv-vk"
    private const val API = "https://api.github.com/repos/$REPO/releases?per_page=40"

    class Found(val tag: String, val version: String, val assetUrl: String, val assetName: String)

    /**
     * Снимок актуальных релизов одним запросом к API: и обновление установщика,
     * и последний модуль. Так проверка «есть ли что новое» не качает ни одного
     * APK — только лёгкий JSON. Номер версии модуля показываем на карточке,
     * а сам APK тянем уже по кнопке.
     */
    class Snapshot(val installerUpdate: Found?, val module: Found?)

    fun snapshot(currentInstaller: String): Snapshot {
        val arr = JSONArray(Http.getString(API))
        val inst = latestIn(arr, "installer")
        val mod = latestIn(arr, "android")
        val instUpd = if (inst != null && semverGreater(inst.version, currentInstaller)) inst else null
        return Snapshot(instUpd, mod)
    }

    /**
     * Релиз с максимальной версией среди тех, чей тег начинается с
     * [tagStartsWith] и внутри есть .apk.
     *
     * Раньше брали ПЕРВЫЙ подходящий в ленте, полагаясь на то, что GitHub
     * отдаёт релизы от новых к старым. Но сразу после публикации порядок
     * ленты бывает нестабилен (кэш индексации на стороне GitHub): свежий
     * релиз какое-то время стоит не наверху, и «первый» оказывался не самой
     * новой версией — так, например, 0.5.10 не тянулся, пока в ленте выше
     * висел 0.5.9. Поэтому перебираем все подходящие и берём наибольшую
     * версию по semver, а не по позиции в ленте.
     */
    private fun latest(tagStartsWith: String): Found? =
        latestIn(JSONArray(Http.getString(API)), tagStartsWith)

    private fun latestIn(arr: JSONArray, tagStartsWith: String): Found? {
        var best: Found? = null
        for (i in 0 until arr.length()) {
            val rel = arr.optJSONObject(i) ?: continue
            if (rel.optBoolean("draft") || rel.optBoolean("prerelease")) continue
            val tag = rel.optString("tag_name")
            if (!tag.startsWith(tagStartsWith)) continue
            val assets = rel.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val a = assets.optJSONObject(j) ?: continue
                val name = a.optString("name")
                if (!name.endsWith(".apk")) continue
                val url = a.optString("browser_download_url")
                if (url.isEmpty()) continue
                val cand = Found(tag, versionFromTag(tag), url, name)
                val cur = best
                if (cur == null || semverGreater(cand.version, cur.version)) best = cand
                break // из ассетов одного релиза берём первый .apk
            }
        }
        return best
    }

    // "android-v0.5.3" / "installer-v0.2.0" -> "0.5.3" / "0.2.0"
    private fun versionFromTag(tag: String): String =
        Regex("(\\d+\\.\\d+(?:\\.\\d+)?)").find(tag)?.value ?: tag

    /**
     * APK модуля для патча. Пытаемся скачать последний с GitHub; если сети нет —
     * возвращаем версию, вшитую в установщик при сборке (assets/module/module.apk).
     * Прогресс скачивания уходит в [onProgress] (для прогресс-бара), а текстовые
     * пояснения — в [log] (для журнала).
     */
    fun moduleApk(
        ctx: Context,
        log: (String) -> Unit,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ): File {
        val out = File(ctx.cacheDir, "module.apk")
        try {
            val f = latest("android")
            if (f != null) {
                log("Модуль с GitHub: ${f.assetName}")
                Http.download(f.assetUrl, out, onProgress)
                return out
            }
            log("Свежий модуль не найден на GitHub, беру вшитый")
        } catch (t: Throwable) {
            log("GitHub недоступен (${t.message}), беру вшитый модуль")
        }
        ctx.assets.open("module/module.apk").use { inp ->
            out.outputStream().use { inp.copyTo(it) }
        }
        return out
    }

    /** Новее ли [candidate] чем [current] по semver. Для сравнения версий модуля. */
    fun isNewer(candidate: String, current: String): Boolean = semverGreater(candidate, current)

    private fun semverGreater(a: String, b: String): Boolean {
        val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }
}
