package com.vk7tv.module

import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.UnderlineSpan
import android.widget.EditText
import android.widget.TextView
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Разбор текста и сборка Spannable с картинками.
 * Правила ровно те же, что в вебе: эмоут — отдельное «слово», разделённое
 * пробелами, с учётом регистра; zero-width после обычного накладывается
 * поверх него, а пробел между ними съедается.
 */
object Replacer {

    // Сколько чужих эмоутов рисовать картинками в одном сообщении. Дальше
    // слово остаётся текстом: сообщение из полусотни незнакомых кодов не должно
    // разом просить полсотни декодирований картинок.
    private const val MAX_PREVIEWS = 3

    private val main = Handler(Looper.getMainLooper())

    // ждём картинку — перерисовываем вьюху один раз, а не на каждый эмоут
    private val pending = WeakHashMap<TextView, Boolean>()

    // Вьюхи, через которые уже прошёл текст. Нужны, чтобы перерисовать то,
    // что ВК успел нарисовать до загрузки наборов: иначе в открытом диалоге
    // эмоуты не появятся, пока из него не выйдешь и не зайдёшь обратно.
    // Слабые ключи — записи умирают вместе с самими вьюхами.
    private val seenViews = WeakHashMap<TextView, Boolean>()

    @Volatile
    var seen = 0L
        private set

    @Volatile
    var replaced = 0L
        private set

