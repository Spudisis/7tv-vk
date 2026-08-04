package com.vk7tv.module

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Сеть идёт из процесса ВК — у него уже есть INTERNET, своих прав не надо. */
object Net {

    /**
     * Не-200 от сервера. Код доступен вызывающему: по нему можно дать понятный
     * текст (404 набора — «не найден», прочее — «сервис недоступен»), а не
     * показывать пользователю сырое «HTTP 500».
     */
    class HttpException(val code: Int, val url: String) : RuntimeException("HTTP $code $url")

    // Повторяем один раз на сетевой сбой (таймаут, обрыв соединения): на
    // мобильной связи одиночные блипы — обычное дело, и без повтора добавление
    // набора падало с «timeout». Не-200 (404 и прочее) НЕ повторяем — это
    // определённый ответ сервера, а не блип.
    private const val ATTEMPTS = 2

    fun get(url: String): String = retry {
        val conn = open(url)
        ok(conn, url)
        conn.inputStream.use { it.bufferedReader().readText() }
    }

    fun bytes(url: String): ByteArray = retry {
        val conn = open(url)
        ok(conn, url)
        // без disconnect(): соединение возвращается в пул и следующая картинка
        // не платит заново за TCP + TLS-рукопожатие к cdn.7tv.app
        conn.inputStream.use { it.readBytes() }
    }

    fun postJson(url: String, body: String): String = retry {
        val conn = open(url)
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toByteArray()) }
        ok(conn, url)
        conn.inputStream.use { it.bufferedReader().readText() }
    }

    private fun <T> retry(block: () -> T): T {
        var last: IOException? = null
        repeat(ATTEMPTS) { i ->
            try {
                return block()
            } catch (e: IOException) { // таймаут/обрыв — стоит повторить
                last = e
                if (i < ATTEMPTS - 1) try {
                    Thread.sleep(400)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
        throw last ?: IOException("нет ответа")
    }

    /** 200 или исключение; поток ошибки тоже дренируем, чтобы сокет ушёл в пул. */
    private fun ok(conn: HttpURLConnection, url: String) {
        if (conn.responseCode != 200) {
            L.safe("сброс ошибки") { conn.errorStream?.use { it.readBytes() } }
            throw HttpException(conn.responseCode, url)
        }
    }

    private fun open(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("User-Agent", "VK7TV-module")
        return conn
    }
}
