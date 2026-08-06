package com.vk7tv.module

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import android.widget.Toast

/**
 * Меню долгого тапа по эмоуту в пикере: избранное и «добавить к себе»,
 * у своих эмоутов вместо добавления — изменение и удаление.
 *
 * «Добавить к себе» и «Изменить» открывают одну форму — те же поля, что
 * у «своих эмоутов» в настройках, но уже заполненные именем и ссылкой
 * эмоута, по которому открыли меню. Так свой набор собирается прямо
 * из чужих паков, без ручного копирования ссылок.
 */
object EmoteMenu {

    private val main = Handler(Looper.getMainLooper())

    /**
     * Чем заполнена форма. [id] и [zeroWidth] хранятся отдельно от ссылки,
     * чтобы сохранить эмоут без похода в сеть, пока ссылку не меняли.
     */
    private class Preset(val name: String, val url: String, val id: String, val zeroWidth: Boolean)

    fun show(cell: View, e: Emote, onFav: (String) -> Unit) {
        val ctx = cell.context
        val items = ArrayList<Pair<String, () -> Unit>>()
        items.add(
            (if (Config.isFavorite(e.name)) "Убрать из избранного" else "В избранное") to
                { onFav(e.name) },
        )
        // свой эмоут узнаём по имени вместе с картинкой: голое имя своего
        // может совпадать с эмоутом глобального набора, одного имени мало
        val own = Config.custom.entries.firstOrNull { (name, c) ->
            (name == e.name || c.fullName(name) == e.name) && c.url == e.url
        }
        if (own != null) {
            val c = own.value
            items.add("Изменить" to {
                editor(cell, Preset(own.key, c.url, c.id, c.zeroWidth), edit = own.key)
            })
            items.add("Удалить" to { remove(ctx, own.key) })
        } else {
            items.add("Добавить к себе" to {
                editor(
                    cell,
                    Preset(Emotes.bareName(e.name), e.url, SevenTv.emoteId(e.url), e.zeroWidth),
                    edit = null,
                )
            })
        }
        cell.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        menu(cell, items)
    }