    fun apply(tv: TextView, text: CharSequence): CharSequence? {
        if (Config.safeMode) return null // аварийный режим — текст не трогаем
        if (!Config.enabled || !Emotes.ready) return null
        if (tv is EditText) return null // поле ввода не трогаем никогда
        if (text.isEmpty()) return null
        seen++

        // уже наша работа — второй раз не заходим
        if (text is Spanned && text.getSpans(0, text.length, Vk7tvMark::class.java).isNotEmpty()) {
            return null
        }
        if (Service.isServiceText(text)) return null
        if (Service.isServiceView(tv)) return null
        synchronized(seenViews) { seenViews[tv] = true }

        // Счётчик (непрочитанные, бейдж вкладки, «N участника») — часть той же
        // области: без галки «Показывать везде» картинка вместо числа ломает
        // разметку, с галкой человек этого и просит.
        if (!Config.everywhere && Service.isCounterView(tv, text)) return null

        // По умолчанию подменяем только в переписке; галка «Показывать везде»
        // снимает ограничение. Вне переписки текст не трогаем. Вьюху всё равно
        // записали в seenViews выше — переключишь настройку, и rerenderAll
        // перерисует и её. Проверка кэшируется по вьюхе — на частый setText
        // почти бесплатна.
        if (!Config.everywhere && !Scope.inMessenger(tv)) {
            // под диагностикой: если тут всё же был эмоут — покажем цепочку id
            // родителей, по ней подгоняется список токенов Scope под клиента
            if (Config.diag && scan(text).hits != null) {
                L.v("эмоут вне мессенджера пропущен: ${Scope.describe(tv)}")
            }
            return null
        }

        val found = scan(text)
        val hits = found.hits
        if (hits == null && found.sugs == null) return null

        var missing = false
        var out: SpannableStringBuilder? = null
        var lastEnd = -1
        var lastStack: StackDrawable? = null
        val cb = ViewCallback(tv)

        for (h in hits.orEmpty()) {
            val d = EmoteCache.drawable(h.emote.url) { onImageReady(tv, text) }
            if (d == null) {
                missing = true
                lastEnd = -1
                lastStack = null
                continue
            }
            val sb = out ?: SpannableStringBuilder(text).also { out = it }

            // zero-width сразу за эмоутом — кладём поверх и схлопываем слово
            if (h.emote.zeroWidth && lastStack != null && onlySpaces(text, lastEnd, h.start)) {
                lastStack.add(d)
                sb.setSpan(ZeroWidthSpan(), lastEnd, h.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                lastEnd = h.end
                continue
            }

            val stack = StackDrawable(d)
            stack.callback = cb
            sb.setSpan(EmoteSpan(stack), h.start, h.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            lastEnd = h.end
            lastStack = stack
        }

        // Предложения: слово из чужого набора показываем картинкой с полоской
        // снизу, а если картинки ещё нет — подсвечиваем цветом, как раньше.
        //
        // Нажимаемым слово не делаем. Пробовали и своим разбором касаний, и
        // ClickableSpan: ВК ловит нажатие по сообщению раньше нас и открывает
        // своё меню («ответить», «переслать») поверх нашего окошка — оба разом.
        // Набор подключается из пикера, строкой «МОЖНО ПОДКЛЮЧИТЬ».
        found.sugs?.let { list ->
            val sb = out ?: SpannableStringBuilder(text).also { out = it }
            var shown = 0
            for (s in list) {
                val d = if (Config.suggestPreview && shown < MAX_PREVIEWS) {
                    EmoteCache.drawable(s.hit.url) { onImageReady(tv, text) }
                } else {
                    null
                }
                if (d != null) {
                    shown++
                    val stack = StackDrawable(d)
                    stack.callback = cb
                    // ник рядом с картинкой: слово целиком заменено, и без него
                    // не видно, чей это набор
                    val span = SuggestEmoteSpan(stack, s.hit.ref.slug)
                    sb.setSpan(span, s.start, s.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                } else {
                    if (Config.suggestPreview && shown < MAX_PREVIEWS) missing = true
                    sb.setSpan(ForegroundColorSpan(Ui.ACCENT), s.start, s.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    sb.setSpan(UnderlineSpan(), s.start, s.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }

        // Отметку «ждём картинку» ставим ДО раннего выхода. Иначе, когда
        // в сообщении не закэшировано вообще ничего, out остаётся null,
        // мы уходим по return, и скачанная картинка потом никого не находит:
        // эмоут остаётся текстом навсегда, пока вьюху не перерисуют извне.
        if (missing) onImageWanted(tv)

        val result = out ?: return null
        // оригинал носим с собой: по нему перерисуемся, когда докачается картинка
        result.setSpan(Vk7tvMark(text), 0, result.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        replaced++
        Scope.noteReplaced(tv) // под диагностикой: в какой вьюхе встала картинка
        return result
    }

    private class Hit(val start: Int, val end: Int, val emote: Emote)

    /** Слово из набора, которого у нас нет, — и что про него известно. */
    private class Sug(val start: Int, val end: Int, val word: String, val hit: Suggest.Hit)

    /** Найденное в тексте: свои эмоуты и слова из чужих наборов. */
    private class Found(var hits: ArrayList<Hit>? = null, var sugs: ArrayList<Sug>? = null)

    /** Проход по словам без регулярок: setText зовётся часто, аллокации жалко. */
    private fun scan(text: CharSequence): Found {
        val found = Found()
        val n = text.length
        var i = 0
        while (i < n) {
            while (i < n && text[i].isWhitespace()) i++
            if (i >= n) break
            val start = i
            while (i < n && !text[i].isWhitespace()) i++
            val end = i

            if (Emotes.mayBe(text, start, end)) {
                val em = Emotes.get(text.subSequence(start, end).toString())
                if (em != null) {
                    (found.hits ?: ArrayList<Hit>(4).also { found.hits = it })
                        .add(Hit(start, end, em))
                    continue
                }
            }

            // эмоута нет, но слово похоже на «имя_ник» — вдруг у собеседника
            // подключён набор, которого нет у нас
            if (!Config.suggest) continue
            if (!Suggest.looksLike(text, start, end)) continue
            val word = text.subSequence(start, end).toString()
            val hit = Suggest.hitOf(word)
            if (hit != null) {
                (found.sugs ?: ArrayList<Sug>(4).also { found.sugs = it })
                    .add(Sug(start, end, word, hit))
            } else {
                Suggest.consider(word)
            }
        }
        return found
    }

    private fun onlySpaces(text: CharSequence, from: Int, to: Int): Boolean {
        if (from < 0 || to > text.length || from > to) return false
        for (i in from until to) if (!text[i].isWhitespace()) return false
        return true
    }

    /**
     * Перерисовать всё, что сейчас на экране, — после загрузки или смены наборов.
     *
     * Берём текущий текст вьюхи, а не запомненный: ВК переиспользует ячейки
     * списка, и старый текст мог бы уехать в чужое сообщение.
     */
    fun rerenderAll() {
        val views = synchronized(seenViews) { ArrayList(seenViews.keys) }
        if (views.isEmpty()) return
        main.post {
            var n = 0
            for (tv in views) {
                if (!tv.isAttachedToWindow) continue
                L.safe("перерисовка") {
                    val cur = tv.text ?: return@safe
                    val mark = (cur as? Spanned)
                        ?.getSpans(0, cur.length, Vk7tvMark::class.java)
                        ?.firstOrNull()
                    tv.text = mark?.original ?: cur
                    n++
                }
            }
            L.v("перерисовано вьюх: $n")
        }
    }

    private fun onImageWanted(tv: TextView) {
        synchronized(pending) { pending[tv] = true }
    }

    /** Картинка приехала — перерисовываем вьюху оригинальным текстом. */
    private fun onImageReady(tv: TextView, original: CharSequence) {
        val ref = WeakReference(tv)
        main.post {
            val v = ref.get() ?: return@post
            val wanted = synchronized(pending) { pending.remove(v) } ?: return@post
            if (!wanted) return@post
            L.safe("перерисовка") { v.text = original }
        }
    }
}
