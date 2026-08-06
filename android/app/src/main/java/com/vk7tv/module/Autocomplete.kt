package com.vk7tv.module

import android.content.Context
import android.graphics.Color
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
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Автоподсказки эмоутов при вводе — как в вебе (autocomplete.js) и как
 * нативные подсказки стикеров в ВК. Набрал 3+ символа слова — над полем
 * всплывает строка с подходящими эмоутами; тап заменяет слово именем эмоута.
 *
 * Панель НЕ забирает фокус (PopupWindow focusable=false): иначе спряталась бы
 * клавиатура и печатать стало бы нельзя. Висит над строкой ввода, а когда ВК
 * показывает свою строку подсказок стикеров — над ней: раньше полоса вставала
 * вплотную к полю и оказывалась под нативной строкой, перекрывая её низ.
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
                val pw = popup ?: return@safe
                if (!pw.isShowing) return@safe
                if (!input.isAttachedToWindow) return@safe hide()
                val top = anchorTop(input)
                if (top <= 0) return@safe
                val y = (top - pw.height - Inject.dp(input.context, 4)).coerceAtLeast(0)
                pw.update(0, y, -1, -1)
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
     * Верх, над которым встаёт полоса: верх строки ввода, а если над строкой
     * видна панель ВК (нативные подсказки стикеров, список упоминаний) — верх
     * этой панели. Панели лежат в разметке соседями строки ввода по цепочке
     * родителей: поднимаемся по ней и забираем видимых соседей, чей низ
     * примыкает к текущему верху. Классов ВК не знаем (обфусцированы), поэтому
     * панель опознаём по геометрии, а не по типу.
     */
    private fun anchorTop(input: EditText): Int {
        var top = inputTop(input)
        if (top <= 0) return top
        val ctx = input.context
        // зазор между низом панели и верхом строки: у панелей ВК бывают
        // отступы в пару dp, точного примыкания требовать нельзя
        val slack = Inject.dp(ctx, 8)
        // потолок высоты панели: строка подсказок стикеров и список упоминаний
        // ниже, а лента чата (её низ тоже примыкает к строке ввода) — выше
        val maxPanel = Inject.dp(ctx, 240)
        val row = (input.parent as? View) ?: input
        // панель тянется на ширину строки; узкие вьюхи у нижнего края
        // (кнопка «вниз» в чате) панелью не считаем
        val minWidth = row.width / 2
        val loc = IntArray(2)
        var p = row.parent as? ViewGroup
        var depth = 0
        while (p != null && depth < 6) {
            // панели могут лежать стопкой в одном родителе — после каждой
            // находки проходим детей заново от нового верха
            var moved = true
            while (moved) {
                moved = false
                for (i in 0 until p.childCount) {
                    val c = p.getChildAt(i)
                    if (!c.isShown || c.height <= 0 || c.height > maxPanel) continue
                    if (minWidth > 0 && c.width < minWidth) continue
                    c.getLocationOnScreen(loc)
                    val bottom = loc[1] + c.height
                    if (bottom >= top - slack && bottom <= top + slack && loc[1] < top) {
                        top = loc[1]
                        moved = true
                    }
                }
            }
            p = p.parent as? ViewGroup
            depth++
        }
        return top
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
