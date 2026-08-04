package com.vk7tv.module

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
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
import android.widget.AbsListView
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.GridView
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import android.widget.Toast

/**
 * Пикер эмоутов — панель снизу, по духу тот же поповер, что в браузере:
 * поиск, полоса избранного, наборы, сетка. Тап по эмоуту вставляет его
 * полное имя (с постфиксом набора) в поле ввода на позицию курсора,
 * долгий тап — в избранное и обратно.
 *
 * Звёздочки в углу ячейки, как в вебе, тут нет намеренно: на телефоне
 * в неё не попасть пальцем, а долгий тап — привычный жест.
 *
 * Вся вёрстка кодом: у модуля свои ресурсы, а инфлейтить их в чужом процессе
 * — отдельная возня с XModuleResources, и ради десятка вьюх она не окупается.
 */
object PickerUi {

    private const val CELL_DP = 44

    private val main = Handler(Looper.getMainLooper())
    private var popup: PopupWindow? = null

    // следим за разметкой, пока поповер открыт: клавиатура двигает панель ввода
    private var watcher: ViewTreeObserver.OnGlobalLayoutListener? = null
    private var watched: View? = null

    // состояние пикера между открытиями: выбранный набор и прокрутка не
    // сбрасываются, чтобы после отправки эмоута и закрытия не листать заново
    // до нужного стримера
    private var savedGroup = -1
    private var savedScroll = 0

    fun toggle(anchor: View, input: EditText) {
        val p = popup
        if (p != null && p.isShowing) {
            p.dismiss()
            popup = null
            return
        }
        show(anchor, input)
    }

    private fun show(anchor: View, input: EditText) {
        val ctx = anchor.context
        if (!Emotes.ready) {
            Toast.makeText(ctx, "VK7TV: наборы ещё грузятся", Toast.LENGTH_SHORT).show()
            return
        }

        val all = Emotes.groups.flatMap { it.emotes }

        val rootView = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = r(ctx)
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
        }

        rootView.addView(header(ctx))
        val search = search(ctx)
        rootView.addView(search)

