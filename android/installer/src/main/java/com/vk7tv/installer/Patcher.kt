package com.vk7tv.installer

import org.lsposed.patch.LSPatch
import org.lsposed.patch.util.Logger
import java.io.File

/**
 * Обёртка над CLI LSPatch, вкомпилированным как библиотека. LSPatch читает свой
 * loader.dex / metaloader.dex / liblspatch.so и ключ из ресурсов класслоадера —
 * все они лежат в APK установщика по путям assets/lspatch/… (см. build.gradle).
 */
object Patcher {

    /**
     * Патчит [originals] (base.apk + сплиты), вшивая [moduleApk], и складывает
     * результат в [outDir]. Возвращает пропатченные APK — их и ставим.
     */
    fun patch(originals: List<File>, moduleApk: File, outDir: File, log: (String) -> Unit): List<File> {
        outDir.mkdirs()
        // чистим прошлый прогон, чтобы -f не спорил и не осталось лишних сплитов
        outDir.listFiles()?.forEach { if (it.name.endsWith("-lspatched.apk")) it.delete() }

        val logger = object : Logger() {
            override fun d(msg: String) { if (verbose) log(msg) }
            override fun i(msg: String) = log(msg)
            override fun e(msg: String) = log("! $msg")
        }

        val args = ArrayList<String>()
        args += listOf("-o", outDir.absolutePath, "-f")
        // Обход проверки подписи (pm+openat): ВК сверяет свою подпись, а после
        // патча она другая. Без этого части приложения могут не работать.
        args += listOf("-l", "2")
        args += listOf("-m", moduleApk.absolutePath)
        // база первой, дальше сплиты — порядок важен для склейки
        originals.forEach { args += it.absolutePath }

        log("Патчу (${originals.size} apk)…")
        LSPatch(logger, *args.toTypedArray()).doCommandLine()

        val patched = outDir.listFiles { f -> f.name.endsWith("-lspatched.apk") }?.toList().orEmpty()
        if (patched.isEmpty()) throw RuntimeException("LSPatch не выдал ни одного APK")
        log("Готово: ${patched.size} apk")
        return patched
    }
}
