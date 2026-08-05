package com.vk7tv.module

import android.view.View
import android.widget.TextView

/**
 * Служебные подписи ВК — время сообщения, «(ред.)», дата — не текст
 * пользователя, и трогать их нельзя: в наборах попадаются эмоуты с именами
 * вроде «20:00», и без этой проверки время сообщения превращается в картинку.
 * Ровно та же защита, что в content.js, только опознаём вьюху не по классам
 * CSS, а по имени ресурса её id — оно переживает обфускацию кода.
 *
 * Отдельно опознаются счётчики ([isCounterView]) — непрочитанные, бейдж
 * вкладки, «N участника». Их закрывает не эта защита, а область подмены:
 * с галкой «Показывать везде» картинки идут и туда.
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

    // Числа в обвязке: непрочитанные в списке чатов, бейдж на вкладке
    // «Сообщения», «N участника» в шапке. Текст там — число, а в наборах есть
    // эмоуты с числовыми именами («67»), и картинка вставала вместо счётчика.
    private val COUNTER_TOKENS = setOf(
        "counter", "counters", "count", "counts", "badge", "badges",
        "unread", "unseen",
    )

    private val COUNT_TEXT = Regex("^\\d{1,4}([.,]\\d)?\\s*[кkмm]?\\s*\\+?$", RegexOption.IGNORE_CASE)

    private const val COUNTER_DEPTH = 3

    private val SPLIT = Regex("[^a-z]+")
    private val CAMEL = Regex("([a-z0-9])([A-Z])")

    /** Подпись целиком: «20:00», «(ред.)». Внутри фразы эмоут рисуем как обычно. */
    fun isServiceText(t: CharSequence): Boolean {
        if (t.length > 24) return false
        return SERVICE_TEXT.matches(t.trim())
    }

    fun isServiceView(tv: TextView): Boolean = hasToken(tv, TOKENS)

    /**
     * Счётчик: непрочитанные, бейдж вкладки, «N участника».
     *
     * id самой вьюхи — сигнал точный, ему верим как есть. Родителей смотрим
     * тоже (у текста бейджа своего id часто нет, он есть у контейнера), но там
     * дополнительно требуем, чтобы текст был похож на счётчик: иначе под
     * проверку попало бы обычное сообщение, лежащее внутри чего-нибудь с
     * «count» в имени.
     */
    fun isCounterView(tv: TextView, text: CharSequence): Boolean {
        if (hasToken(tv, COUNTER_TOKENS)) return true
        if (!looksLikeCount(text)) return false
        var node: View? = tv.parent as? View
        var depth = 0
        while (node != null && depth < COUNTER_DEPTH) {
            if (hasToken(node, COUNTER_TOKENS)) return true
            node = node.parent as? View
            depth++
        }
        return false
    }

    /** «7», «99+», «1,2К» — число, а не текст человека. */
    private fun looksLikeCount(t: CharSequence): Boolean =
        t.length <= 8 && COUNT_TEXT.matches(t)

    private fun hasToken(v: View, set: Set<String>): Boolean {
        val id = v.id
        if (id == View.NO_ID) return false
        val name = L.safe("имя ресурса") { v.resources.getResourceEntryName(id) } ?: return false
        // «messageTime» → message time, «im_mess_time» → im mess time;
        // при этом «update» словом «date» не считается — режем по границам
        val tokens = CAMEL.replace(name) { "${it.groupValues[1]} ${it.groupValues[2]}" }
            .lowercase()
            .split(SPLIT)
        for (t in tokens) if (t in set) return true
        return false
    }
}