        // предложения: у собеседника есть эмоут из набора, которого нет у нас
        val sugBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 6))
        }
        rootView.addView(sugBox)
        fillSuggests(ctx, sugBox)

        // полоса избранного живёт над сеткой и не уезжает при прокрутке
        val favBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 6))
        }
        rootView.addView(favBox)

        val onFav = { name: String ->
            val on = Config.toggleFavorite(name)
            fillFavorites(ctx, favBox, input)
            toast(ctx, if (on) "$name — в избранном" else "$name убран из избранного")
        }
        fillFavorites(ctx, favBox, input)

        val adapter = EmoteAdapter(ctx, all, { insert(input, it) }, onFav)

        // восстанавливаем набор, на котором закрыли; исчез (набор убрали) —
        // откатываемся на «Все»
        var group = if (savedGroup in Emotes.groups.indices) savedGroup else -1
        var query = ""

        val grid = GridView(ctx).apply {
            numColumns = GridView.AUTO_FIT
            columnWidth = Inject.dp(ctx, CELL_DP)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            verticalSpacing = Inject.dp(ctx, 2)
            horizontalSpacing = Inject.dp(ctx, 2)
            setPadding(Inject.dp(ctx, 8), 0, Inject.dp(ctx, 8), Inject.dp(ctx, 8))
            clipToPadding = false
            this.adapter = adapter
        }

        fun refresh(restore: Boolean) {
            val base = if (group < 0) all else Emotes.groups.getOrNull(group)?.emotes ?: all
            adapter.items = if (query.isEmpty()) base
            else base.filter { it.name.contains(query, ignoreCase = true) }
            adapter.notifyDataSetChanged()
            savedGroup = group
            if (restore) {
                // открытие пикера — вернуться туда, где закрыли
                val pos = savedScroll.coerceIn(0, (adapter.count - 1).coerceAtLeast(0))
                grid.post { L.safe("прокрутка пикера") { grid.setSelection(pos) } }
            } else {
                // сменил набор или начал поиск — показываем сверху
                savedScroll = 0
                grid.setSelection(0)
            }
        }

        rootView.addView(chips(ctx, group) { i -> group = i; refresh(restore = false) })

        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                query = s?.toString()?.trim() ?: ""
                refresh(restore = false)
            }

            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        })

        rootView.addView(
            grid,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )
        refresh(restore = true)

        // Поповер встаёт НАД панелью ввода, а не поверх неё: иначе не видно,
        // что вставилось в поле.
        //
        // Позиционируем абсолютными координатами (NO_GRAVITY), а не отступом
        // от низа: положение панели мы меряем через getLocationOnScreen, то есть
        // в координатах экрана, а Gravity.BOTTOM отсчитывается от окна
        // приложения. Там, где системные панели устроены иначе (Sova RE),
        // эти системы расходятся, и поповер наезжал на поле ввода.
        val dm = ctx.resources.displayMetrics
        val gap = Inject.dp(ctx, 6)
        val top = panelTop(anchor, input)
        val room = (top - gap - Inject.dp(ctx, 24)).coerceAtLeast(Inject.dp(ctx, 180))
        val h = minOf((dm.heightPixels * 0.45f).toInt(), room)
        val y = (top - h - gap).coerceAtLeast(0)

        val pw = PopupWindow(rootView, WindowManager.LayoutParams.MATCH_PARENT, h, true)
        pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        pw.isOutsideTouchable = true
        pw.inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED
        pw.showAtLocation(anchor, Gravity.NO_GRAVITY, 0, y)
        popup = pw
        follow(pw, anchor, input, gap, y)
        // запоминаем, где закрыли (перекрывает слушатель из follow, поэтому
        // сами снимаем слежение и гасим popup). В поиске не сохраняем: индекс
        // отфильтрованного списка на полном наборе указывал бы не туда.
        pw.setOnDismissListener {
            L.safe("сохранение прокрутки") {
                if (query.isEmpty()) savedScroll = grid.firstVisiblePosition
            }
            detach()
            popup = null
        }
    }

    /**
     * Держим поповер приклеенным к панели ввода.
     *
     * Позицию нельзя посчитать один раз: поповер забирает фокус, клавиатура
     * прячется, панель ввода уезжает вниз — и окно остаётся висеть посреди
     * экрана. Поэтому пересчитываем на каждой перерисовке разметки.
     */
    private fun follow(pw: PopupWindow, anchor: View, input: EditText, gap: Int, startY: Int) {
        detach()
        var lastY = startY
        val w = ViewTreeObserver.OnGlobalLayoutListener {
            L.safe("позиция поповера") {
                if (!pw.isShowing) return@safe
                val t = panelTop(anchor, input)
                if (t <= 0) return@safe
                val y = (t - pw.height - gap).coerceAtLeast(0)
                // без сравнения update снова вызвал бы разметку — и так по кругу
                if (y == lastY) return@safe
                lastY = y
                pw.update(0, y, -1, -1)
            }
        }
        anchor.viewTreeObserver.addOnGlobalLayoutListener(w)
        watcher = w
        watched = anchor
        pw.setOnDismissListener {
            detach()
            popup = null
        }
    }

    private fun detach() {
        val w = watcher ?: return
        L.safe("снятие слежения") {
            watched?.viewTreeObserver?.removeOnGlobalLayoutListener(w)
        }
        watcher = null
        watched = null
    }

    /**
     * Верхняя граница панели ввода в координатах экрана: берём то, что выше —
     * кнопку, само поле или строку, в которой они лежат. Строка нужна затем,
     * что у кнопки бывают отступы, и без неё поповер сел бы ей на макушку.
     */
    private fun panelTop(anchor: View, input: EditText): Int {
        var top = Int.MAX_VALUE
        for (v in listOf(anchor, anchor.parent as? View, input, input.parent as? View)) {
            if (v == null || !v.isAttachedToWindow) continue
            val p = IntArray(2)
            v.getLocationOnScreen(p)
            if (p[1] in 1 until top) top = p[1]
        }
        return if (top == Int.MAX_VALUE) 0 else top
    }

    private fun header(ctx: Context): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Inject.dp(ctx, 12), Inject.dp(ctx, 10), Inject.dp(ctx, 12), Inject.dp(ctx, 8))
        }
        row.addView(
            TextView(ctx).apply {
                text = "7TV"
                setTextColor(Ui.TEXT)
                typeface = Typeface.DEFAULT_BOLD
                textSize = 14f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        row.addView(
            TextView(ctx).apply {
                text = "✕"
                setTextColor(Ui.MUTED)
                textSize = 15f
                setPadding(Inject.dp(ctx, 8), 0, 0, 0)
                setOnClickListener { popup?.dismiss(); popup = null }
            },
        )
        return row
    }

    private fun search(ctx: Context): EditText = EditText(ctx).apply {
        contentDescription = Inject.OUR_UI // чтобы не стать «последним полем ввода»
        hint = "Поиск эмоута"
        setHintTextColor(Ui.MUTED)
        setTextColor(Ui.TEXT)
        textSize = 13f
        isSingleLine = true
        background = GradientDrawable().apply {
            setColor(Ui.BG2)
            cornerRadius = Inject.dp(ctx, 8).toFloat()
            setStroke(Inject.dp(ctx, 1), Ui.BORDER)
        }
        setPadding(Inject.dp(ctx, 10), Inject.dp(ctx, 7), Inject.dp(ctx, 10), Inject.dp(ctx, 7))
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.setMargins(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 8))
        layoutParams = lp
    }

    /**
     * Наборы, которые можно подключить: слово вида «имя_ник» пришло в чат,
     * эмоута у нас нет, а по API он у стримера нашёлся.
     */
    private fun fillSuggests(ctx: Context, box: LinearLayout) {
        box.removeAllViews()
        val hits = Suggest.hits()
        if (hits.isEmpty()) {
            box.visibility = View.GONE
            return
        }
        box.visibility = View.VISIBLE
        box.addView(label(ctx, "МОЖНО ПОДКЛЮЧИТЬ"))
        for (h in hits) box.addView(suggestRow(ctx, box, h))
    }

    private fun suggestRow(ctx: Context, box: LinearLayout, h: Suggest.Hit): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(Inject.dp(ctx, 6), Inject.dp(ctx, 6), Inject.dp(ctx, 8), Inject.dp(ctx, 6))
            background = GradientDrawable().apply {
                setColor(Ui.BG2)
                cornerRadius = Inject.dp(ctx, 8).toFloat()
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            lp.bottomMargin = Inject.dp(ctx, 4)
            layoutParams = lp
        }

        val iv = ImageView(ctx)
        iv.layoutParams = LinearLayout.LayoutParams(Inject.dp(ctx, 32), Inject.dp(ctx, 32))
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        iv.contentDescription = h.name
        bind(iv, Emote(h.name, h.url, false))
        row.addView(iv)

        row.addView(
            TextView(ctx).apply {
                text = "_${h.ref.slug}\n${h.count} эмоутов"
                setTextColor(Ui.TEXT)
                textSize = 12f
                setPadding(Inject.dp(ctx, 8), 0, 0, 0)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )

        row.addView(
            TextView(ctx).apply {
                text = "подключить"
                setTextColor(Ui.ACCENT)
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
            },
        )

        row.setOnClickListener { L.safe("подключение набора") { connect(ctx, box, h) } }
        return row
    }

    private fun connect(ctx: Context, box: LinearLayout, h: Suggest.Hit) {
        toast(ctx, "Подключаю ${h.ref.name}…")
        Thread({
            val msg = try {
                Config.addSet(h.ref)
                Suggest.forget(h.ref.slug)
                Boot.reload(ctx)
                "Набор ${h.ref.name} подключён"
            } catch (t: Throwable) {
                L.human(t)
            }
            main.post {
                toast(ctx, msg)
                L.safe("обновление предложений") { fillSuggests(ctx, box) }
            }
        }, "vk7tv-connect").apply { isDaemon = true }.start()
    }

    private fun fillFavorites(ctx: Context, box: LinearLayout, input: EditText) {
        box.removeAllViews()
        // эмоуты отключённого набора просто не показываем
        val found = Config.favorites.mapNotNull { Emotes.get(it) }
        if (found.isEmpty()) {
            box.visibility = View.GONE
            return
        }
        box.visibility = View.VISIBLE
        box.addView(label(ctx, "ИЗБРАННОЕ"))
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val cell = Inject.dp(ctx, CELL_DP)
        for (e in found) {
            row.addView(
                cellView(ctx, e, cell, { insert(input, e.name) }) {
                    Config.toggleFavorite(e.name)
                    fillFavorites(ctx, box, input)
                    toast(ctx, "${e.name} убран из избранного")
                },
            )
        }
        box.addView(
            HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(row)
            },
        )
    }

    private fun chips(ctx: Context, selected: Int, onPick: (Int) -> Unit): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 8))
        }
        val scroll = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(row)
        }
        val chips = ArrayList<TextView>()
        fun paint(t: TextView, on: Boolean) {
            t.setTextColor(if (on) Ui.TEXT else Ui.MUTED)
            (t.background as GradientDrawable).setColor(if (on) Ui.HOVER else Ui.BG2)
        }
        fun chip(title: String, index: Int) {
            val on = index == selected
            val t = TextView(ctx).apply {
                text = title
                textSize = 11f
                setPadding(Inject.dp(ctx, 10), Inject.dp(ctx, 5), Inject.dp(ctx, 10), Inject.dp(ctx, 5))
                background = GradientDrawable().apply { cornerRadius = Inject.dp(ctx, 12).toFloat() }
            }
            paint(t, on)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            lp.rightMargin = Inject.dp(ctx, 6)
            t.layoutParams = lp
            t.setOnClickListener {
                for (c in chips) paint(c, false)
                paint(t, true)
                onPick(index)
            }
            chips.add(t)
            row.addView(t)
            // восстановленный набор мог быть далеко справа — подматываем к нему,
            // иначе выделенный чип оказался бы за краем экрана
            if (on) scroll.post {
                L.safe("прокрутка чипов") {
                    scroll.scrollTo((t.left - Inject.dp(ctx, 12)).coerceAtLeast(0), 0)
                }
            }
        }
        chip("Все", -1)
        Emotes.groups.forEachIndexed { i, g -> chip(g.title, i) }
        return scroll
    }

    private fun label(ctx: Context, text: String) = TextView(ctx).apply {
        this.text = text
        textSize = 10f
        setTextColor(Ui.MUTED)
        typeface = Typeface.DEFAULT_BOLD
        setPadding(Inject.dp(ctx, 2), 0, 0, Inject.dp(ctx, 4))
    }

    private fun cellView(
        ctx: Context,
        e: Emote,
        size: Int,
        onTap: () -> Unit,
        onLong: () -> Unit,
    ): ImageView {
        val iv = ImageView(ctx)
        iv.layoutParams = LinearLayout.LayoutParams(size, size)
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        val p = Inject.dp(ctx, 3)
        iv.setPadding(p, p, p, p)
        iv.contentDescription = e.name
        bind(iv, e)
        iv.setOnClickListener { onTap() }
        iv.setOnLongClickListener {
            L.safe("избранное") { onLong() }
            true
        }
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

    private fun insert(input: EditText, name: String) {
        L.safe("вставка эмоута") {
            // поле ВК могло пересоздаться, пока поповер открыт
            val target = if (input.isAttachedToWindow) input else Inject.input() ?: input
            val ed: Editable = target.text ?: return@safe
            val s = target.selectionStart.coerceIn(0, ed.length)
            val e = target.selectionEnd.coerceIn(s, ed.length)
            ed.replace(s, e, "$name ")
        }
    }

    private fun toast(ctx: Context, msg: String) =
        Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()

    private fun r(ctx: Context) = Inject.dp(ctx, 12).toFloat()

    private class EmoteAdapter(
        val ctx: Context,
        var items: List<Emote>,
        val onTap: (String) -> Unit,
        val onFav: (String) -> Unit,
    ) : BaseAdapter() {

        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val size = Inject.dp(ctx, CELL_DP)
            val iv = convertView as? ImageView ?: ImageView(ctx).apply {
                layoutParams = AbsListView.LayoutParams(size, size)
                scaleType = ImageView.ScaleType.FIT_CENTER
                val p = Inject.dp(ctx, 3)
                setPadding(p, p, p, p)
            }
            val e = items[position]
            iv.contentDescription = e.name
            bind(iv, e)
            iv.setOnClickListener { onTap(e.name) }
            iv.setOnLongClickListener {
                L.safe("избранное") { onFav(e.name) }
                true
            }
            return iv
        }
    }
}
