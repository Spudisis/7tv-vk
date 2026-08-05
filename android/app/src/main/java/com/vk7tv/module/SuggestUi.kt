package com.vk7tv.module

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.text.Spanned
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView

/**
 * Поповер по тапу на слово из чужого набора: что это за эмоут, чей набор
 * и кнопка подключить.
 *
 * Отдельное окно, а не часть пикера: тап пришёлся в сообщение, и панель ввода
 * тут ни при чём — открывать ради этого весь пикер значило бы прятать
 * переписку. Окно нефокусируемое: иначе оно бы забрало фокус у поля ввода
 * и уронило клавиатуру посреди набора сообщения.
 */
object SuggestUi {

    private var popup: PopupWindow? = null
    private var watched: View? = null
    private var watcher: ViewTreeObserver.OnScrollChangedListener? = null

    /**
     * [word] — само слово, [at] — где оно на экране. Находку ищем заново прямо
     * здесь: пока сообщение висело на экране, набор могли подключить из другого
     * места или скрыть, и тогда показывать нечего.
     */
    fun show(anchor: View, word: String, at: Rect?) {
        L.safe("поповер предложения") {
            hide()
            if (!anchor.isAttachedToWindow || anchor.windowToken == null) return@safe
            val hit = Suggest.hitOf(word) ?: return@safe
            val ctx = anchor.context

            val root = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                // метка «это наша вьюха» — чтобы Taps не ловил тапы внутри
                // поповера, когда включено «показывать эмоуты везде»
                contentDescription = Inject.OUR_UI
                background = GradientDrawable().apply {
                    setColor(Ui.BG)
                    cornerRadius = Inject.dp(ctx, 12).toFloat()
                    setStroke(Inject.dp(ctx, 1), Ui.BORDER)
                }
                setPadding(Inject.dp(ctx, 10), Inject.dp(ctx, 8), Inject.dp(ctx, 2), Inject.dp(ctx, 8))
            }
            root.addView(
                TextView(ctx).apply {
                    text = "МОЖНО ПОДКЛЮЧИТЬ"
                    textSize = 10f
                    setTextColor(Ui.MUTED)
                    typeface = Typeface.DEFAULT_BOLD
                    setPadding(Inject.dp(ctx, 2), 0, 0, Inject.dp(ctx, 4))
                },
            )
            root.addView(PickerUi.suggestCard(ctx, hit, Inject.dp(ctx, 200)) { hide() })

            val pw = PopupWindow(root, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, false)
            pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            pw.isOutsideTouchable = true
            val (x, y) = place(ctx, root, at)
            pw.showAtLocation(anchor, Gravity.NO_GRAVITY, x, y)
            popup = pw
            follow(anchor)
            // Тап мимо окна — основной способ его закрыть, и приходит он сразу
            // в PopupWindow, мимо hide(). Без обнуления здесь ссылка на окно
            // (а через него — на вьюху и контекст чата) осталась бы висеть
            // в объекте до конца жизни процесса ВК.
            pw.setOnDismissListener {
                L.safe("закрытие поповера") {
                    popup = null
                    detach()
                }
            }
        }
    }

    /** Слово на экране — чтобы поповер встал рядом с ним, а не посреди экрана. */
    fun rectOf(tv: TextView, s: Any): Rect? = L.safe("место слова") {
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

    fun hide() {
        L.safe("закрытие поповера") {
            popup?.dismiss()
            popup = null
            detach()
        }
    }

    /**
     * Ставим окно над словом, а если сверху не помещается — под ним. По бокам
     * прижимаем к экрану: слово у самого края не должно уводить окно за него.
     */
    private fun place(ctx: Context, root: View, at: Rect?): Pair<Int, Int> {
        val dm = ctx.resources.displayMetrics
        val edge = Inject.dp(ctx, 8)
        val gap = Inject.dp(ctx, 6)
        root.measure(
            View.MeasureSpec.makeMeasureSpec(dm.widthPixels, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(dm.heightPixels, View.MeasureSpec.AT_MOST),
        )
        val w = root.measuredWidth
        val h = root.measuredHeight
        if (at == null) return ((dm.widthPixels - w) / 2) to ((dm.heightPixels - h) / 2)
        val x = (at.centerX() - w / 2).coerceIn(edge, (dm.widthPixels - w - edge).coerceAtLeast(edge))
        val above = at.top - h - gap
        val y = if (above >= edge) above else (at.bottom + gap).coerceAtMost(dm.heightPixels - h - edge)
        return x to y.coerceAtLeast(edge)
    }

    /**
     * Список под пальцем живёт своей жизнью: прокрутил — и сообщение уехало,
     * а окно осталось висеть над чужим текстом. Проще закрыть.
     */
    private fun follow(anchor: View) {
        val w = ViewTreeObserver.OnScrollChangedListener { hide() }
        anchor.viewTreeObserver.addOnScrollChangedListener(w)
        watched = anchor
        watcher = w
    }

    private fun detach() {
        val w = watcher ?: return
        L.safe("снятие слежения") {
            watched?.viewTreeObserver?.removeOnScrollChangedListener(w)
        }
        watcher = null
        watched = null
    }
}
