package com.vk7tv.module

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * Диагностика на экране.
 *
 * Достать журнал с телефона — отдельный квест: нужен либо кабель, либо
 * беспроводная отладка (которую ломает VPN на компьютере), либо приложение
 * с доступом к logcat, которое само просит настройку с ПК. Поэтому модуль
 * рассказывает о себе тостами прямо в ВК: видно сразу и без инструментов.
 *
 * Сообщения, пришедшие до появления контекста, копятся и показываются
 * все разом — иначе самое интересное (загрузился ли модуль вообще)
 * терялось бы раньше, чем есть куда его показать.
 */
object Diag {

    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayList<String>()

    @Volatile
    private var ctx: Context? = null

    fun attach(c: Context) {
        ctx = c.applicationContext
        main.post { flush() }
    }

    fun note(msg: String) {
        L.i(msg)
        synchronized(pending) { pending.add(msg) }
        main.post { flush() }
    }

    private fun flush() {
        val c = ctx ?: return
        val list = synchronized(pending) {
            val copy = ArrayList(pending)
            pending.clear()
            copy
        }
        if (!Config.diag) return
        for (m in list) {
            L.safe("тост") { Toast.makeText(c, "VK7TV: $m", Toast.LENGTH_LONG).show() }
        }
    }
}
