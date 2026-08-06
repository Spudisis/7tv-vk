package com.vk7tv.module

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.Animatable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Автоподсказки эмоутов при вводе — как в вебе (autocomplete.js) и как
 * нативные подсказки стикеров в ВК. Набрал 3+ символа слова — над полем
 * всплывает строка с подходящими эмоутами; тап заменяет слово именем эмоута.
 *
 * Панель НЕ забирает фокус (PopupWindow focusable=false): иначе спряталась бы
 * клавиатура и печатать стало бы нельзя. Висит над строкой ввода, а когда ВК
 * показывает свою строку подсказок стикеров — над ней. Строка ВК — не вьюха
 * в разметке, а отдельное окно, которое добавляется ПОЗЖЕ нашего и рисуется
 * поверх: просто встать вплотную к полю нельзя, полоса оказывалась под ним.
 * Появление и уход таких окон ловит hookWindows, полоса переезжает сама.
 *
 * Вся вёрстка кодом: инфлейтить свои ресурсы в чужом процессе — отдельная
 * возня, ради одной полосы она не окупается (как и в PickerUi).
 */
object Autocomplete {

    private const val MIN_CHARS = 3
    private const val MAX_ITEMS = 12
    private const val CELL_DP = 40

    private val main = Handler(Looper.getMainLooper())

    // поля ввода, на которые наблюдатель уже повешен — второй раз не вешаем.
    // Слабые ключи: запись уходит вместе с самой вьюхой.
    private val watched = WeakHashMap<EditText, Boolean>()

    private var popup: PopupWindow? = null
    private var strip: LinearLayout? = null

    private var layout: ViewTreeObserver.OnGlobalLayoutListener? = null
    private var layoutOn = WeakReference<View>(null)

    // окна процесса, добавленные после установки хука: среди них — окно
    // подсказок стикеров ВК, над которым должна вставать полоса
    private val windows = ArrayList<WeakReference<View>>()

