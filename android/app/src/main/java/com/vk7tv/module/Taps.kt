package com.vk7tv.module

import android.graphics.Rect
import android.text.Layout
import android.text.Spanned
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.EditText
import android.widget.TextView
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import java.lang.ref.WeakReference

/**
 * Тап по слову из чужого набора — открыть поповер с предложением подключить.
 *
 * Слово нажимаемым делает не movementMethod и не setOnTouchListener: первый
 * у чужого TextView занят — через него ВК ловит ссылки и упоминания, второй
 * молча затёр бы обработчик, который ВК мог повесить сам. Вместо этого цепляем
 * платформенный TextView.onTouchEvent, как модуль уже цепляет setText, и
 * забираем себе ровно те касания, что пришлись в наше слово.
 *
 * Забрать жест можно только целиком, с самого ACTION_DOWN: ViewGroup запоминает
 * ребёнка получателем, только если тот вернул true на нажатие, — иначе ни MOVE,
 * ни UP до нас не доедут. Поэтому либо весь жест наш, либо ни одно событие:
 * половинчатый вариант оставил бы ВК заведённый таймер долгого нажатия и вьюху
 * в состоянии «нажата».
 *
 * Что при этом не ломается: прокрутка списка (родитель перехватит жест и
 * пришлёт нам ACTION_CANCEL) и любые касания мимо слова — там мы возвращаем
 * false, и ВК даже не узнает, что мы здесь были.
 *
 * Что меняется: на самом слове больше нет меню сообщения ВК. Сначала мы его
 * переигрывали — заводили свой таймер и звали performLongClick у ближайшего
 * родителя. Оказалось хуже, чем без него: слово в строке маленькое, палец на
 * нём задерживается, и обычный тап регулярно переваливал за 500 мс — вместо
 * поповера открывалось «поставить реакцию / переслать / удалить». Пусть лучше
 * нажатие на слово всегда делает ровно одно и то же; меню сообщения остаётся
 * на всей остальной площади пузыря.
 */
object Taps {

    // Пока в сообщениях не встретилось ни одного слова-предложения, хук стоит,
    // но не делает ничего: одно чтение volatile на касание. Дороже — только
    // после того, как Replacer нарисовал первую метку.
    @Volatile
    private var armed = false

    // жест, который мы забрали: за какое слово держимся и в какой вьюхе
    private var owner = WeakReference<TextView>(null)
    private var word: String? = null
    private var box: Rect? = null
    private var downX = 0f
    private var downY = 0f
    private var slop = 0
    private var moved = false

    /** В сообщениях появилось слово из чужого набора — начинаем слушать тапы. */
    fun arm() {
        armed = true
    }

