package com.vk7tv.module

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import java.lang.ref.WeakReference

/**
 * Кнопка «7TV» в панели ввода.
 *
 * Опознаём панель не по классам ВК (они обфусцированы), а от поля ввода:
 * находим EditText, поднимаемся на пару уровней вверх и ищем ряд, в котором
 * рядом с полем уже висят иконки — скрепка, стикеры. Туда и встаём.
 * Не нашли ряд — вешаем плавающую кнопку поверх экрана, как в веб-версии:
 * функциональность важнее, чем идеальное место.
 */
object Inject {

    private const val MARK = "vk7tv-button"

    /** Метка на своих полях ввода: поиск в пикере, поля в настройках. */
    const val OUR_UI = "vk7tv-ui"

    private var lastInput = WeakReference<EditText>(null)

    @Volatile
    var attached = false
        private set

    // живые кнопки — чтобы снять с них лоадер, когда наборы догрузятся
    private val buttons = ArrayList<WeakReference<ViewGroup>>()

    fun input(): EditText? = lastInput.get()

    fun hook() {
        XposedHelpers.findAndHookMethod(
            TextView::class.java,
            "onAttachedToWindow",
            object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    L.safe("onAttachedToWindow") {
                        val v = param.thisObject as? EditText ?: return@safe
                        Boot.ensure(v.context)
                        if (!Config.enabled) return@safe
                        // Поиск в пикере — тоже EditText. Без этой проверки он
                        // становится «последним полем ввода», и вставка эмоута
                        // улетает в строку поиска вместо поля ВК. В вебе такая
                        // защита есть в picker.js, сюда её забыли перенести.
                        if (v.contentDescription == OUR_UI) return@safe
                        lastInput = WeakReference(v)
                        // на момент attach разметка ещё не разложена — ждём кадр
                        v.post { L.safe("установка кнопки") { attach(v) } }
                    }
                }
            },
        )
        Diag.note("хук панели ввода установлен")
    }

    private fun attach(input: EditText) {
        val root = input.rootView as? ViewGroup ?: return
        if (find(root) != null) return // уже стоит

        if (Config.dockButton) {
            val row = iconRow(input)
            if (row != null) {
                dock(row, input)
                return
            }
            L.i("ряд иконок не опознан — вешаю плавающую кнопку")
        }
        floating(input)
    }

    private fun find(root: ViewGroup): View? {
        for (i in 0 until root.childCount) {
            val c = root.getChildAt(i)
            if (MARK == c.contentDescription) return c
            if (c is ViewGroup) find(c)?.let { return it }
        }
        return null
    }

    /** Ряд панели ввода: ближайший LinearLayout над полем, где уже есть иконки. */
    private fun iconRow(input: EditText): LinearLayout? {
        var p = input.parent as? ViewGroup
        var depth = 0
        while (p != null && depth < 4) {
            if (p is LinearLayout && p.orientation == LinearLayout.HORIZONTAL && icons(p) > 0) {
                return p
            }
            p = p.parent as? ViewGroup
            depth++
        }
        return null
    }

    private fun icons(g: ViewGroup): Int {
        var n = 0
        for (i in 0 until g.childCount) if (g.getChildAt(i) is ImageView) n++
        return n
    }

    private fun dock(row: LinearLayout, input: EditText) {
        val ctx = row.context
        val size = dp(ctx, 30)
        val btn: View = button(input)
        val lp = LinearLayout.LayoutParams(size, size)
        lp.gravity = Gravity.CENTER_VERTICAL
        lp.leftMargin = dp(ctx, 2)
        lp.rightMargin = dp(ctx, 2)
        btn.layoutParams = lp

        // встаём перед последней иконкой — обычно это стикеры/микрофон
        var at = row.childCount
        for (i in row.childCount - 1 downTo 0) {
            if (row.getChildAt(i) is ImageView) {
                at = i
                break
            }
        }
        row.addView(btn, at)
        attached = true
        Diag.note("кнопка встала в панель ввода")
    }

    private fun floating(input: EditText) {
        val root = input.rootView.findViewById<ViewGroup>(android.R.id.content) ?: return
        val ctx = root.context
        val size = dp(ctx, 44)
        val btn: View = button(input)
        val lp = FrameLayout.LayoutParams(size, size)
        lp.gravity = Gravity.END or Gravity.BOTTOM
        lp.rightMargin = dp(ctx, 12)
        lp.bottomMargin = dp(ctx, 96)
        btn.layoutParams = lp
        makeDraggable(btn)
        root.addView(btn)
        attached = true
        Diag.note("ряд иконок не опознан — кнопка плавающая")
    }

    /**
     * Кнопка «7TV». Пока наборы качаются, вместо подписи крутится индикатор:
     * первый запуск тянет ~1000 эмоутов, и без него кнопка выглядит мёртвой.
     */
    private fun button(input: EditText): ViewGroup {
        val ctx = input.context
        val box = FrameLayout(ctx)
        box.contentDescription = MARK
        box.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Ui.BG)
            setStroke(dp(ctx, 1), Ui.BORDER)
        }

        val label = TextView(ctx).apply {
            text = "7TV"
            textSize = 9f
            setTextColor(Ui.TEXT)
            gravity = Gravity.CENTER
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        box.addView(
            label,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val spin = ProgressBar(ctx, null, android.R.attr.progressBarStyleSmall).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(Ui.ACCENT)
        }
        val slp = FrameLayout.LayoutParams(dp(ctx, 18), dp(ctx, 18))
        slp.gravity = Gravity.CENTER
        box.addView(spin, slp)

        box.isClickable = true
        box.setOnClickListener {
            L.safe("открытие пикера") { PickerUi.toggle(box, lastInput.get() ?: input) }
        }
        // настроек отдельным приложением нет — конфиг лежит в хранилище ВК,
        // поэтому и правится отсюда же
        box.setOnLongClickListener {
            L.safe("открытие настроек") { SettingsUi.show(box) }
            true
        }

        synchronized(buttons) { buttons.add(WeakReference(box)) }
        applyState(box)
        return box
    }

    /** Наборы догрузились — гасим индикатор на всех живых кнопках. */
    fun markReady() {
        val list = synchronized(buttons) { ArrayList(buttons) }
        for (ref in list) {
            val box = ref.get() ?: continue
            box.post { L.safe("состояние кнопки") { applyState(box) } }
        }
    }

    private fun applyState(box: ViewGroup) {
        if (box.childCount < 2) return
        val ready = Emotes.ready
        box.getChildAt(0).visibility = if (ready) View.VISIBLE else View.INVISIBLE
        box.getChildAt(1).visibility = if (ready) View.GONE else View.VISIBLE
    }

    private fun makeDraggable(btn: View) {
        var dx = 0f
        var dy = 0f
        var moved = false
        btn.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dx = e.rawX - v.x
                    dy = e.rawY - v.y
                    moved = false
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val nx = e.rawX - dx
                    val ny = e.rawY - dy
                    if (!moved && (Math.abs(nx - v.x) > 8 || Math.abs(ny - v.y) > 8)) moved = true
                    if (moved) {
                        v.x = nx
                        v.y = ny
                    }
                    moved
                }
                // если тащили — клик не засчитываем
                MotionEvent.ACTION_UP -> moved
                else -> false
            }
        }
    }

    fun dp(ctx: android.content.Context, v: Int): Int =
        (v * ctx.resources.displayMetrics.density).toInt()
}

/** Палитра — та же, что у веб-пикера, чтобы расширение и модуль выглядели родными. */
object Ui {
    val BG = Color.parseColor("#1e1f24")
    val BG2 = Color.parseColor("#23252c")
    val HOVER = Color.parseColor("#2c2e36")
    val BORDER = Color.parseColor("#34363f")
    val TEXT = Color.parseColor("#e4e6eb")
    val MUTED = Color.parseColor("#9aa0ab")
    val ACCENT = Color.parseColor("#4c8bf5")
    val STAR = Color.parseColor("#f5b942")
}
