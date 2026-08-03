package com.vk7tv.module

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.util.LruCache
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
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

    private val io = Executors.newFixedThreadPool(3) { r ->
        Thread(r, "vk7tv-img").apply { isDaemon = true; priority = Thread.MIN_PRIORITY }
    }

    private lateinit var dir: File

    private val bytes = object : LruCache<String, ByteArray>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: ByteArray) = value.size
    }

    private val loading = Collections.synchronizedSet(HashSet<String>())
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

        if (loading.add(key)) {
            io.execute {
                try {
                    val data = download(url)
                    File(dir, key).writeBytes(data)
                    bytes.put(key, data)
                    onReady()
                } catch (t: Throwable) {
                    failed.add(key)
                    L.v("не скачалось $url: $t")
                } finally {
                    loading.remove(key)
                }
            }
        }
        return null
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

    private fun download(url: String): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "VK7TV-module")
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode}")
            return conn.inputStream.readBytes()
        } finally {
            conn.disconnect()
        }
    }

    private fun keyOf(url: String): String =
        url.substringAfter("/emote/", url).replace('/', '_').ifEmpty { url.hashCode().toString() }
}
