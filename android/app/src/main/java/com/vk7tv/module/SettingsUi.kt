package com.vk7tv.module

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * Настройки прямо внутри ВК — открываются долгим тапом по кнопке 7VK.
 *
 * Отдельного приложения-настройки нет намеренно: под LSPatch модуль встроен
 * в чужой APK и до данных своего приложения не дотягивается, так что конфиг
 * всё равно живёт в хранилище ВК. Раз он тут — и правится тут же.
 */
object SettingsUi {

    private val main = Handler(Looper.getMainLooper())
    private var popup: PopupWindow? = null

    fun show(anchor: View) {
        popup?.dismiss()
        val ctx = anchor.context

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(ctx, 16), dp(ctx, 14), dp(ctx, 16), dp(ctx, 16))
        }

        root.addView(head(ctx))

        root.addView(switch(ctx, "Эмоуты включены", Config.enabled) {
            Config.setFlag(Config.KEY_ENABLED, it)
        })
        root.addView(switch(ctx, "Глобальный набор 7TV", Config.useGlobal) {
            Config.setFlag(Config.KEY_USE_GLOBAL, it)
            reload(ctx)
        })
        root.addView(switch(ctx, "Кнопка в панели ввода", Config.dockButton) {
            Config.setFlag(Config.KEY_DOCK, it)
            toast(ctx, "Применится после перезапуска ВК")
        })

        root.addView(switch(ctx, "Показывать эмоуты везде", Config.everywhere) {
            Config.setFlag(Config.KEY_EVERYWHERE, it)
            Replacer.rerenderAll()
        })
        root.addView(
            note(
                ctx,
                "По умолчанию коды превращаются в эмоуты только в переписке " +
                    "(список чатов и сам диалог). Включи — эмоуты будут везде: " +
                    "в ленте, комментариях, названиях групп.",
            ),
        )
        root.addView(switch(ctx, "Предлагать наборы стримеров", Config.suggest) {
            Config.setFlag(Config.KEY_SUGGEST, it)
        })
        root.addView(switch(ctx, "Показывать диагностику", Config.diag) {
            Config.setFlag(Config.KEY_DIAG, it)
        })

        root.addView(label(ctx, "НАБОРЫ"))
        val setsBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        root.addView(setsBox)
        drawSets(ctx, setsBox)

        val add = field(ctx, "Ник стримера или ссылка на набор")
        root.addView(add)
        root.addView(
            button(ctx, "Добавить набор") {
                val raw = add.text.toString().trim()
                if (raw.isEmpty()) return@button
                busy(ctx, "Ищем набор…") {
                    val ref = SevenTv.resolve(raw)
                    Config.addSet(ref)
                    Boot.reload(ctx)
                    main.post {
                        add.setText("")
                        drawSets(ctx, setsBox)
                    }
                    "Подключён набор «${ref.name}»"
                }
            },
        )

        root.addView(label(ctx, "ПЕРЕНОС ИЗ РАСШИРЕНИЯ"))
        root.addView(
            note(
                ctx,
                "В попапе расширения: «Резервная копия настроек» → «Сохранить в файл». " +
                    "Открой файл на телефоне, скопируй всё и вставь сюда.",
            ),
        )
        val backup = field(ctx, "{ \"sets\": … }")
        root.addView(backup)
        root.addView(
            button(ctx, "Импортировать") {
                val raw = backup.text.toString().trim()
                if (raw.isEmpty()) return@button
                busy(ctx, "Импорт…") {
                    val summary = Config.importBackup(raw)
                    Boot.reload(ctx)
                    main.post {
                        backup.setText("")
                        drawSets(ctx, setsBox)
                    }
                    summary
                }
            },
        )

        root.addView(
            button(ctx, "Обновить наборы с 7tv.io") {
                // единственное место, где кэш выкидывается и всё качается заново
                busy(ctx, "Обновляем…") {
                    Boot.reload(ctx, force = true)
                    "Готово: эмоутов ${Emotes.size()}"
                }
            },
        )

        root.addView(
            note(
                ctx,
                "Списки эмоутов здесь не хранятся — модуль качает их с 7tv.io " +
                    "по id наборов, поэтому картинки всегда свежие.",
            ),
        )

        root.addView(label(ctx, "КЭШ КАРТИНОК"))
        val cacheNote = note(ctx, "Скачано: считаем…")
        root.addView(cacheNote)
        root.addView(
            note(
                ctx,
                "Картинки хранятся локально, чтобы паки открывались офлайн. Размер " +
                    "ограничен (потолок 300 МБ), давние вытесняются сами. Можно " +
                    "очистить вручную — наборы не пропадут, картинки до-качаются при показе.",
            ),
        )
        root.addView(
            button(ctx, "Очистить кэш картинок") {
                busy(ctx, "Чистим кэш…") {
                    val freed = EmoteCache.clear()
                    val left = EmoteCache.usageBytes()
                    main.post { L.safe("размер кэша") { cacheNote.text = usageText(left) } }
                    "Освобождено ${freed / (1024 * 1024)} МБ"
                }
            },
        )
        refreshCacheSize(cacheNote)

        // 7tv.io и cdn.7tv.app в РФ часто режет провайдер — без этой строчки
        // пустой пикер выглядит как поломка модуля, а не как блокировка.
        root.addView(
            note(
                ctx,
                "Не грузятся наборы или эмоуты? 7tv.io бывает недоступен без VPN — " +
                    "включи его и нажми «Обновить наборы».",
            ),
        )

        // Версия модуля — по ней видно, доехало ли обновление через установщик.
        root.addView(note(ctx, "VK7TV модуль ${BuildConfig.VERSION_NAME}"))

        // Модуль ронял процесс в прошлый раз — показываем стек прямо тут,
        // чтобы его можно было заскринить с телефона без кабеля и logcat.
        Crash.last?.let { trace ->
            root.addView(label(ctx, "ПОСЛЕДНИЙ ВЫЛЕТ"))
            root.addView(
                note(ctx, "Модуль уронил приложение. Пришли этот текст — по нему видно причину:"),
            )
            root.addView(
                TextView(ctx).apply {
                    text = trace.take(2000)
                    textSize = 10f
                    setTextColor(Ui.TEXT)
                    typeface = Typeface.MONOSPACE
                    setTextIsSelectable(true)
                    background = GradientDrawable().apply {
                        setColor(Ui.BG2)
                        cornerRadius = dp(ctx, 8).toFloat()
                        setStroke(dp(ctx, 1), Ui.BORDER)
                    }
                    setPadding(dp(ctx, 10), dp(ctx, 8), dp(ctx, 10), dp(ctx, 8))
                    val lp = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    )
                    lp.topMargin = dp(ctx, 6)
                    layoutParams = lp
                },
            )
        }

        val scroll = ScrollView(ctx).apply {
            background = GradientDrawable().apply {
                setColor(Ui.BG)
                cornerRadius = dp(ctx, 12).toFloat()
                setStroke(dp(ctx, 1), Ui.BORDER)
            }
            addView(root)
        }

        val h = (ctx.resources.displayMetrics.heightPixels * 0.7f).toInt()
        val pw = PopupWindow(scroll, WindowManager.LayoutParams.MATCH_PARENT, h, true)
        pw.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        pw.isOutsideTouchable = true
        pw.inputMethodMode = PopupWindow.INPUT_METHOD_NEEDED
        pw.showAtLocation(anchor, Gravity.CENTER, 0, 0)
        popup = pw
    }

    private fun head(ctx: Context): View {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(
            TextView(ctx).apply {
                text = "Настройки VK7TV"
                setTextColor(Ui.TEXT)
                typeface = Typeface.DEFAULT_BOLD
                textSize = 16f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        row.addView(
            TextView(ctx).apply {
                text = "✕"
                setTextColor(Ui.MUTED)
                textSize = 16f
                setPadding(dp(ctx, 10), 0, 0, 0)
                setOnClickListener { popup?.dismiss(); popup = null }
            },
        )
        return row
    }

    private fun drawSets(ctx: Context, box: LinearLayout) {
        box.removeAllViews()
        if (Config.sets.isEmpty()) {
            box.addView(note(ctx, "Пока ни одного. Впиши ник стримера ниже."))
            return
        }
        for (s in Config.sets) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(ctx, 4), 0, dp(ctx, 4))
            }
            row.addView(
                TextView(ctx).apply {
                    text = if (s.slug.isEmpty()) s.name else "${s.name}  ·  _${s.slug}"
                    setTextColor(Ui.TEXT)
                    textSize = 13f
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            row.addView(
                TextView(ctx).apply {
                    text = "убрать"
                    setTextColor(Ui.MUTED)
                    textSize = 12f
                    setPadding(dp(ctx, 8), dp(ctx, 4), dp(ctx, 4), dp(ctx, 4))
                    setOnClickListener {
                        Config.removeSet(s.id)
                        drawSets(ctx, box)
                        busy(ctx, "Обновляем…") {
                            Boot.reload(ctx)
                            "Набор убран"
                        }
                    }
                },
            )
            box.addView(row)
        }
    }

    /** Сеть — в фоне, результат и ошибка одинаково приезжают тостом. */
    private fun busy(ctx: Context, waiting: String, work: () -> String) {
        toast(ctx, waiting)
        Thread({
            val msg = try {
                work()
            } catch (t: Throwable) {
                L.human(t)
            }
            main.post { toast(ctx, msg) }
        }, "vk7tv-settings").apply { isDaemon = true }.start()
    }

    private fun reload(ctx: Context) = busy(ctx, "Обновляем…") {
        Boot.reload(ctx)
        "Готово: эмоутов ${Emotes.size()}"
    }

    private fun switch(ctx: Context, title: String, on: Boolean, onChange: (Boolean) -> Unit) =
        Switch(ctx).apply {
            text = title
            setTextColor(Ui.TEXT)
            textSize = 13f
            isChecked = on
            setPadding(0, dp(ctx, 6), 0, dp(ctx, 6))
            setOnCheckedChangeListener { _, v -> L.safe("настройка $title") { onChange(v) } }
        }

    private fun field(ctx: Context, hintText: String) = EditText(ctx).apply {
        contentDescription = Inject.OUR_UI // см. Inject.OUR_UI
        hint = hintText
        setHintTextColor(Ui.MUTED)
        setTextColor(Ui.TEXT)
        textSize = 13f
        background = GradientDrawable().apply {
            setColor(Ui.BG2)
            cornerRadius = dp(ctx, 8).toFloat()
            setStroke(dp(ctx, 1), Ui.BORDER)
        }
        setPadding(dp(ctx, 10), dp(ctx, 8), dp(ctx, 10), dp(ctx, 8))
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.topMargin = dp(ctx, 6)
        layoutParams = lp
    }

    private fun button(ctx: Context, title: String, onTap: () -> Unit) = TextView(ctx).apply {
        text = title
        setTextColor(Ui.TEXT)
        textSize = 13f
        gravity = Gravity.CENTER
        background = GradientDrawable().apply {
            setColor(Ui.HOVER)
            cornerRadius = dp(ctx, 8).toFloat()
            setStroke(dp(ctx, 1), Ui.BORDER)
        }
        setPadding(dp(ctx, 12), dp(ctx, 10), dp(ctx, 12), dp(ctx, 10))
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        lp.topMargin = dp(ctx, 8)
        layoutParams = lp
        setOnClickListener { L.safe("кнопка «$title»") { onTap() } }
    }

    private fun label(ctx: Context, text: String) = TextView(ctx).apply {
        this.text = text
        textSize = 10f
        setTextColor(Ui.MUTED)
        typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(ctx, 16), 0, dp(ctx, 6))
    }

    private fun note(ctx: Context, text: String) = TextView(ctx).apply {
        this.text = text
        textSize = 11f
        setTextColor(Ui.MUTED)
        setPadding(0, dp(ctx, 4), 0, dp(ctx, 4))
    }

    private fun usageText(bytes: Long) =
        "Скачано: ${bytes / (1024 * 1024)} МБ из 300"

    /** Размер кэша считаем в фоне: на большом наборе перебор файлов не мгновенный. */
    private fun refreshCacheSize(view: TextView) {
        Thread({
            val bytes = EmoteCache.usageBytes()
            main.post { L.safe("размер кэша") { view.text = usageText(bytes) } }
        }, "vk7tv-cache-size").apply { isDaemon = true }.start()
    }

    private fun toast(ctx: Context, msg: String) =
        Toast.makeText(ctx, "VK7TV: $msg", Toast.LENGTH_SHORT).show()

    private fun dp(ctx: Context, v: Int) = Inject.dp(ctx, v)
}
