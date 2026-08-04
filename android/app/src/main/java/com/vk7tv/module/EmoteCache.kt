package com.vk7tv.module

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.util.LruCache
import java.io.File
import java.nio.ByteBuffer
import java.util.Collections
import java.util.concurrent.Executors

/**
 * Картинки эмоутов. Внутри процесса ВК никакого CSP нет, поэтому вся возня
 * с blob:-URL из веб-версии здесь не нужна — качаем напрямую в кэш ВК.
 *
 * В памяти держим байты файла, а Drawable создаём на каждый span свой:
 * у AnimatedImageDrawable один callback, и общий на две видимые ячейки
 * означал бы, что анимируется только последняя.
 */
object EmoteCache {

    // 6 потоков: при открытии пикера сетка просит сотни картинок сразу, и по
    // три штуки они подтягивались заметно долго. Приоритет держим низким —
    // качать эмоуты не должно мешать отрисовке самого ВК.
    private val io = Executors.newFixedThreadPool(6) { r ->
        Thread(r, "vk7tv-img").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    // Массовую предзагрузку пака ведём отдельным маленьким пулом, чтобы сотни
    // качающихся картинок набора не забивали очередь перед теми, что прямо
    // сейчас нужны пикеру и чату.
    private val preloadIo = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "vk7tv-preload").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    // Картинки лежат в постоянной папке (filesDir) — переживают офлайн и очистку
    // кэша ВК. Чтобы папка не разрослась до гигабайтов, держим свой потолок: как
    // вышли за DISK_CAP — вытесняем давно не тронутые файлы (LRU по времени
    // файла) до DISK_TRIM_TO.
    private const val DISK_CAP = 300L * 1024 * 1024
    private const val DISK_TRIM_TO = 240L * 1024 * 1024

    private val diskLock = Any()

    @Volatile
    private var diskBytes = -1L // -1 = ещё не посчитано

    private lateinit var dir: File

    private val bytes = object : LruCache<String, ByteArray>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    // url-ключ -> все, кто ждёт эту картинку. Раньше тут был просто Set, и
    // колбэк на готовность регистрировал ТОЛЬКО первый, кто попросил url:
    // если тот же эмоут одновременно просили чат и пикер (или несколько
    // ячеек), будили одного, а остальные висели текстом/пустой ячейкой до
    // перезахода. Теперь будим всех, кто ждал.
    private val waiters = HashMap<String, MutableList<() -> Unit>>()
    private val failed = Collections.synchronizedSet(HashSet<String>())

    fun init(cacheDir: File) {
        dir = File(cacheDir, "img").apply { mkdirs() }
    }

    /**
     * Готовый Drawable или null. Если картинки ещё нет — ставит её в очередь
     * и дёргает [onReady] после загрузки. Слово до этого момента остаётся
     * текстом: лучше показать код, чем дырку в сообщении.
     */
    fun drawable(url: String, onReady: () -> Unit): Drawable? {
        val key = keyOf(url)
        bytes.get(key)?.let { return decode(it) }
        if (failed.contains(key)) return null

        val onDisk = File(dir, key)
        if (onDisk.isFile) {
            // LRU дискового кэша: освежаем время файла, чтобы часто нужные
            // картинки не вытеснялись первыми при подрезке
            L.safe("освежить $key") { onDisk.setLastModified(System.currentTimeMillis()) }
            return L.safe("чтение $key") {
                val data = onDisk.readBytes()
                bytes.put(key, data)
                decode(data)
            }
        }

        // становимся в очередь ожидающих; качает только тот, кто пришёл первым
        val first = synchronized(waiters) {
            val list = waiters.getOrPut(key) { ArrayList(2) }
            val wasEmpty = list.isEmpty()
            list.add(onReady)
            wasEmpty
        }
        if (first) {
            io.execute {
                try {
                    val data = Net.bytes(url)
                    File(dir, key).writeBytes(data)
                    bytes.put(key, data)
                    accountAndTrim(data.size)
                    wake(key)
                } catch (t: Throwable) {
                    failed.add(key)
                    // будить не надо: повторный рендер упрётся в failed и
                    // честно оставит текст, а список ожидающих просто сбрасываем
                    synchronized(waiters) { waiters.remove(key) }
                    L.v("не скачалось $url: $t")
                }
            }
        }
        return null
    }

