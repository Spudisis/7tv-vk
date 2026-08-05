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
 *
 * Про себя модуль без включённой «Диагностики» на экран не пишет: в журнал
 * всегда, тостом — только когда о нём спросили. Исключение — [warn]: почему
 * эмоутов нет прямо сейчас (7tv.io недоступен, аварийный режим). Без этого
 * пустой пикер выглядит как поломка модуля.
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

    /**
     * Важное — вылет в прошлый раз, аварийный режим. Раньше показывалось
     * всегда, мимо галки; теперь тоже только с диагностикой: всплывашка при
     * каждом запуске мешает пользоваться клиентом, а оба состояния видно
     * в настройках — блок «АВАРИЙНЫЙ РЕЖИМ» и стек вылета внизу. В журнал
     * строка идёт в любом случае.
     */
    fun alert(msg: String) {
        L.i(msg)
        if (!Config.diag) return
        val c = ctx ?: return
        main.post {
            L.safe("тост") { Toast.makeText(c, "VK7TV: $msg", Toast.LENGTH_LONG).show() }
        }
    }

    /**
     * Показать всегда, мимо галки. Только то, из-за чего эмоутов нет прямо
     * сейчас: 7tv.io не ответил, наборы не приехали, включился аварийный
     * режим. Остальное про модуль — [note] и [alert], они молчат без
     * диагностики.
     */
    fun warn(msg: String) {
        L.i(msg)
        val c = ctx ?: return
        main.post {
            L.safe("тост") { Toast.makeText(c, "VK7TV: $msg", Toast.LENGTH_LONG).show() }
        }
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