    private fun menu(anchor: View, items: List<Pair<String, () -> Unit>>) {
        val ctx = anchor.context
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, Inject.dp(ctx, 4), 0, Inject.dp(ctx, 4))
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = Inject.dp(ctx, 10).toFloat()
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
        }
        val pw = PopupWindow(
            box,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            true,
        )
        pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        pw.isOutsideTouchable = true
        for ((title, action) in items) {
            box.addView(
                TextView(ctx).apply {
                    text = title
                    setTextColor(Ui.TEXT)
                    textSize = 13f
                    setPadding(
                        Inject.dp(ctx, 14),
                        Inject.dp(ctx, 10),
                        Inject.dp(ctx, 14),
                        Inject.dp(ctx, 10),
                    )
                    setOnClickListener {
                        pw.dismiss()
                        L.safe("пункт «$title»") { action() }
                    }
                },
            )
        }
        // у нижнего ряда сетки места под ячейкой нет — showAsDropDown сам
        // поднимает меню выше якоря, когда снизу не влезает
        pw.showAsDropDown(anchor)
    }

    /** Убрать свой эмоут; реестр пересобирается в фоне — Boot.reload читает диск. */
    private fun remove(ctx: Context, name: String) {
        Config.removeCustom(name)
        toast(ctx, "«$name» убран из своих")
        Thread({
            L.safe("перезагрузка после удаления") { Boot.reload(ctx) }
        }, "vk7tv-remove").apply { isDaemon = true }.start()
    }

    /**
     * Форма своего эмоута. [edit] — имя существующего: сохранение
     * перезаписывает его на месте ([Config.editCustom]); null — добавление.
     */
    private fun editor(anchor: View, preset: Preset, edit: String?) {
        val ctx = anchor.context
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Inject.dp(ctx, 16), Inject.dp(ctx, 14), Inject.dp(ctx, 16), Inject.dp(ctx, 16))
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = Inject.dp(ctx, 12).toFloat()
                setStroke(Inject.dp(ctx, 1), Ui.BORDER)
            }
        }
        val pw = PopupWindow(
            root,
            ctx.resources.displayMetrics.widthPixels - Inject.dp(ctx, 32),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            true,
        )
        pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        pw.isOutsideTouchable = true
        pw.inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED

        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        // превью: видно, тот ли эмоут открыли, ещё до сохранения
        val iv = ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(Inject.dp(ctx, 26), Inject.dp(ctx, 26))
                .apply { rightMargin = Inject.dp(ctx, 8) }
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = preset.name
        }
        PickerUi.bind(iv, Emote(preset.name, preset.url, false))
        head.addView(iv)
        head.addView(
            TextView(ctx).apply {
                text = if (edit != null) "Изменить эмоут" else "Добавить к себе"
                setTextColor(Ui.TEXT)
                typeface = Typeface.DEFAULT_BOLD
                textSize = 15f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        head.addView(
            TextView(ctx).apply {
                text = "✕"
                setTextColor(Ui.MUTED)
                textSize = 16f
                setPadding(Inject.dp(ctx, 10), 0, 0, 0)
                setOnClickListener { pw.dismiss() }
            },
        )
        root.addView(head)

        val name = field(ctx, "Имя (одно слово)").apply { setText(preset.name) }
        root.addView(name)
        val url = field(ctx, "Ссылка на эмоут с 7tv.app").apply { setText(preset.url) }
        root.addView(url)

        root.addView(
            button(ctx, if (edit != null) "Сохранить" else "Добавить") {
                val rawUrl = url.text.toString().trim()
                if (rawUrl.isEmpty()) {
                    toast(ctx, "Вставь ссылку на эмоут")
                    return@button
                }
                val wanted = name.text.toString().trim()
                if (wanted.contains(' ')) {
                    toast(ctx, "Имя — одно слово без пробелов")
                    return@button
                }
                toast(ctx, "Сохраняю…")
                Thread({
                    val msg = try {
                        // ссылку не трогали — id и флаг zero-width уже известны,
                        // в сеть не ходим: правка имени и добавление из пикера
                        // должны работать и там, где 7tv.io недоступен без VPN
                        val ref = if (rawUrl == preset.url) {
                            SevenTv.EmoteRef(
                                preset.id,
                                wanted.ifEmpty { preset.name },
                                preset.url,
                                preset.zeroWidth,
                            )
                        } else {
                            SevenTv.resolveEmote(rawUrl, wanted)
                        }
                        val saved = if (edit != null) {
                            Config.editCustom(edit, ref.name, ref.url, ref.id, ref.zeroWidth)
                        } else {
                            Config.addCustom(ref.name, ref.url, ref.id, ref.zeroWidth)
                        }
                        Shared.forget(ref.id)
                        Boot.reload(ctx)
                        main.post { L.safe("закрытие формы эмоута") { pw.dismiss() } }
                        when {
                            edit != null -> "«$saved» обновлён"
                            ref.id.isEmpty() -> "«$saved» добавлен — работает только у тебя"
                            else -> "«${saved}_${ref.id}» добавлен — собеседник увидит картинку"
                        }
                    } catch (t: Throwable) {
                        L.human(t)
                    }
                    main.post { toast(ctx, msg) }
                }, "vk7tv-emote-form").apply { isDaemon = true }.start()
            },
        )

        // Якорь окна — поле ввода клиента, а не ячейка пикера: showAtLocation
        // берёт токен окна якоря, ячейка живёт в окне самого пикера
        // (PopupWindow), а окно-панель поверх другой панели система не
        // добавляет — BadTokenException, и форма молча не открывалась.
        // showAsDropDown в menu() не задет: он берёт токен окна приложения.
        pw.showAtLocation(Inject.input() ?: anchor, Gravity.CENTER, 0, 0)
    }

    private fun field(ctx: Context, hint: String) = EditText(ctx).apply {
        contentDescription = Inject.OUR_UI // см. Inject.OUR_UI
        this.hint = hint
        setHintTextColor(Ui.MUTED)
        setTextColor(Ui.TEXT)
        textSize = 13f
        isSingleLine = true
        background = GradientDrawable().apply {
            setColor(Ui.BG2)
            cornerRadius = Inject.dp(ctx, 8).toFloat()
            setStroke(Inject.dp(ctx, 1), Ui.BORDER)
        }
        setPadding(Inject.dp(ctx, 10), Inject.dp(ctx, 8), Inject.dp(ctx, 10), Inject.dp(ctx, 8))
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.topMargin = Inject.dp(ctx, 8)
        layoutParams = lp
    }

    private fun button(ctx: Context, title: String, onTap: () -> Unit) = TextView(ctx).apply {
        text = title
        setTextColor(Ui.TEXT)
        textSize = 13f
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
            setColor(Ui.HOVER)
            cornerRadius = Inject.dp(ctx, 8).toFloat()
            setStroke(Inject.dp(ctx, 1), Ui.BORDER)
        }
        setPadding(Inject.dp(ctx, 12), Inject.dp(ctx, 10), Inject.dp(ctx, 12), Inject.dp(ctx, 10))
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.topMargin = Inject.dp(ctx, 10)
        layoutParams = lp
        setOnClickListener { L.safe("кнопка «$title»") { onTap() } }
    }

    private fun toast(ctx: Context, msg: String) =
        Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
}
