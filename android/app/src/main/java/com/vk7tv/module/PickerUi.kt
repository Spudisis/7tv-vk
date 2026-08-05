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
import android.text.TextUtils
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
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

    // через столько пробуем пересобрать пикер снова, если вкладку тащат
    private const val DRAG_WAIT_MS = 250L

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

    // ссылки на живой пикер — чтобы дорисовать новый таб, не закрывая панель,
    // когда набор подключили прямо из неё (кнопка «подключить»). Держим корень
    // и поле ввода для повторной сборки, сетку и текущий поиск — для onDismiss.
    private var content: LinearLayout? = null
    private var currentInput: EditText? = null
    private var gridRef: GridView? = null
    private var queryRef: String = ""

    // вкладку сейчас тащат: пересобирать панель нельзя — вьюха уедет из-под
    // пальца, а перестановка не доедет до конфига
    private var dragging = false

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

        val rootView = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            contentDescription = Inject.OUR_UI // см. Inject.isOurs
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = r(ctx)
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
        }
        content = rootView
        currentInput = input
        dragging = false
        populate(ctx, rootView, input)

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
                if (queryRef.isEmpty()) gridRef?.let { savedScroll = it.firstVisiblePosition }
            }
            detach()
            popup = null
            content = null
            currentInput = null
            gridRef = null
        }
    }

    /**
     * Наполнение поповера: заголовок, поиск, подсказки, избранное, чипы, сетка.
     * Вынесено из [show], чтобы пересобрать содержимое прямо в открытой панели,
     * когда список наборов поменялся ([onSetsChanged]) — иначе новый таб
     * появлялся бы только после закрытия и повторного открытия пикера.
     */
    private fun populate(ctx: Context, rootView: LinearLayout, input: EditText) {
        rootView.removeAllViews()
        // не val: после перетаскивания вкладок порядок «Всех» меняется
        var all = Emotes.groups.flatMap { it.emotes }

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
        queryRef = ""

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
        gridRef = grid

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

        // вкладки живут в своей коробке: после перетаскивания ряд пересобираем
        // на новом порядке, не трогая остальную панель
        val chipBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        rootView.addView(chipBox)

        var chipScroll: HorizontalScrollView? = null

        fun buildChips(keepX: Int) {
            chipBox.removeAllViews()
            val row = chips(
                ctx,
                group,
                keepX,
                onPick = { i -> group = i; refresh(restore = false) },
                onReorder = { ids ->
                    // выбранную вкладку держим за саму группу, а не за
                    // индекс: после перестановки индекс указывает на чужую
                    val was = Emotes.groups.getOrNull(group)
                    Config.reorderSets(ids)
                    Emotes.reorderGroups(ids)
                    group = if (was == null) -1 else Emotes.groups.indexOf(was)
                    all = Emotes.groups.flatMap { it.emotes }
                    // Ряд вкладок пересобирается на новом порядке, поэтому
                    // руками переносим на него обе прокрутки — и ленты вкладок,
                    // и сетки. Иначе перетаскивание выглядит так, будто пикер
                    // заодно прыгнул в начало.
                    savedScroll = grid.firstVisiblePosition
                    buildChips(chipScroll?.scrollX ?: 0)
                    refresh(restore = true)
                    toast(ctx, "Порядок наборов сохранён")
                },
            )
            chipScroll = row
            chipBox.addView(row)
        }
        // -1 — «сам подмотайся к выбранной вкладке»: пикер только открылся
        buildChips(-1)

        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                query = s?.toString()?.trim() ?: ""
                queryRef = query
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
    }

    /**
     * Список наборов поменялся (подключили/обновили набор) — дорисовываем табы
     * в уже открытом пикере, не закрывая его. Зовётся из [Boot.reload], который
     * работает не на UI-потоке, поэтому переносим на главный.
     */
    fun onSetsChanged() {
        main.post {
            L.safe("живое обновление пикера") {
                val root = content ?: return@safe
                val input = currentInput ?: return@safe
                if (popup?.isShowing != true) return@safe
                // вкладку тащат прямо сейчас — ждём, пока отпустят: пересборка
                // вырвала бы её из-под пальца. Пикер закроют — выйдем на
                // проверке isShowing выше, так что это не вечный цикл.
                if (dragging) {
                    main.postDelayed({ onSetsChanged() }, DRAG_WAIT_MS)
                    return@safe
                }
                populate(root.context, root, input)
            }
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
                text = "7VK"
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
        // раньше карточки стояли столбиком и при десятке предложений съедали
        // всю сетку эмоутов; теперь это горизонтальная лента фиксированной
        // высоты — сколько бы наборов ни нашлось, сетка не сдвигается
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        for (h in hits) {
            row.addView(suggestCard(ctx, h, Inject.dp(ctx, 150)) { fillSuggests(ctx, box) })
        }
        box.addView(
            HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(row)
            },
        )
    }

    /**
     * Карточка предложения: превью, ник и число эмоутов, «подключить» по тапу
     * и крестик — скрыть набор из предложений насовсем ([Suggest.dismiss]),
     * не выключая саму функцию.
     *
     * Одна на два места — ленту в пикере и поповер по тапу в сообщении
     * ([SuggestUi]): один и тот же вид, один и тот же путь загрузки картинки.
     * [onChanged] зовём, когда карточка сделала своё дело: в ленте это
     * перерисовка, в поповере — закрытие.
     */
    internal fun suggestCard(
        ctx: Context,
        h: Suggest.Hit,
        width: Int,
        onChanged: () -> Unit,
    ): View {
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Inject.dp(ctx, 8), Inject.dp(ctx, 6), Inject.dp(ctx, 8), Inject.dp(ctx, 6))
            background = GradientDrawable().apply {
                setColor(Ui.BG2)
                cornerRadius = Inject.dp(ctx, 8).toFloat()
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
            val lp = LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = Inject.dp(ctx, 8)
            layoutParams = lp
        }

        val top = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val iv = ImageView(ctx)
        iv.layoutParams = LinearLayout.LayoutParams(Inject.dp(ctx, 32), Inject.dp(ctx, 32))
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        iv.contentDescription = h.name
        bind(iv, Emote(h.name, h.url, false))
        top.addView(iv)

        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        col.addView(
            TextView(ctx).apply {
                text = "_${h.ref.slug}"
                setTextColor(Ui.TEXT)
                textSize = 12f
                isSingleLine = true
                ellipsize = TextUtils.TruncateAt.END
            },
        )
        col.addView(
            TextView(ctx).apply {
                text = "${h.count} эмоутов"
                setTextColor(Ui.MUTED)
                textSize = 10f
            },
        )
        top.addView(
            col,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = Inject.dp(ctx, 8)
            },
        )

        // крестик со своим обработчиком: тап по нему тратится на скрытие и не
        // всплывает к карточке, поэтому набор не подключится по ошибке
        top.addView(
            TextView(ctx).apply {
                text = "✕"
                setTextColor(Ui.MUTED)
                textSize = 13f
                setPadding(Inject.dp(ctx, 6), Inject.dp(ctx, 2), Inject.dp(ctx, 2), Inject.dp(ctx, 2))
                setOnClickListener {
                    L.safe("скрытие предложения") {
                        Suggest.dismiss(h.ref.slug)
                        onChanged()
                        toast(ctx, "Скрыл _${h.ref.slug}")
                    }
                }
            },
        )
        card.addView(top)

        card.addView(
            TextView(ctx).apply {
                text = "подключить"
                setTextColor(Ui.ACCENT)
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                val lp = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
                lp.topMargin = Inject.dp(ctx, 4)
                layoutParams = lp
            },
        )

        card.setOnClickListener {
            L.safe("подключение набора") {
                connect(ctx, h)
                onChanged()
            }
        }
        return card
    }

    internal fun connect(ctx: Context, h: Suggest.Hit) {
        toast(ctx, "Подключаю ${h.ref.name}…")
        Thread({
            val msg = try {
                Config.addSet(h.ref)
                Suggest.forget(h.ref.slug)
                // Boot.reload дёрнет onSetsChanged — открытый пикер сам пересоберётся
                // с новым табом, а строка подсказок обновится тем же проходом
                Boot.reload(ctx)
                "Набор ${h.ref.name} подключён"
            } catch (t: Throwable) {
                L.human(t)
            }
            main.post { toast(ctx, msg) }
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

    /**
     * Ряд вкладок: «Все», глобальный набор, подключённые наборы, «свои эмоуты».
     *
     * Вкладку набора можно зажать и перетащить — порядок наборов меняется
     * и запоминается ([onReorder]). Остальные вкладки не двигаются: своего
     * набора за ними нет, и место у них постоянное.
     *
     * [startX] — куда прокрутить ленту: 0 и больше значит «ровно сюда» (ряд
     * пересобрали после перетаскивания, и он должен остаться на месте),
     * отрицательное — «подмотайся к выбранной вкладке сам».
     */
    private fun chips(
        ctx: Context,
        selected: Int,
        startX: Int,
        onPick: (Int) -> Unit,
        onReorder: (List<String>) -> Unit,
    ): HorizontalScrollView {
        val gap = Inject.dp(ctx, 6)
        // Считаем слева направо: и подмотка к выбранной вкладке, и вся
        // геометрия перетаскивания опираются на left/rightMargin. На арабской
        // локали LinearLayout разложил бы ряд наоборот, и обе сломались бы.
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = View.LAYOUT_DIRECTION_LTR
            setPadding(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 8))
        }
        val scroll = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            layoutDirection = View.LAYOUT_DIRECTION_LTR
            addView(row)
        }
        val chips = ArrayList<TextView>()
        // вкладки наборов идут подряд — только их и переставляем
        val packs = ArrayList<TextView>()
        val packIds = ArrayList<String>()

        fun paint(t: TextView, on: Boolean) {
            t.setTextColor(if (on) Ui.TEXT else Ui.MUTED)
            (t.background as GradientDrawable).setColor(if (on) Ui.HOVER else Ui.BG2)
        }
        fun chip(title: String, index: Int): TextView {
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
            lp.rightMargin = gap
            t.layoutParams = lp
            t.setOnClickListener {
                for (c in chips) paint(c, false)
                paint(t, true)
                onPick(index)
            }
            chips.add(t)
            row.addView(t)
            // восстановленный набор мог быть далеко справа — подматываем к нему,
            // иначе выделенный чип оказался бы за краем экрана. Но только при
            // открытии пикера: после перетаскивания лента должна остаться
            // ровно там, где на неё смотрели.
            if (on && startX < 0) scroll.post {
                L.safe("прокрутка чипов") {
                    scroll.scrollTo((t.left - Inject.dp(ctx, 12)).coerceAtLeast(0), 0)
                }
            }
            return t
        }
        chip("Все", -1)
        Emotes.groups.forEachIndexed { i, g ->
            val t = chip(g.title, i)
            val id = g.setId ?: return@forEachIndexed
            packs.add(t)
            packIds.add(id)
        }

        if (packs.size > 1) {
            val drag = ChipDrag(ctx, scroll, packs, gap) { order ->
                onReorder(order.map { packIds[it] })
            }
            for (t in packs) drag.attach(t)
        }
        // ряд пересобрали после перетаскивания — возвращаем ленту на место
        if (startX >= 0) scroll.post {
            L.safe("прокрутка чипов") { scroll.scrollTo(startX, 0) }
        }
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

    /**
     * Перетаскивание вкладок: зажал — потащил — отпустил.
     *
     * Руками, а не через startDragAndDrop: системное перетаскивание рисует тень
     * в окне приложения, а мы живём в PopupWindow, и тень пряталась бы под
     * панелью; подматывать ленту к краям оно тоже не умеет.
     *
     * Пока тащим, в разметку не лезем совсем: у вкладки меняется только
     * translationX, соседи разъезжаются на её ширину той же анимацией. Поэтому
     * left/width всех вкладок остаются такими же, как на старте, и вся
     * геометрия считается по ним напрямую. Порядок применяем один раз, когда
     * палец оторвали, — иначе LinearLayout переразмечался бы на каждый кадр.
     */
    private class ChipDrag(
        private val ctx: Context,
        private val scroll: HorizontalScrollView,
        private val chips: List<TextView>,
        private val gap: Int,
        private val onDone: (List<Int>) -> Unit,
    ) {

        private val main = Handler(Looper.getMainLooper())
        private val at = IntArray(2)

        private var view: TextView? = null
        private var from = 0
        private var to = 0
        private var grab = 0f // за какое место вкладки держит палец
        private var lastRawX = 0f
        private var width = 0 // ширина вкладки вместе с отступом
        private var touching = false // палец на экране — есть кому отпустить

        // до дальнего набора пальцем не дотянуться — у краёв подматываем ленту
        private val edge = Inject.dp(ctx, 40)
        private val step = Inject.dp(ctx, 10)

        private val autoScroll = object : Runnable {
            override fun run() {
                val v = view ?: return
                if (!v.isAttachedToWindow) return
                L.safe("подмотка вкладок") {
                    val max = (scroll.getChildAt(0).width - scroll.width).coerceAtLeast(0)
                    val x = lastRawX - onScreen(scroll)
                    val d = when {
                        x < edge && scroll.scrollX > 0 -> -step
                        x > scroll.width - edge && scroll.scrollX < max -> step
                        else -> 0
                    }
                    if (d != 0) {
                        scroll.scrollBy(d, 0)
                        // палец на месте, а лента уехала — пересчитываем
                        move(lastRawX)
                    }
                }
                main.postDelayed(this, FRAME_MS)
            }
        }

        fun attach(chip: TextView) {
            // DOWN не перехватываем: пусть вьюха сама заводит счётчик долгого
            // нажатия, а короткий тап по-прежнему выбирает набор
            chip.setOnTouchListener { _, e ->
                when (e.actionMasked) {
                    MotionEvent.ACTION_DOWN -> {
                        touching = true
                        lastRawX = e.rawX
                        false
                    }
                    MotionEvent.ACTION_MOVE -> {
                        lastRawX = e.rawX
                        if (view == null) false else { move(e.rawX); true }
                    }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                        touching = false
                        if (view == null) false else { drop(); true }
                    }
                    else -> false
                }
            }
            chip.setOnLongClickListener {
                // true — вкладку взяли, и тап после отпускания не засчитываем:
                // это было перетаскивание, а не выбор набора
                L.safe("захват вкладки") { start(chip) } == true
            }
        }

        private fun start(chip: TextView): Boolean {
            // Долгое нажатие прилетает не только от пальца: его шлют TalkBack,
            // Switch Access и DPAD_CENTER с клавиатуры. Жеста за таким нажатием
            // нет, ACTION_UP не придёт — и перетаскивание осталось бы
            // «включённым» навсегда: вкладка приподнятой, флаг dragging
            // взведённым, подмотка ленты крутящейся по кадру.
            if (!touching) return false
            if (view != null) return false
            val i = chips.indexOf(chip)
            if (i < 0 || chip.width == 0) return false
            view = chip
            from = i
            to = i
            width = chip.width + gap
            PickerUi.dragging = true
            grab = inRow(lastRawX) - chip.left
            // bringToFront нельзя: он меняет порядок детей, а LinearLayout
            // раскладывает их именно по нему — вкладка прыгнула бы в конец
            chip.translationZ = Inject.dp(ctx, 6).toFloat()
            chip.alpha = 0.92f
            chip.scaleX = LIFT
            chip.scaleY = LIFT
            (chip.background as? GradientDrawable)?.setStroke(Inject.dp(ctx, 1), Ui.ACCENT)
            chip.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            // иначе лента начнёт прокручиваться и заберёт жест себе
            scroll.requestDisallowInterceptTouchEvent(true)
            main.postDelayed(autoScroll, FRAME_MS)
            return true
        }

        private fun move(rawX: Float) {
            val v = view ?: return
            // за пределы полосы наборов вкладку не выпускаем: соседние вкладки
            // не наши, и меняться местами с ними нельзя
            val lo = chips.first().left.toFloat()
            val hi = (chips.last().left + chips.last().width - v.width).toFloat()
            val left = (inRow(rawX) - grab).coerceIn(minOf(lo, hi), maxOf(lo, hi))
            v.translationX = left - v.left
            slot(left + v.width / 2f)
        }

        /**
         * Куда вкладка встанет, если отпустить сейчас, — в ближайший по центру
         * слот; соседей раздвигаем сразу.
         *
         * Сравнивать с серединами соседей нельзя: сосед слева и сосед справа
         * стоят несимметрично относительно перетаскиваемой вкладки, и порог
         * в одну сторону выходил в целую вкладку хода, а в другую срабатывал
         * от первого же пикселя. Центры слотов симметричны по определению:
         * слот [k] — это ровно [travel] от исходного места.
         */
        private fun slot(center: Float) {
            val v = view ?: return
            val base = v.left + v.width / 2f
            var best = from
            var least = Math.abs(center - base)
            var d = 0f
            for (j in from until chips.size - 1) {
                d += other(j).width + gap
                val dist = Math.abs(center - (base + d))
                if (dist < least) { least = dist; best = j + 1 }
            }
            d = 0f
            for (j in from - 1 downTo 0) {
                d += other(j).width + gap
                val dist = Math.abs(center - (base - d))
                if (dist < least) { least = dist; best = j }
            }
            if (best == to) return
            to = best
            for (j in 0 until chips.size - 1) {
                val shift = when {
                    j >= from && j < best -> -width // ушёл влево, освобождая место
                    j < from && j >= best -> width // ушёл вправо
                    else -> 0
                }
                other(j).animate().translationX(shift.toFloat()).setDuration(SLIDE_MS).start()
            }
        }

        /** Сосед [j] — то есть вкладка [j] в списке без самой перетаскиваемой. */
        private fun other(j: Int) = chips[if (j < from) j else j + 1]

        private fun drop() {
            val v = view ?: return
            view = null
            main.removeCallbacks(autoScroll)
            scroll.requestDisallowInterceptTouchEvent(false)
            val target = to
            v.animate().translationX(travel(target)).setDuration(SLIDE_MS).withEndAction {
                L.safe("перестановка вкладок") {
                    PickerUi.dragging = false
                    unlift(v)
                    if (target == from) {
                        v.translationX = 0f
                        return@safe
                    }
                    val order = ArrayList<Int>(chips.size)
                    for (j in 0 until chips.size - 1) {
                        if (j == target) order.add(from)
                        order.add(if (j < from) j else j + 1)
                    }
                    if (target >= chips.size - 1) order.add(from)
                    onDone(order)
                }
            }.start()
        }

        /** Сколько вкладке доехать, чтобы встать ровно в слот [target]. */
        private fun travel(target: Int): Float {
            var d = 0f
            if (target > from) for (j in from until target) d += other(j).width + gap
            if (target < from) for (j in target until from) d -= (other(j).width + gap).toFloat()
            return d
        }

        private fun unlift(v: TextView) {
            // UP до onTouchEvent не доехал (мы его съели) — снимаем нажатие сами
            v.isPressed = false
            v.translationZ = 0f
            v.alpha = 1f
            v.scaleX = 1f
            v.scaleY = 1f
            (v.background as? GradientDrawable)?.setStroke(0, 0)
        }

        /** Палец в координатах ленты: прокрутку учитывает сама getLocationOnScreen. */
        private fun inRow(rawX: Float): Float = rawX - onScreen(scroll.getChildAt(0))

        private fun onScreen(v: View): Int {
            v.getLocationOnScreen(at)
            return at[0]
        }

        private companion object {
            const val FRAME_MS = 16L
            const val SLIDE_MS = 130L
            const val LIFT = 1.06f
        }
    }

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