    /**
     * Ловим появление и уход чужих окон. Строка подсказок стикеров ВК — не
     * вьюха в разметке чата, а отдельное окно: обход соседей строки ввода его
     * не видит, а добавляется оно позже нашей полосы и рисуется поверх неё.
     * Хук на WindowManagerGlobal.addView даёт и список окон для расчёта
     * позиции, и момент, когда полосу пора подвинуть; removeView — момент,
     * когда можно вернуться вплотную к полю. Зовётся из handleLoadPackage.
     */
    fun hookWindows() {
        val wmg = Class.forName("android.view.WindowManagerGlobal")
        XposedBridge.hookAllMethods(
            wmg,
            "addView",
            object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    L.safe("новое окно") { track(param.args[0] as? View ?: return@safe) }
                }
            },
        )
        val gone = object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                main.post { L.safe("окно ушло") { reposition() } }
            }
        }
        XposedBridge.hookAllMethods(wmg, "removeView", gone)
        XposedBridge.hookAllMethods(wmg, "removeViewImmediate", gone)
    }

    private fun track(v: View) {
        synchronized(windows) {
            windows.removeAll { it.get() == null }
            if (windows.none { it.get() === v }) windows.add(WeakReference(v))
        }
        // размеры окна известны только после его первой раскладки — двигаем
        // полосу оттуда, из addView двигать рано
        val vto = v.viewTreeObserver
        if (!vto.isAlive) return
        vto.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                L.safe("раскладка нового окна") {
                    v.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    reposition()
                }
            }
        })
    }

    /** Пересчитать позицию видимой полосы: разметка или набор окон изменились. */
    private fun reposition() {
        val pw = popup ?: return
        if (!pw.isShowing) return
        val input = layoutOn.get() as? EditText ?: return
        if (!input.isAttachedToWindow) return
        val top = anchorTop(input)
        if (top <= 0) return
        val y = (top - pw.height - Inject.dp(input.context, 4)).coerceAtLeast(0)
        pw.update(0, y, -1, -1)
    }

    /** Повесить наблюдатель на поле ввода ВК. Зовётся из Inject при attach. */
    fun watch(input: EditText) {
        if (watched.containsKey(input)) return
        watched[input] = true
        input.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                L.safe("автоподсказки") { onType(input) }
            }

            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        })
    }

    private fun onType(input: EditText) {
        if (!Config.enabled || !Emotes.ready) return hide()
        val text = input.text ?: return hide()
        val cursor = input.selectionEnd.coerceIn(0, text.length)

        // слово от последнего пробела слева до курсора
        var start = cursor
        while (start > 0 && !text[start - 1].isWhitespace()) start--
        val word = text.subSequence(start, cursor).toString()
        if (word.length < MIN_CHARS) return hide()

        val matches = Emotes.matchPrefix(word, MAX_ITEMS)
        if (matches.isEmpty()) return hide()
        show(input, matches)
    }

    private fun show(input: EditText, matches: List<Emote>) {
        val ctx = input.context
        val pw = ensurePopup(ctx)
        val row = strip ?: return
        row.removeAllViews()
        for (e in matches) row.addView(cell(ctx, e, input))
        (pw.contentView as? HorizontalScrollView)?.scrollTo(0, 0)

        val top = anchorTop(input)
        if (top <= 0) return hide()
        val y = (top - pw.height - Inject.dp(ctx, 4)).coerceAtLeast(0)
        if (pw.isShowing) {
            pw.update(0, y, -1, -1)
        } else {
            pw.showAtLocation(input, Gravity.NO_GRAVITY, 0, y)
            follow(input)
        }
    }

    /** Строим окно один раз и переиспользуем: dismiss прячет, showAtLocation возвращает. */
    private fun ensurePopup(ctx: Context): PopupWindow {
        popup?.let { return it }
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        strip = row
        val container = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = Inject.dp(ctx, 10).toFloat()
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
            val p = Inject.dp(ctx, 4)
            setPadding(p, p, p, p)
            addView(row)
        }
        val h = Inject.dp(ctx, CELL_DP + 16)
        val pw = PopupWindow(container, WindowManager.LayoutParams.MATCH_PARENT, h, false).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            isClippingEnabled = false
            isOutsideTouchable = false
            inputMethodMode = PopupWindow.INPUT_METHOD_NOT_NEEDED
        }
        popup = pw
        return pw
    }

    private fun cell(ctx: Context, e: Emote, input: EditText): View {
        val iv = ImageView(ctx)
        val size = Inject.dp(ctx, CELL_DP)
        val lp = LinearLayout.LayoutParams(size, size)
        lp.rightMargin = Inject.dp(ctx, 2)
        iv.layoutParams = lp
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        val p = Inject.dp(ctx, 3)
        iv.setPadding(p, p, p, p)
        iv.contentDescription = e.name
        bind(iv, e)
        iv.setOnClickListener { L.safe("вставка автоподсказки") { accept(input, e.insertName) } }
        return iv
    }

    private fun bind(iv: ImageView, e: Emote) {
        iv.setImageDrawable(null)
        val d = EmoteCache.drawable(e.url) {
            main.post { if (iv.contentDescription == e.name) bind(iv, e) }
        }
        if (d != null) {
            iv.setImageDrawable(d)
            (d as? Animatable)?.start()
        }
    }

    /**
     * Заменяем слово под курсором именем эмоута и пробелом. Границы слова
     * берём заново по текущему курсору, а не по сохранённым: пока панель висит,
     * курсор мог уехать.
     */
    private fun accept(input: EditText, name: String) {
        val text = input.text ?: return
        val cursor = input.selectionEnd.coerceIn(0, text.length)
        var start = cursor
        while (start > 0 && !text[start - 1].isWhitespace()) start--
        text.replace(start, cursor, "$name ")
        val pos = (start + name.length + 1).coerceAtMost(input.text?.length ?: 0)
        L.safe("курсор") { input.setSelection(pos) }
        hide()
    }

    /**
     * Держим полосу приклеенной к строке ввода: клавиатура и нативные подсказки
     * двигают панель, и без пересчёта окно повисло бы посреди экрана.
     */
    private fun follow(input: EditText) {
        unfollow()
        val l = ViewTreeObserver.OnGlobalLayoutListener {
            L.safe("позиция автоподсказок") {
                if (!input.isAttachedToWindow) return@safe hide()
                reposition()
            }
        }
        input.viewTreeObserver.addOnGlobalLayoutListener(l)
        layout = l
        layoutOn = WeakReference(input)
    }

    private fun unfollow() {
        val l = layout ?: return
        L.safe("снятие слежения автоподсказок") {
            layoutOn.get()?.viewTreeObserver?.removeOnGlobalLayoutListener(l)
        }
        layout = null
        layoutOn = WeakReference(null)
    }

    private fun hide() {
        unfollow()
        popup?.let { pw -> L.safe("скрытие автоподсказок") { if (pw.isShowing) pw.dismiss() } }
    }

    /**
     * Верх, над которым встаёт полоса. Обычно это верх строки ввода, но место
     * над ней бывает занято панелью ВК: окном подсказок стикеров или списком
     * упоминаний. Всё, что пересекает место полосы, поднимает её выше; панели
     * могут стоять стопкой, поэтому подъём повторяется. Классов ВК не знаем
     * (обфусцированы) — панель опознаём по геометрии, а не по типу.
     */
    private fun anchorTop(input: EditText): Int {
        val base = inputTop(input)
        if (base <= 0) return base
        // высота полосы плюс зазор до того, что под ней
        val need = Inject.dp(input.context, CELL_DP + 16) + Inject.dp(input.context, 4)
        val rects = panelRects(input)
        var top = base
        var guard = 0
        while (guard++ < 4) {
            val hit = rects.filter { it.top < top && it.bottom > top - need }
                .minByOrNull { it.top } ?: break
            top = hit.top
        }
        if (top != base) L.v("полоса поднята над панелью: $base -> $top")
        return top
    }

    /**
     * Прямоугольники видимых панелей, с которыми полоса не должна
     * пересекаться: соседи строки ввода по цепочке родителей (панели в
     * разметке чата) и чужие окна процесса (подсказки стикеров ВК — отдельное
     * окно, в разметке чата его нет).
     */
    private fun panelRects(input: EditText): List<Rect> {
        val out = ArrayList<Rect>()
        val loc = IntArray(2)
        val row = (input.parent as? View) ?: input
        // потолок высоты панели: подсказки стикеров и упоминания ниже, а лента
        // чата и декоры экранов (тоже доходят до нижнего края) — выше потолка
        val maxPanel = Inject.dp(input.context, 240)
        // панель тянется на ширину строки; узкие вьюхи у нижнего края
        // (кнопка «вниз» в чате) панелью не считаем
        val minWidth = row.width / 2

        fun add(v: View) {
            if (!v.isShown || v.height <= 0 || v.height > maxPanel) return
            if (minWidth > 0 && v.width < minWidth) return
            v.getLocationOnScreen(loc)
            out.add(Rect(loc[0], loc[1], loc[0] + v.width, loc[1] + v.height))
        }

        // соседи по разметке; сам столб родителей пропускаем: каждый из них
        // содержит строку ввода и пересекал бы место полосы всегда
        var child: View = row
        var p = row.parent as? ViewGroup
        var depth = 0
        while (p != null && depth < 6) {
            for (i in 0 until p.childCount) {
                val c = p.getChildAt(i)
                if (c !== child) add(c)
            }
            child = p
            p = p.parent as? ViewGroup
            depth++
        }

        // чужие окна; своё окно и окно самого чата не считаем
        val own = popup?.contentView?.rootView
        val host = input.rootView
        val roots = synchronized(windows) { windows.mapNotNull { it.get() } }
        for (w in roots) {
            if (w === own || w === host || !w.isAttachedToWindow) continue
            add(w)
        }
        return out
    }

    /**
     * Верхняя граница строки ввода в координатах экрана: берём строку (родителя
     * поля), чтобы полоса встала над всем рядом с иконками, а не только над
     * текстом.
     */
    private fun inputTop(input: EditText): Int {
        val row = input.parent as? View
        val v = if (row != null && row.isAttachedToWindow) row else input
        if (!v.isAttachedToWindow) return 0
        val p = IntArray(2)
        v.getLocationOnScreen(p)
        return p[1]
    }
}
