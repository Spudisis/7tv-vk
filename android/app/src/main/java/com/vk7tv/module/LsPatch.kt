package com.vk7tv.module

import android.content.pm.ApplicationInfo
import java.io.File
import java.io.RandomAccessFile

/**
 * Проверка распакованной копии оригинального APK, из которой работает
 * пропатченный клиент.
 *
 * Под LSPatch (установщик, без рута) клиент запускается не из установленного
 * APK, а из копии оригинала: загрузчик распаковывает её в
 * cache/lspatch/origin/<crc>.apk и подставляет этот файл в sourceDir.
 * Распаковка идёт один раз — на первом запуске после установки и заново после
 * каждой чистки кэша.
 *
 * Два свойства загрузчика вместе дают клиент, который перестаёт открываться
 * совсем: распаковка пишет сразу под конечным именем, без временного файла, а
 * на следующих запусках проверяется только наличие файла, не его целость.
 * Оборвалась распаковка — не хватило места, процесс убили на холодном
 * старте, — и под конечным именем остаётся обрезанный APK. Дальше клиент
 * падает каждый запуск при загрузке своих классов. Аварийный режим модуля тут
 * не помогает: он взводится в Boot.ensure, до которого исполнение уже не
 * доходит. Известное лечение — очистка кэша вручную.
 *
 * Обрыв распаковки не редкость: cache/ система вычищает в фоновом
 * обслуживании при нехватке места, после чего на ближайшем холодном старте
 * заново копируются сотни мегабайт.
 *
 * Мы работаем в том же процессе и с тем же UID, поэтому проверяем копию сами
 * и сносим битую: загрузчик распакует её заново при следующем запуске.
 * Текущий запуск это не спасает — клиент уже читает битый файл, — но вместо
 * бесконечных падений остаётся одно.
 *
 * Целость проверяем по структуре zip, не сверяя с исходным APK. Сверять было
 * бы нечем: при обходе проверки подписи (наш патч ставит уровень 2) загрузчик
 * перехватывает openat и перенаправляет чтение установленного APK на эту же
 * копию — вместо оригинала мы прочитали бы проверяемый файл.
 */
internal object LsPatch {

    private const val ORIGIN_DIR = "cache/lspatch/origin"

    // Файл, который прямо сейчас пишет другой процесс клиента, тоже выглядит
    // обрезанным. Свежие не трогаем: запись обновляет время файла, поэтому
    // идущая распаковка всегда выглядит свежей, а оборванная — нет.
    private const val FRESH_MS = 60_000L

    /**
     * Снести битые и лишние копии оригинального APK. [info] — appInfo из
     * handleLoadPackage: загрузчик уже подставил в sourceDir путь к копии.
     *
     * Зовётся из handleLoadPackage синхронно, хотя это работа с диском: клиент
     * падает при загрузке своих классов, то есть раньше Application.onCreate,
     * откуда поднимается всё остальное. В здоровом случае это чтение хвоста
     * одного файла.
     */
    fun checkOrigin(info: ApplicationInfo?) {
        val dataDir = info?.dataDir ?: return
        val inUse = info.sourceDir ?: return
        val dir = File(dataDir, ORIGIN_DIR)
        // клиент запускается не из копии — значит патча нет (LSPosed с рутом)
        if (!inUse.startsWith(dir.path + "/")) return

        val files = dir.listFiles() ?: return
        val now = System.currentTimeMillis()
        for (f in files) {
            if (!f.isFile) continue
            if (now - f.lastModified() < FRESH_MS) continue
            val current = f.path == inUse
            if (current && isWholeZip(f)) {
                L.v("копия оригинального APK цела, ${f.length() / (1024 * 1024)} МБ")
                continue
            }
            // Лишние копии — обрывки .tmp и копии от прошлых версий клиента.
            // Каждая занимает сотни мегабайт, а именно нехватка места приводит
            // к чистке кэша системой и оборванной распаковке.
            val why = if (current) "битая" else "лишняя"
            val mb = f.length() / (1024 * 1024)
            // процессов у клиента несколько, и проверку проходит каждый: файл
            // мог снести сосед, это тот же успех
            val gone = L.safe("удаление копии APK") { f.delete() || !f.exists() } == true
            L.i(
                if (gone) "удалена $why копия оригинального APK ${f.name}, $mb МБ"
                else "не удалось удалить $why копию оригинального APK ${f.name}",
            )
        }
    }

    // Запись конца центрального каталога: сигнатура, дальше 18 байт полей.
    // Лежит в самом хвосте файла, поэтому у обрезанной копии её нет.
    private const val EOCD_SIG = 0x06054b50
    private const val EOCD_MIN = 22

    // Хвост zip может заканчиваться комментарием длиной до 64 КБ — настолько
    // далеко от конца файла и может оказаться запись.
    private const val EOCD_SEARCH = EOCD_MIN + 0xFFFF

    private const val LOCAL_SIG = 0x04034b50

    /**
     * Похож ли файл на целый zip: начинается записью локального заголовка, а в
     * хвосте лежит запись конца центрального каталога, и каталог по её данным
     * помещается в файл. Обрезанная копия не проходит по хвосту.
     */
    private fun isWholeZip(f: File): Boolean = L.safe("проверка копии APK") {
        val len = f.length()
        if (len < EOCD_MIN) return@safe false
        RandomAccessFile(f, "r").use { raf ->
            if (int32(ByteArray(4).also { raf.readFully(it) }, 0) != LOCAL_SIG) return@safe false

            val tail = minOf(len, EOCD_SEARCH.toLong()).toInt()
            val buf = ByteArray(tail)
            raf.seek(len - tail)
            raf.readFully(buf)

            var i = buf.size - EOCD_MIN
            while (i >= 0) {
                if (int32(buf, i) == EOCD_SIG) {
                    val cdSize = uint32(buf, i + 12)
                    val cdOffset = uint32(buf, i + 16)
                    // zip64: настоящие размер и смещение лежат в отдельной
                    // записи. Разбирать её не будем — считаем такой файл целым:
                    // лишняя распаковка сотен мегабайт хуже, чем пропуск
                    // проверки у формата, до которого APK клиента не дорос.
                    if (cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL) return@safe true
                    return@safe cdOffset + cdSize <= len - tail + i
                }
                i--
            }
            false
        }
    } ?: false

    private fun int32(b: ByteArray, i: Int): Int =
        (b[i].toInt() and 0xff) or
            ((b[i + 1].toInt() and 0xff) shl 8) or
            ((b[i + 2].toInt() and 0xff) shl 16) or
            ((b[i + 3].toInt() and 0xff) shl 24)

    private fun uint32(b: ByteArray, i: Int): Long = int32(b, i).toLong() and 0xFFFFFFFFL
}