    /**
     * Заранее скачать картинки набора, чтобы пак был виден офлайн: один раз с
     * VPN — дальше без сети. Уже лежащие пропускаем; в память не кладём, чтобы
     * предзагрузка не вытесняла горячие картинки из LruCache.
     */
    fun preload(urls: Collection<String>) {
        for (url in urls) {
            val key = keyOf(url)
            if (bytes.get(key) != null || File(dir, key).isFile) continue
            preloadIo.execute {
                L.safe("предзагрузка") {
                    val f = File(dir, key)
                    if (f.isFile) return@safe
                    val data = Net.bytes(url)
                    f.writeBytes(data)
                    accountAndTrim(data.size)
                    wake(key) // вдруг эту картинку уже кто-то ждёт на экране
                }
            }
        }
    }

    /** Учли новый файл; вышли за потолок — подрезали давние. */
    private fun accountAndTrim(added: Int) {
        ensureAccounted()
        synchronized(diskLock) { diskBytes += added }
        trimDisk()
    }

    /** Разовый подсчёт занятого на диске — лениво, вне UI-потока. */
    private fun ensureAccounted() {
        if (diskBytes >= 0) return
        synchronized(diskLock) {
            if (diskBytes >= 0) return
            var sum = 0L
            dir.listFiles()?.forEach { sum += it.length() }
            diskBytes = sum
        }
    }

    /** Вытесняем самые давние файлы, пока не уложимся в DISK_TRIM_TO. */
    private fun trimDisk() {
        if (diskBytes <= DISK_CAP) return
        synchronized(diskLock) {
            if (diskBytes <= DISK_CAP) return
            val files = dir.listFiles() ?: return
            files.sortBy { it.lastModified() } // давние — первыми
            var i = 0
            while (diskBytes > DISK_TRIM_TO && i < files.size) {
                val f = files[i]; i++
                val len = f.length()
                if (L.safe("удаление картинки") { f.delete() } == true) diskBytes -= len
            }
            L.i("кэш картинок подрезан до ${diskBytes / (1024 * 1024)} МБ")
        }
    }

    /** Сколько сейчас занято кэшем картинок на диске, байт. Считать вне UI. */
    fun usageBytes(): Long {
        var sum = 0L
        L.safe("размер кэша") { dir.listFiles()?.forEach { sum += it.length() } }
        return sum
    }

    /**
     * Стереть все скачанные картинки (кнопка «очистить» в настройках).
     * Наборы не трогаем — картинки до-качаются при показе. Возвращает,
     * сколько байт освободили.
     */
    fun clear(): Long {
        synchronized(diskLock) {
            var freed = 0L
            L.safe("очистка кэша") {
                dir.listFiles()?.forEach { f ->
                    val len = f.length()
                    if (f.delete()) freed += len
                }
            }
            diskBytes = 0
            bytes.evictAll()
            failed.clear()
            return freed
        }
    }

    /** Картинка готова — будим всех, кто её ждал, и очищаем очередь. */
    private fun wake(key: String) {
        val list = synchronized(waiters) { waiters.remove(key) } ?: return
        for (cb in list) L.safe("колбэк картинки") { cb() }
    }

    private fun decode(data: ByteArray): Drawable? = L.safe("декод картинки") {
        val src = ImageDecoder.createSource(ByteBuffer.wrap(data))
        val d = ImageDecoder.decodeDrawable(src) { dec, _, _ ->
            dec.isMutableRequired = false
            dec.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        // анимированные webp с 7TV система тянет сама, свой декодер не нужен
        (d as? AnimatedImageDrawable)?.repeatCount = AnimatedImageDrawable.REPEAT_INFINITE
        d
    }

    private fun keyOf(url: String): String =
        url.substringAfter("/emote/", url).replace('/', '_').ifEmpty { url.hashCode().toString() }
}
