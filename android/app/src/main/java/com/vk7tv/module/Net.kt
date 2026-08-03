package com.vk7tv.module

import java.net.HttpURLConnection
import java.net.URL

/** Сеть идёт из процесса ВК — у него уже есть INTERNET, своих прав не надо. */
object Net {

    fun get(url: String): String {
        val conn = open(url)
        ok(conn, url)
        return conn.inputStream.use { it.bufferedReader().readText() }
    }

    fun bytes(url: String): ByteArray {
        val conn = open(url)
        ok(conn, url)
        // НЕ вызываем disconnect(): он закрывает сокет, и следующая картинка
        // снова платит за TCP + TLS-рукопожатие к cdn.7tv.app. Именно это, а не
        // размер файлов, тормозило загрузку пачки эмоутов. Достаточно дочитать
        // поток и закрыть — соединение вернётся в пул (HTTP keep-alive).
        return conn.inputStream.use { it.readBytes() }
    }

    fun postJson(url: String, body: String): String {
        val conn = open(url)
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toByteArray()) }
        ok(conn, url)
        return conn.inputStream.use { it.bufferedReader().readText() }
    }

    /** 200 или исключение; поток ошибки тоже дренируем, чтобы сокет ушёл в пул. */
    private fun ok(conn: HttpURLConnection, url: String) {
        if (conn.responseCode != 200) {
            L.safe("сброс ошибки") { conn.errorStream?.use { it.readBytes() } }
            throw RuntimeException("HTTP ${conn.responseCode} $url")
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
