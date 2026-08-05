package com.vk7tv.module

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Animatable
import android.graphics.drawable.Drawable
import android.text.style.ReplacementSpan
import android.view.View
import java.lang.ref.WeakReference

/** Маркер «этот текст мы уже обработали» + оригинал для перерисовки. */
class Vk7tvMark(val original: CharSequence)

/**
 * Эмоут вместо слова. Высота — от размера шрифта, чтобы картинка
 * не выбивалась из строки при любом системном масштабе текста.
 */
open class EmoteSpan(val stack: StackDrawable) : ReplacementSpan() {

    /**
     * Полоска под картинкой: сколько высоты забрать у самого эмоута.
     * У обычного эмоута её нет, и вся арифметика остаётся прежней.
     */
    protected open fun footer(paint: Paint): Int = 0

    override fun getSize(
        paint: Paint,
        text: CharSequence,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int {
        val box = (paint.textSize * HEIGHT_RATIO).toInt().coerceAtLeast(1)
        // место занимаем всегда одинаковое — подключишь набор, и картинка
        // подрастёт на месте, не переливая сообщение заново
        val h = (box - footer(paint)).coerceAtLeast(1)
        val w = stack.widthFor(h)
        stack.setBounds(0, 0, w, h)
        if (fm != null) {
            // картинка выше строки — раздвигаем метрики, иначе соседние
            // строки наедут друг на друга
            val pm = paint.fontMetricsInt
            val center = (pm.ascent + pm.descent) / 2
            fm.ascent = center - box / 2
            fm.top = fm.ascent
            fm.descent = center + box / 2
            fm.bottom = fm.descent
        }
        return w
    }

    override fun draw(
        canvas: Canvas,
        text: CharSequence,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) {
        val pm = paint.fontMetricsInt
        val center = y + (pm.ascent + pm.descent) / 2
        val box = stack.bounds.height() + footer(paint)
        val topY = center - box / 2f
        canvas.save()
        canvas.translate(x, topY)
        stack.draw(canvas)
        canvas.restore()
        decorate(canvas, x, topY + stack.bounds.height(), stack.bounds.width().toFloat(), paint)
    }

    /** Рисуется под картинкой; [y] — её нижняя граница, [w] — ширина. */
    protected open fun decorate(canvas: Canvas, x: Float, y: Float, w: Float, paint: Paint) = Unit

    companion object {
        // 7TV/Twitch рисуют инлайновый эмоут примерно в 1.8 высоты шрифта
        const val HEIGHT_RATIO = 1.8f
    }
}

/**
 * Эмоут из набора, которого у нас нет: картинка чуть ниже обычной, а под ней —
 * полоска цвета ссылки.
 *
 * Полоска, а не прозрачность или значок «+»: эмоуты 7TV сами по себе часто
 * бледные и полупрозрачные, так что приглушённостью «чужой» не показать, а
 * значок на картинке в палец высотой закрыл бы ровно то, что мы показываем.
 * Зато полоска — тот же знак, что и у слова без картинки (цвет + подчёркивание),
 * так что оба состояния читаются как одно и то же «нажми, чтобы подключить».
 */
class SuggestEmoteSpan(stack: StackDrawable) : EmoteSpan(stack) {

    override fun footer(paint: Paint): Int =
        (paint.textSize * FOOTER_RATIO).toInt().coerceAtLeast(3)

    override fun decorate(canvas: Canvas, x: Float, y: Float, w: Float, paint: Paint) {
        // draw зовётся из onDraw чужой вьюхи — мимо всех наших L.safe.
        // Вылет отсюда уронил бы процесс ВК на отрисовке сообщения.
        try {
            val f = footer(paint)
            val thick = (f * BAR_RATIO).coerceAtLeast(2f)
            bar.color = Ui.ACCENT
            canvas.drawRect(x, y + (f - thick) / 2f, x + w, y + (f + thick) / 2f, bar)
        } catch (t: Throwable) {
            L.e("сбой в полоске предложения", t)
        }
    }

    private companion object {
        // отрисовка идёт только на главном потоке — одной кисти хватает всем
        val bar = Paint(Paint.ANTI_ALIAS_FLAG)
        const val FOOTER_RATIO = 0.25f
        const val BAR_RATIO = 0.4f
    }
}

/** Схлопнутый zero-width эмоут: занимает нулевую ширину и ничего не рисует. */
class ZeroWidthSpan : ReplacementSpan() {
    override fun getSize(
        paint: Paint,
        text: CharSequence,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int = 0

    override fun draw(
        canvas: Canvas,
        text: CharSequence,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) = Unit
}

/**
 * Стопка эмоутов: снизу обычный, сверху zero-width'ы. Размер задаёт нижний,
 * остальные вписываются в него по центру — как `peepoHappy RainTime` в вебе.
 */
class StackDrawable(base: Drawable) : Drawable(), Drawable.Callback {

    private val layers = ArrayList<Drawable>(2)

    init {
        layers.add(base)
        // setCallback у Drawable финальный, поэтому раздать слоям внешний
        // callback нельзя. Вместо этого стопка сама слушает свои слои
        // и переадресует их запросы наверх — во View.
        base.callback = this
        (base as? Animatable)?.start()
    }

    fun add(d: Drawable) {
        layers.add(d)
        d.callback = this
        (d as? Animatable)?.start()
        if (!bounds.isEmpty) onBoundsChange(bounds)
        invalidateSelf()
    }

    override fun invalidateDrawable(who: Drawable) = invalidateSelf()

    override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) =
        scheduleSelf(what, `when`)

    override fun unscheduleDrawable(who: Drawable, what: Runnable) = unscheduleSelf(what)

    fun widthFor(height: Int): Int {
        val b = layers[0]
        val iw = b.intrinsicWidth.coerceAtLeast(1)
        val ih = b.intrinsicHeight.coerceAtLeast(1)
        return (height.toFloat() * iw / ih).toInt().coerceAtLeast(1)
    }

    override fun onBoundsChange(b: Rect) {
        layers[0].setBounds(b)
        for (i in 1 until layers.size) {
            val d = layers[i]
            val iw = d.intrinsicWidth.coerceAtLeast(1)
            val ih = d.intrinsicHeight.coerceAtLeast(1)
            // вписываем поверх, сохраняя пропорции
            val scale = minOf(b.width().toFloat() / iw, b.height().toFloat() / ih)
            val w = (iw * scale).toInt()
            val h = (ih * scale).toInt()
            val left = b.left + (b.width() - w) / 2
            val top = b.top + (b.height() - h) / 2
            d.setBounds(left, top, left + w, top + h)
        }
    }

    override fun draw(canvas: Canvas) {
        for (d in layers) d.draw(canvas)
    }

    override fun setAlpha(alpha: Int) {
        for (d in layers) d.alpha = alpha
    }

    override fun setColorFilter(cf: ColorFilter?) {
        for (d in layers) d.colorFilter = cf
    }

    @Deprecated("Deprecated in Java", ReplaceWith("PixelFormat.TRANSLUCENT"))
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/**
 * Мост «анимация -> перерисовка». AnimatedImageDrawable зовёт
 * invalidateSelf на каждый кадр, а дальше нужен тот, кто дёрнет View.
 */
class ViewCallback(view: View) : Drawable.Callback {

    private val ref = WeakReference(view)

    override fun invalidateDrawable(who: Drawable) {
        ref.get()?.invalidate()
    }

    override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) {
        ref.get()?.postDelayed(what, `when` - android.os.SystemClock.uptimeMillis())
    }

    override fun unscheduleDrawable(who: Drawable, what: Runnable) {
        ref.get()?.removeCallbacks(what)
    }
}
