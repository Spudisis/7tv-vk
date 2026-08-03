package com.vk7tv.module

import java.net.HttpURLConnection
import java.net.URL

/** Сеть идёт из процесса ВК — у него уже есть INTERNET, своих прав не надо. */
object Net {

    fun get(url: String): String {
        val conn = open(url)
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode} $url")
            return conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }

    fun bytes(url: String): ByteArray {
        val conn = open(url)
        try {
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode}")
            return conn.inputStream.readBytes()
        } finally {
            conn.disconnect()
        }
    }

    fun postJson(url: String, body: String): String {
        val conn = open(url)
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            if (conn.responseCode != 200) throw RuntimeException("HTTP ${conn.responseCode} $url")
            return conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
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
