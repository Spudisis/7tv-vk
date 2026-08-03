package com.vk7tv.module

import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spanned
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

    private val main = Handler(Looper.getMainLooper())

    // ждём картинку — перерисовываем вьюху один раз, а не на каждый эмоут
    private val pending = WeakHashMap<TextView, Boolean>()

    @Volatile
    var seen = 0L
        private set

    @Volatile
    var replaced = 0L
        private set

    fun apply(tv: TextView, text: CharSequence): CharSequence? {
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

        val hits = scan(text) ?: return null

        var missing = false
        var out: SpannableStringBuilder? = null
        var lastEnd = -1
        var lastStack: StackDrawable? = null
        val cb = ViewCallback(tv)

        for (h in hits) {
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

        val result = out ?: return null
        // оригинал носим с собой: по нему перерисуемся, когда докачается картинка
        result.setSpan(Vk7tvMark(text), 0, result.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        replaced++
        if (missing) onImageWanted(tv)
        return result
    }

    private class Hit(val start: Int, val end: Int, val emote: Emote)

    /** Проход по словам без регулярок: setText зовётся часто, аллокации жалко. */
    private fun scan(text: CharSequence): List<Hit>? {
        var hits: ArrayList<Hit>? = null
        val n = text.length
        var i = 0
        while (i < n) {
            while (i < n && text[i].isWhitespace()) i++
            if (i >= n) break
            val start = i
            while (i < n && !text[i].isWhitespace()) i++
            val end = i
            if (!Emotes.mayBe(text, start, end)) continue
            val em = Emotes.get(text.subSequence(start, end).toString()) ?: continue
            (hits ?: ArrayList<Hit>(4).also { hits = it }).add(Hit(start, end, em))
        }
        return hits
    }

    private fun onlySpaces(text: CharSequence, from: Int, to: Int): Boolean {
        if (from < 0 || to > text.length || from > to) return false
        for (i in from until to) if (!text[i].isWhitespace()) return false
        return true
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
