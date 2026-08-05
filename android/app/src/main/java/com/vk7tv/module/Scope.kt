package com.vk7tv.module

import android.view.View
import android.widget.TextView
import java.util.WeakHashMap

/**
 * Ограничение области подмены. По умолчанию (без галки «Показывать везде»)
 * коды превращаем в картинки в переписке — в сообщениях открытого диалога и
 * в превью строк списка чатов, — а ленту, комментарии, названия групп и
 * профили оставляем как есть.
 *
 * Экран не опознаём по классам ВК (они обфусцированы) — идём по именам
 * ресурсов id вьюх-родителей: у модуля переписки ВК/Sova они содержат
 * узнаваемые куски (vkim, msg, dialog, chat, bubble…), а имена ресурсов
 * переживают обфускацию кода. Той же уловкой пользуется [Service].
 *
 * Кроме разрешающих кусков есть запрещающие — обвязка экрана: шапка чата и
 * вкладки внизу. Они лежат внутри переписки и по [ALLOW] проходили бы, но
 * текст там не пользовательский, а картинка ломает разметку клиента.
 * Счётчики отсекаются рядом, по [Service.isCounterView], — и тоже только
 * без галки «Показывать везде».
 */
object Scope {

    // setText зовётся часто, а положение вьюхи в иерархии стабильно: ячейки
    // списка ВК переиспользует, но остаются они в том же контейнере. Поэтому
    // ответ кэшируем по самой вьюхе. Кэшируем только у прикреплённых: до
    // attach цепочки родителей ещё нет, и «не мессенджер» запомнилось бы
    // навсегда, хотя вьюху вот-вот вставят в список чата.
    private val cache = WeakHashMap<View, Boolean>()

    private val ALLOW = setOf(
        "vkim", "im", "msg", "msgs", "message", "messages", "messaging",
        "dialog", "dialogs", "chat", "chats", "conversation", "conversations",
        "peer", "bubble", "history",
    )

    // Перебивает ALLOW на любой глубине: шапка чата и вкладка «Сообщения»
    // лежат внутри вьюх с разрешающими id, и без перевеса запрета картинка
    // вставала в подпись «N участника» и поверх иконки вкладки.
    // Список чатов сюда не входит намеренно: превью последнего сообщения —
    // текст пользователя, там подмена нужна.
    private val BLOCK = setOf(
        "toolbar", "appbar", "actionbar", "header", "headers",
        "tab", "tabs", "tabbar", "navbar", "bottomnavigation",
        "participants", "members",
    )

    private val SPLIT = Regex("[^a-z0-9]+")
    private val CAMEL = Regex("([a-z0-9])([A-Z])")

    private const val MAX_DEPTH = 16

    // Сколько разных цепочек показать в журнале под диагностикой: их немного,
    // но одна и та же повторяется на каждое сообщение.
    private const val MAX_LOGGED = 40
    private val logged = HashSet<String>()

    fun inMessenger(tv: TextView): Boolean {
        synchronized(cache) { cache[tv] }?.let { return it }
        val result = compute(tv)
        if (tv.isAttachedToWindow) synchronized(cache) { cache[tv] = result }
        return result
    }

    private enum class Kind { NEITHER, ALLOWED, BLOCKED }

    private fun compute(tv: TextView): Boolean {
        var node: View? = tv
        var depth = 0
        var allowed = false
        while (node != null && depth < MAX_DEPTH) {
            when (kindOf(node)) {
                Kind.BLOCKED -> return false
                Kind.ALLOWED -> allowed = true
                Kind.NEITHER -> Unit
            }
            node = node.parent as? View
            depth++
        }
        return allowed
    }

    private fun kindOf(v: View): Kind {
        val id = v.id
        if (id == View.NO_ID) return Kind.NEITHER
        val name = L.safe("имя ресурса") { v.resources.getResourceEntryName(id) } ?: return Kind.NEITHER
        // «vkimMsgList» → vkim msg list, «vkim_dialogs» → vkim dialogs;
        // режем по границам, чтобы «time» не считалось за «im»
        val tokens = CAMEL.replace(name) { "${it.groupValues[1]} ${it.groupValues[2]}" }
            .lowercase()
            .split(SPLIT)
        var kind = Kind.NEITHER
        for (t in tokens) {
            if (t in BLOCK) return Kind.BLOCKED
            if (t in ALLOW) kind = Kind.ALLOWED
        }
        return kind
    }

    /**
     * Под диагностикой: куда картинка встала. По этой строке видно настоящие
     * id клиента, если эмоуты лезут не туда, — и в [BLOCK] дописывается
     * недостающий кусок. Каждая цепочка пишется один раз.
     */
    fun noteReplaced(tv: TextView) {
        if (!Config.diag) return
        L.safe("журнал подмены") {
            val chain = describe(tv)
            val fresh = synchronized(logged) { logged.size < MAX_LOGGED && logged.add(chain) }
            if (fresh) L.i("подмена в: $chain")
        }
    }

    /**
     * Цепочка имён ресурсов от вьюхи вверх — для диагностики. Если у знакомого
     * клиента эмоуты в чате не подменяются, по этой строке видно настоящие id
     * переписки, и в [ALLOW] можно дописать недостающий кусок.
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
