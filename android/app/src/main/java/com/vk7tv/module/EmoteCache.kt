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
