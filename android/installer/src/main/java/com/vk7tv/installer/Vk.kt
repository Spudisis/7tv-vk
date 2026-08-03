package com.vk7tv.installer

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import java.io.File
import java.util.zip.ZipFile

/**
 * Поиск клиентов ВК на устройстве и добыча их исходных (непропатченных) APK.
 */
object Vk {

    // Наш собственный установщик — не предлагать патчить сам себя.
    private const val SELF = "com.vk7tv.installer"

    // Метка, которую LSPatch прописывает в манифест пропатченного приложения.
    // По ней отличаем «уже пропатчен» от «оригинал».
    private const val LSPATCH_FACTORY = "org.lsposed.lspatch.metaloader.LSPAppComponentFactoryStub"

    // Где LSPatch прячет исходный APK внутри пропатченного.
    private const val ORIGIN_ENTRY = "assets/lspatch/origin.apk"

    // Заведомо известные клиенты ВК.
    private val KNOWN = setOf(
        "com.vkontakte.android", // официальный ВК
        "com.vk.im",             // ВК Мессенджер
    )

    // По этим кускам имени/пакета узнаём сторонние клиенты (Sova, Kate и пр.).
    private val HINTS = listOf("vk", "вконтакте", "sova", "kate", "vkontakte")

    class Client(
        val pkg: String,
        val label: String,
        val patched: Boolean,
    )

    /** Клиенты ВК среди установленных. Пусто — предложим показать все приложения. */
    fun clients(ctx: Context): List<Client> = launchable(ctx).filter { looksLikeVk(it) }

    /** Все приложения с иконкой в лаунчере — запасной ручной выбор. */
    fun all(ctx: Context): List<Client> = launchable(ctx)

    private fun looksLikeVk(c: Client): Boolean {
        if (c.pkg in KNOWN) return true
        val hay = (c.pkg + " " + c.label).lowercase()
        return HINTS.any { hay.contains(it) }
    }

    private fun launchable(ctx: Context): List<Client> {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val seen = HashSet<String>()
        val out = ArrayList<Client>()
        for (ri in pm.queryIntentActivities(intent, 0)) {
            val pkg = ri.activityInfo?.packageName ?: continue
            if (pkg == SELF || !seen.add(pkg)) continue
            val label = ri.loadLabel(pm)?.toString() ?: pkg
            out.add(Client(pkg, label, isPatched(pm, pkg)))
        }
        return out.sortedBy { it.label.lowercase() }
    }

    private fun isPatched(pm: PackageManager, pkg: String): Boolean =
        try {
            pm.getApplicationInfo(pkg, 0).appComponentFactory == LSPATCH_FACTORY
        } catch (t: Throwable) {
            false
        }

    /**
     * Исходные APK клиента, разложенные в [workDir]. Если клиент пропатчен —
     * достаём оригинал из вложения origin.apk (свой архив хранить не нужно).
     * База именуется base.apk, сплиты — split_*.apk: по этим именам LSPatch
     * понимает, что нести целиком, а что просто переподписать.
     */
    fun originals(ctx: Context, client: Client, workDir: File, log: (String) -> Unit): List<File> {
        workDir.mkdirs()
        val ai = ctx.packageManager.getApplicationInfo(client.pkg, 0)
        val src = ArrayList<String>()
        src.add(ai.sourceDir)
        ai.splitSourceDirs?.let { src.addAll(it) }

        val out = ArrayList<File>()
        for ((i, path) in src.withIndex()) {
            val isBase = i == 0
            val name = when {
                isBase -> "base.apk"
                path.substringAfterLast('/').startsWith("split_") -> path.substringAfterLast('/')
                else -> "split_${i}_${path.substringAfterLast('/')}"
            }
            val dst = File(workDir, name)
            if (client.patched) {
                log("Извлекаю оригинал из $name")
                extractOrigin(File(path), dst)
            } else {
                log("Копирую $name")
                File(path).inputStream().use { inp -> dst.outputStream().use { inp.copyTo(it) } }
            }
            out.add(dst)
        }
        return out
    }

    private fun extractOrigin(patched: File, dst: File) {
        ZipFile(patched).use { zip ->
            val e = zip.getEntry(ORIGIN_ENTRY)
                ?: throw RuntimeException("В ${patched.name} нет вложенного оригинала")
            zip.getInputStream(e).use { inp -> dst.outputStream().use { inp.copyTo(it) } }
        }
    }
}
