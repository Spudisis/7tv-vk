package com.vk7tv.installer

import org.lsposed.patch.LSPatch
import org.lsposed.patch.util.Logger
import java.io.File
import java.security.Security

/**
 * Обёртка над CLI LSPatch, вкомпилированным как библиотека. LSPatch читает свой
 * loader.dex / metaloader.dex / liblspatch.so из ресурсов класслоадера — они
 * лежат в APK установщика по путям assets/lspatch/… (см. build.gradle).
 *
 * Ключ подписи — отдельная история. Дефолтный keystore внутри lspatch.jar в
 * формате JKS, а Android его не читает (провайдера нет) — отсюда была ошибка
 * «Failed to register signer». Поэтому подсовываем свой ключ в PKCS12 (его
 * Android грузит) через -k и заставляем KeyStore.getDefaultType() вернуть
 * PKCS12: LSPatch создаёт хранилище именно этого типа.
 *
 * Ключ постоянный и лежит в репозитории (assets/signing/vk7tv.p12): все патчи
 * подписаны им, поэтому «обновить модуль» встаёт поверх без потери входа.
 */
object Patcher {

    const val KS_ALIAS = "vk7tv"
    const val KS_PASS = "123456"

    /**
     * Патчит [originals] (base.apk + сплиты), вшивая [moduleApk], подписывая
     * ключом [keystore]. Результат — в [outDir]; его и ставим.
     */
    fun patch(
        originals: List<File>,
        moduleApk: File,
        keystore: File,
        outDir: File,
        log: (String) -> Unit,
    ): List<File> {
        // Иначе getDefaultType() на Android вернёт BKS/по-умолчанию, и наш
        // PKCS12 не загрузится.
        Security.setProperty("keystore.type", "PKCS12")
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
        // свой PKCS12 вместо JKS-ключа из jar: путь, пароль хранилища, алиас, пароль ключа
        args += listOf("-k", keystore.absolutePath, KS_PASS, KS_ALIAS, KS_PASS)
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
