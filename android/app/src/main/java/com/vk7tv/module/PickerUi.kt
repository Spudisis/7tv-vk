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
                cornerRadii = floatArrayOf(r(ctx), r(ctx), r(ctx), r(ctx), 0f, 0f, 0f, 0f)
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
        }

        rootView.addView(header(ctx))
        val search = search(ctx)
        rootView.addView(search)

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

        var group = -1 // -1 = все наборы
        var query = ""
        fun refresh() {
            val base = if (group < 0) all else Emotes.groups.getOrNull(group)?.emotes ?: all
            adapter.items = if (query.isEmpty()) base
            else base.filter { it.name.contains(query, ignoreCase = true) }
            adapter.notifyDataSetChanged()
        }

        rootView.addView(chips(ctx) { i -> group = i; refresh() })

        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                query = s?.toString()?.trim() ?: ""
                refresh()
            }

            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) = Unit
        })

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
        rootView.addView(
            grid,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        val h = (ctx.resources.displayMetrics.heightPixels * 0.45f).toInt()
        val pw = PopupWindow(rootView, WindowManager.LayoutParams.MATCH_PARENT, h, true)
        pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        pw.isOutsideTouchable = true
        pw.inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED
        pw.showAtLocation(anchor, Gravity.BOTTOM, 0, 0)
        popup = pw
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

    private fun chips(ctx: Context, onPick: (Int) -> Unit): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(Inject.dp(ctx, 10), 0, Inject.dp(ctx, 10), Inject.dp(ctx, 8))
        }
        val chips = ArrayList<TextView>()
        fun chip(title: String, index: Int) {
            val t = TextView(ctx).apply {
                text = title
                textSize = 11f
                setTextColor(if (index < 0) Ui.TEXT else Ui.MUTED)
                setPadding(Inject.dp(ctx, 10), Inject.dp(ctx, 5), Inject.dp(ctx, 10), Inject.dp(ctx, 5))
                background = GradientDrawable().apply {
                    setColor(if (index < 0) Ui.HOVER else Ui.BG2)
                    cornerRadius = Inject.dp(ctx, 12).toFloat()
                }
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            lp.rightMargin = Inject.dp(ctx, 6)
            t.layoutParams = lp
            t.setOnClickListener {
                for (c in chips) {
                    c.setTextColor(Ui.MUTED)
                    (c.background as GradientDrawable).setColor(Ui.BG2)
                }
                t.setTextColor(Ui.TEXT)
                (t.background as GradientDrawable).setColor(Ui.HOVER)
                onPick(index)
            }
            chips.add(t)
            row.addView(t)
        }
        chip("Все", -1)
        Emotes.groups.forEachIndexed { i, g -> chip(g.title, i) }
        return HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            addView(row)
        }
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
            val ed: Editable = input.text ?: return@safe
            val s = input.selectionStart.coerceIn(0, ed.length)
            val e = input.selectionEnd.coerceIn(s, ed.length)
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
