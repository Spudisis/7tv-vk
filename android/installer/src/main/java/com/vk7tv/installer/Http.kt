package com.vk7tv.installer

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Мелкий HTTP без зависимостей: и API GitHub, и скачивание APK — всё отсюда. */
object Http {

    private fun open(url: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            // GitHub отвергает запросы без User-Agent.
            setRequestProperty("User-Agent", "vk7tv-installer")
            instanceFollowRedirects = true
        }

    fun getString(url: String): String {
        val c = open(url)
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (c.responseCode / 100 != 2) throw RuntimeException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    /** Качает в файл; возвращает его же. Прогресс — в onProgress(скачано, всего|-1). */
    fun download(url: String, dst: File, onProgress: (Long, Long) -> Unit = { _, _ -> }): File {
        val c = open(url)
        try {
            if (c.responseCode / 100 != 2) throw RuntimeException("HTTP ${c.responseCode}")
            val total = c.contentLengthLong
            dst.outputStream().use { out ->
                c.inputStream.use { inp ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        onProgress(done, total)
                    }
                }
            }
            return dst
        } finally {
            c.disconnect()
        }
    }
}
