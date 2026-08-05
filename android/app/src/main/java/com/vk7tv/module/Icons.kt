package com.vk7tv.module

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import kotlin.math.cos
import kotlin.math.sin

/**
 * Шестерёнка, нарисованная кодом.
 *
 * Глиф «⚙» из системного шрифта выглядит по-разному на каждой прошивке: где-то
 * это тонкий символ не в размер соседнего крестика, где-то цветная эмодзи мимо
 * палитры панели. Своих ресурсов у модуля в чужом процессе нет (инфлейт через
 * XModuleResources ради одной иконки не окупается), поэтому рисуем по месту:
 * кольцо, восемь зубцов, отверстие в середине. Цвет и размер задаёт вызывающий.
 */
class GearDrawable(private val color: Int) : Drawable() {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        if (b.isEmpty) return
        val cx = b.exactCenterX()
        val cy = b.exactCenterY()
        val r = minOf(b.width(), b.height()) / 2f
        paint.color = color

        // зубцы: короткие лучи с круглыми концами — на мелком размере читаются
        // лучше, чем честные трапеции, которые в 18dp сливаются в кашу
        paint.strokeWidth = r * TOOTH_W
        for (i in 0 until TEETH) {
            val a = i * (2.0 * Math.PI / TEETH)
            val dx = cos(a).toFloat()
            val dy = sin(a).toFloat()
            canvas.drawLine(
                cx + dx * r * TOOTH_IN,
                cy + dy * r * TOOTH_IN,
                cx + dx * r * TOOTH_OUT,
                cy + dy * r * TOOTH_OUT,
                paint,
            )
        }

        // кольцо: его толщина и задаёт отверстие в середине
        paint.strokeWidth = r * RING_W
        canvas.drawCircle(cx, cy, r * RING_R, paint)
    }

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
    }

    override fun setColorFilter(cf: ColorFilter?) {
        paint.colorFilter = cf
    }

    @Deprecated("Deprecated in Java", ReplaceWith("PixelFormat.TRANSLUCENT"))
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    private companion object {
        const val TEETH = 8
        const val TOOTH_W = 0.22f
        const val TOOTH_IN = 0.58f
        const val TOOTH_OUT = 0.90f
        const val RING_W = 0.30f
        const val RING_R = 0.52f
    }
}
