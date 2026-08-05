package com.vk7tv.module

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Журнал модуля на диске.
 *
 * Журнал LSPosed виден только в его менеджере на самом телефоне, а [Crash]
 * записывает лишь пойманные вылеты. Когда процесс умирает нативно — в
 * декодере картинок, в чужом хуке — Java-обработчик до записи не доходит.
 * Именно так взводится аварийный режим, и до сих пор было не видно, что
 * модуль успел сделать перед смертью. Строки ложатся сразу в файл в
 * хранилище ВК, поэтому гибель процесса их не забирает.
 *
 * Файл лежит рядом с наборами, в filesDir: cacheDir чистит и система, и сам
 * ВК кнопкой «очистить кэш», а журнал нужен именно после того, как что-то
 * пошло не так.
 */
object Journal {

    /**
     * Сколько строк держим. Один запуск пишет полтора-два десятка, так что
     * сотни хватает на несколько последних сессий, и присланный файл ещё
     * читается глазами.
     */
    const val LINES = 100

    private const val NAME = "journal.txt"

    private val lock = Any()
    // С датой, а не только время: журнал переживает перезапуски и может
    // охватывать несколько дней, а по одному времени не понять, где какой.
    private val stamp = SimpleDateFormat("dd.MM HH:mm:ss", Locale.US)

    // Строки до появления хранилища копим в памяти: самое интересное
    // происходит на старте, раньше, чем известен каталог.
    private val early = ArrayList<String>()

    @Volatile
    private var file: File? = null

    // Сколько строк в файле сейчас. Считаем сами, чтобы не перечитывать
    // файл на каждую запись.
    private var lines = 0

    fun attach(dir: File) {
        quiet {
            val f = File(dir, NAME)
            synchronized(lock) {
                file = f
                lines = if (f.isFile) f.readLines().size else 0
                for (line in early) write(f, line)
                early.clear()
                trim(f)
            }
        }
    }

    fun add(msg: String) {
        quiet {
            val line = "${stamp.format(Date())}  $msg"
            synchronized(lock) {
                val f = file
                if (f == null) {
                    // хранилища может и не появиться (модуль отвалился раньше) —
                    // держим тот же потолок, иначе список растёт без предела
                    if (early.size >= LINES) early.removeAt(0)
                    early.add(line)
                    return@quiet
                }
                write(f, line)
                // Обрезаем не на каждой строке, а как накопится двойной запас:
                // обрезка читает и переписывает файл целиком.
                if (lines > LINES * 2) trim(f)
            }
        }
    }

    /** Текст журнала целиком — для сохранения и отправки. */
    fun text(): String = synchronized(lock) {
        val f = file
        if (f != null && f.isFile) f.readText() else early.joinToString("\n")
    }

    /** Сколько строк накоплено — для строки в настройках. */
    fun size(): Int = synchronized(lock) { if (file != null) lines else early.size }

    fun clear() {
        quiet {
            synchronized(lock) {
                early.clear()
                file?.delete()
                lines = 0
            }
        }
    }

    /**
     * Положить журнал в «Загрузки» телефона; возвращает имя файла.
     *
     * Через MediaStore: прав на общее хранилище у модуля нет, а этот путь их
     * и не требует. До Android 10 его нет — там остаётся «Поделиться».
     *
     * Только не на UI-потоке: пишет файл.
     */
    fun saveToDownloads(ctx: Context): String {
        val body = text()
        if (body.isBlank()) throw RuntimeException("Журнал пуст — сохранять нечего")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw RuntimeException("На этой версии Android журнал уходит только через «Отправить»")
        }
        val name = "vk7tv-journal-${SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date())}.txt"
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw RuntimeException("Android не дал записать в «Загрузки»")
        val stream = resolver.openOutputStream(uri)
            ?: throw RuntimeException("Android не дал записать в «Загрузки»")
        stream.use { it.write(body.toByteArray()) }
        return name
    }

    private fun write(f: File, line: String) {
        // Без BufferedWriter: FileOutputStream отдаёт байты ядру сразу, и они
        // переживают гибель процесса. Буфер потерял бы ровно те последние
        // строки, ради которых журнал и заведён.
        FileOutputStream(f, true).use { it.write((line + "\n").toByteArray()) }
        lines++
    }

    private fun trim(f: File) {
        if (lines <= LINES) return
        val keep = f.readLines().takeLast(LINES)
        f.writeText(keep.joinToString("\n", postfix = "\n"))
        lines = keep.size
    }

    /**
     * Журнал не имеет права уронить процесс ВК и не может жаловаться через
     * [L.safe]: L пишет в журнал, и сбой записи ушёл бы в бесконечную
     * рекурсию. Поэтому ошибки здесь глотаются молча.
     */
    private inline fun quiet(block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            // намеренно пусто, см. KDoc
        }
    }
}