    fun hook() {
        XposedHelpers.findAndHookMethod(
            TextView::class.java,
            "onTouchEvent",
            MotionEvent::class.java,
            object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (!armed) return
                    L.safe("тап по слову") {
                        val tv = param.thisObject as? TextView ?: return@safe
                        val e = param.args[0] as? MotionEvent ?: return@safe
                        if (grab(tv, e)) param.result = true
                    }
                }
            },
        )
        Diag.note("хук тапов по словам установлен")
    }

    /** true — жест наш, до ВК он не дойдёт. */
    private fun grab(tv: TextView, e: MotionEvent): Boolean {
        if (e.actionMasked == MotionEvent.ACTION_DOWN) {
            // прошлый жест мог оборваться без CANCEL — начинаем с чистого листа
            release()
            if (!Config.enabled || Config.safeMode || !Config.suggest) return false
            if (tv is EditText) return false
            // свой же пикер и настройки: с «эмоутами везде» метки попадают
            // и в наш текст, но тапы там наши обработчики разбирают сами
            if (Inject.isOurs(tv)) return false
            val s = spanAt(tv, e.x, e.y) ?: return false
            owner = WeakReference(tv)
            word = s.word
            box = rectOf(tv, s)
            downX = e.x
            downY = e.y
            slop = ViewConfiguration.get(tv.context).scaledTouchSlop
            moved = false
            return true
        }
        if (word == null || owner.get() !== tv) return false
        when (e.actionMasked) {
            MotionEvent.ACTION_MOVE ->
                // палец поехал — это прокрутка, а не тап
                if (!moved && (Math.abs(e.x - downX) > slop || Math.abs(e.y - downY) > slop)) {
                    moved = true
                }
            MotionEvent.ACTION_UP -> {
                val w = word
                val at = box
                val tap = !moved
                release()
                if (tap && w != null) SuggestUi.show(tv, w, at)
            }
            MotionEvent.ACTION_CANCEL -> release()
        }
        return true
    }

    /**
     * Метка под пальцем или null.
     *
     * Три отсечки обязательны: и getLineForVertical, и getOffsetForHorizontal
     * зажимают значение в границы разметки, так что без них тап в пустоту под
     * текстом или правее последнего слова «попадал» бы в последнюю метку —
     * и мы отбирали бы у ВК чужое касание.
     */
    private fun spanAt(tv: TextView, ex: Float, ey: Float): SuggestSpan? {
        val text = tv.text as? Spanned ?: return null
        val layout = tv.layout ?: return null // до первой разметки тапов нет
        val x = ex - tv.totalPaddingLeft + tv.scrollX
        val y = ey - tv.totalPaddingTop + tv.scrollY
        if (y < 0f || y >= layout.height) return null
        val line = layout.getLineForVertical(y.toInt())
        if (y < layout.getLineTop(line) || y >= layout.getLineBottom(line)) return null
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null

        val off = layout.getOffsetForHorizontal(line, x)
        // на нулевой длине getSpans отдаёт и то, что просто касается точки, —
        // поэтому каждую метку ещё раз сверяем по её настоящим границам
        for (s in text.getSpans(off, off, SuggestSpan::class.java)) {
            if (hits(layout, line, x, text.getSpanStart(s), text.getSpanEnd(s))) return s
        }
        return null
    }

    /** Попал ли [x] в кусок слова [start]..[end], который лежит на строке [line]. */
    private fun hits(layout: Layout, line: Int, x: Float, start: Int, end: Int): Boolean {
        val from = maxOf(start, layout.getLineStart(line))
        val to = minOf(end, layout.getLineEnd(line)) // слово могло перенестись
        if (from >= to) return false
        val x1 = layout.getPrimaryHorizontal(from)
        // на самом конце строки getPrimaryHorizontal уехал бы в начало следующей
        val x2 = if (to >= layout.getLineEnd(line)) layout.getLineRight(line)
        else layout.getPrimaryHorizontal(to)
        return x >= minOf(x1, x2) && x <= maxOf(x1, x2)
    }

    /** Слово на экране — чтобы поповер встал рядом с ним, а не посреди экрана. */
    private fun rectOf(tv: TextView, s: SuggestSpan): Rect? = L.safe("место слова") {
        val text = tv.text as? Spanned ?: return@safe null
        val layout = tv.layout ?: return@safe null
        val start = text.getSpanStart(s)
        val end = text.getSpanEnd(s)
        if (start < 0 || end <= start) return@safe null
        val line = layout.getLineForOffset(start)
        val at = IntArray(2)
        tv.getLocationOnScreen(at)
        val left = at[0] + tv.totalPaddingLeft - tv.scrollX
        val top = at[1] + tv.totalPaddingTop - tv.scrollY
        val x1 = layout.getPrimaryHorizontal(start)
        val x2 = if (layout.getLineForOffset(end) != line) layout.getLineRight(line)
        else layout.getPrimaryHorizontal(end)
        Rect(
            (left + minOf(x1, x2)).toInt(),
            top + layout.getLineTop(line),
            (left + maxOf(x1, x2)).toInt(),
            top + layout.getLineBottom(line),
        )
    }

    private fun release() {
        owner = WeakReference(null)
        word = null
        box = null
        moved = false
    }
}
