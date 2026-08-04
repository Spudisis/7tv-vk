package com.vk7tv.module

import android.view.View
import android.widget.TextView
import java.util.WeakHashMap

/**
 * Ограничение области подмены. Когда включено «эмоуты только в мессенджере»,
 * коды превращаем в картинки лишь в переписке — список диалогов и открытый
 * чат, — а ленту, комментарии, названия групп, профили и прочее оставляем
 * как есть.
 *
 * Экран не опознаём по классам ВК (они обфусцированы) — идём по именам
 * ресурсов id вьюх-родителей: у модуля переписки ВК/Sova они содержат
 * узнаваемые куски (vkim, msg, dialog, chat, bubble…), а имена ресурсов
 * переживают обфускацию кода. Той же уловкой пользуется [Service].
 */
object Scope {

    // setText зовётся часто, а положение вьюхи в иерархии стабильно: ячейки
    // списка ВК переиспользует, но остаются они в том же контейнере. Поэтому
    // ответ кэшируем по самой вьюхе. Кэшируем только у прикреплённых: до
    // attach цепочки родителей ещё нет, и «не мессенджер» запомнилось бы
    // навсегда, хотя вьюху вот-вот вставят в список чата.
    private val cache = WeakHashMap<View, Boolean>()

    private val TOKENS = setOf(
        "vkim", "im", "msg", "msgs", "message", "messages", "messaging",
        "dialog", "dialogs", "chat", "chats", "conversation", "conversations",
        "peer", "bubble", "history",
    )
    private val SPLIT = Regex("[^a-z0-9]+")
    private val CAMEL = Regex("([a-z0-9])([A-Z])")

    private const val MAX_DEPTH = 16

    fun inMessenger(tv: TextView): Boolean {
        synchronized(cache) { cache[tv] }?.let { return it }
        val result = compute(tv)
        if (tv.isAttachedToWindow) synchronized(cache) { cache[tv] = result }
        return result
    }

    private fun compute(tv: TextView): Boolean {
        var node: View? = tv
        var depth = 0
        while (node != null && depth < MAX_DEPTH) {
            if (isMessengerId(node)) return true
            node = node.parent as? View
            depth++
        }
        return false
    }

    private fun isMessengerId(v: View): Boolean {
        val id = v.id
        if (id == View.NO_ID) return false
        val name = L.safe("имя ресурса") { v.resources.getResourceEntryName(id) } ?: return false
        // «vkimMsgList» → vkim msg list, «vkim_dialogs» → vkim dialogs;
        // режем по границам, чтобы «time» не считалось за «im»
        val tokens = CAMEL.replace(name) { "${it.groupValues[1]} ${it.groupValues[2]}" }
            .lowercase()
            .split(SPLIT)
        for (t in tokens) if (t in TOKENS) return true
        return false
    }

    /**
     * Цепочка имён ресурсов от вьюхи вверх — для диагностики. Если у знакомого
     * клиента эмоуты в чате не подменяются, по этой строке видно настоящие id
     * переписки, и в [TOKENS] можно дописать недостающий кусок.
     */
    fun describe(tv: TextView): String {
        val sb = StringBuilder()
        var node: View? = tv
        var depth = 0
        while (node != null && depth < MAX_DEPTH) {
            val n = node
            val id = n.id
            val name = if (id == View.NO_ID) "—"
            else L.safe("имя ресурса") { n.resources.getResourceEntryName(id) } ?: "?"
            if (sb.isNotEmpty()) sb.append(" < ")
            sb.append(name)
            node = n.parent as? View
            depth++
        }
        return sb.toString()
    }
}
