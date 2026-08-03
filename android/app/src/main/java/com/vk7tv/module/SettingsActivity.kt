package com.vk7tv.module

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Экран-памятка. Настроек здесь нет намеренно.
 *
 * Под LSPatch модуль встроен прямо в APK ВК и до данных своего приложения
 * не дотягивается, поэтому конфиг живёт в хранилище ВК — а значит и править
 * его надо оттуда же. Настройки открываются долгим тапом по кнопке 7TV
 * внутри самого ВК.
 */
class SettingsActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad(20), pad(24), pad(20), pad(24))
        }

        root.addView(text("VK7TV", 24f, pad(16)))
        root.addView(
            text(
                "Эмоуты 7TV в приложении ВКонтакте. Это модуль — сам по себе " +
                    "он ничего не делает, его должен запустить LSPosed (с рутом) " +
                    "или LSPatch (без рута).",
                14f,
                pad(20),
            ),
        )

        root.addView(text("Как включить", 18f, pad(10)))
        root.addView(
            text(
                "С рутом: в LSPosed включить модуль VK7TV, в области действия " +
                    "отметить ВКонтакте, затем принудительно остановить ВК и запустить.\n\n" +
                    "Без рута: в LSPatch выбрать установленный ВКонтакте, добавить " +
                    "этот модуль, пропатчить и поставить полученный APK.",
                14f,
                pad(20),
            ),
        )

        root.addView(text("Где настройки", 18f, pad(10)))
        root.addView(
            text(
                "Внутри ВК: долгий тап по круглой кнопке 7TV в панели ввода. " +
                    "Там наборы, перенос настроек из браузерного расширения " +
                    "и всё остальное.\n\n" +
                    "Здесь настроек нет и быть не может: модуль работает внутри " +
                    "чужого процесса и хранит конфиг там же, до этого приложения " +
                    "он не дотягивается.",
                14f,
                pad(20),
            ),
        )

        root.addView(text("Избранное", 18f, pad(10)))
        root.addView(
            text(
                "В пикере долгий тап по эмоуту добавляет его в избранное " +
                    "и убирает обратно.",
                14f,
                0,
            ),
        )

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun text(s: String, size: Float, bottom: Int) = TextView(this).apply {
        text = s
        textSize = size
        setPadding(0, 0, 0, bottom)
    }

    private fun pad(v: Int) = (v * resources.displayMetrics.density).toInt()
}
