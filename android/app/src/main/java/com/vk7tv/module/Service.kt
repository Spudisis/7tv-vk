package com.vk7tv.module

import android.view.View
import android.widget.TextView

/**
 * Служебные подписи ВК — время сообщения, «(ред.)», дата — не текст
 * пользователя, и трогать их нельзя: в наборах попадаются эмоуты с именами
 * вроде «20:00», и без этой проверки время сообщения превращается в картинку.
 * Ровно та же защита, что в content.js, только опознаём вьюху не по классам
 * CSS, а по имени ресурса её id — оно переживает обфускацию кода.
 */
object Service {

    private val SERVICE_TEXT = Regex(
        "^\\(?\\s*(?:\\d{1,2}:\\d{2}(?::\\d{2})?|ред\\.?|изменено|отредактировано|edited)\\s*\\)?$",
        RegexOption.IGNORE_CASE,
    )

    private val TOKENS = setOf(
        "time", "times", "timestamp", "timestamps", "date", "dates", "datetime",
        "clock", "ago", "online", "offline", "seen", "lastseen",
        "edited", "edit", "changed",
    )

    private val SPLIT = Regex("[^a-z]+")
    private val CAMEL = Regex("([a-z0-9])([A-Z])")

    /** Подпись целиком: «20:00», «(ред.)». Внутри фразы эмоут рисуем как обычно. */
    fun isServiceText(t: CharSequence): Boolean {
        if (t.length > 24) return false
        return SERVICE_TEXT.matches(t.trim())
    }

    fun isServiceView(tv: TextView): Boolean {
        val id = tv.id
        if (id == View.NO_ID) return false
        val name = L.safe("имя ресурса") { tv.resources.getResourceEntryName(id) } ?: return false
        // «messageTime» → message time, «im_mess_time» → im mess time;
        // при этом «update» словом «date» не считается — режем по границам
        val tokens = CAMEL.replace(name) { "${it.groupValues[1]} ${it.groupValues[2]}" }
            .lowercase()
            .split(SPLIT)
        for (t in tokens) if (t in TOKENS) return true
        return false
    }
}
