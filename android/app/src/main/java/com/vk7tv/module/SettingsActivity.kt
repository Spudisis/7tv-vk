package com.vk7tv.module

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

/**
 * Настройки модуля. Хранилище общее с процессом ВК: тот читает эти же
 * SharedPreferences через XSharedPreferences, поэтому файл должен быть
 * world-readable — LSPosed для модулей это разрешает.
 *
 * Главный путь настройки — импорт того же JSON, который отдаёт «Резервная
 * копия настроек» в попапе расширения: наборы, свои эмоуты и избранное
 * приезжают на телефон одним файлом.
 */
class SettingsActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var status: TextView
    private lateinit var setsBox: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val ok = openPrefs()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad(16), pad(20), pad(16), pad(20))
        }

        root.addView(title("VK7TV"))
        if (!ok) {
            root.addView(
                note(
                    "Не удалось открыть общие настройки. Включи модуль в LSPosed " +
                        "и перезапусти это приложение — без этого процесс ВК не сможет " +
                        "прочитать конфиг.",
                ),
            )
            setContentView(ScrollView(this).apply { addView(root) })
            return
        }

        root.addView(
            toggle("Эмоуты включены", Config.KEY_ENABLED, true),
        )
        root.addView(
            toggle("Кнопка в панели ввода", Config.KEY_DOCK, true),
        )
        root.addView(
            toggle("Глобальный набор 7TV", Config.KEY_USE_GLOBAL, true),
        )

        root.addView(note("Наборы"))
        setsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(setsBox)

        val input = EditText(this).apply {
            hint = "Ссылка на набор 7tv.app или его ID"
            isSingleLine = true
        }
        root.addView(input)
        root.addView(
            Button(this).apply {
                text = "Добавить набор"
                setOnClickListener { addSet(input.text.toString()) }
            },
        )

        root.addView(
            Button(this).apply {
                text = "Импорт настроек из расширения"
                setOnClickListener { pickBackup() }
            },
        )

        status = TextView(this).apply {
            setPadding(0, pad(16), 0, 0)
            textSize = 12f
        }
        root.addView(status)
        root.addView(
            note(
                "Списки эмоутов сюда не копируются — модуль тянет их с 7tv.io сам, " +
                    "по тем же id наборов. Поэтому файл настроек лёгкий, а картинки " +
                    "всегда свежие.",
            ),
        )

        setContentView(ScrollView(this).apply { addView(root) })
        redraw()
    }

    @Suppress("DEPRECATION")
    private fun openPrefs(): Boolean = try {
        prefs = getSharedPreferences(Config.PREFS, Context.MODE_WORLD_READABLE)
        true
    } catch (t: Throwable) {
        false
    }

    private fun redraw() {
        val sets = JSONArray(str(Config.KEY_SETS, "[]"))
        setsBox.removeAllViews()
        for (i in 0 until sets.length()) {
            val o = sets.optJSONObject(i) ?: continue
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            row.addView(
                TextView(this).apply {
                    text = o.optString("name", o.optString("id"))
                    textSize = 13f
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
            )
            row.addView(
                Button(this).apply {
                    text = "убрать"
                    setOnClickListener { removeSet(o.optString("id")) }
                },
            )
            setsBox.addView(row)
        }

        val custom = JSONObject(str(Config.KEY_CUSTOM, "{}")).length()
        val favs = JSONArray(str(Config.KEY_FAVORITES, "[]")).length()
        status.text = "Наборов ${sets.length()}, своих эмоутов $custom, избранных $favs"
    }

    /** getString умеет вернуть null — разбирать такое JSON-у не надо. */
    private fun str(key: String, def: String): String = prefs.getString(key, def) ?: def

    private fun toggle(label: String, key: String, def: Boolean): View =
        Switch(this).apply {
            text = label
            isChecked = prefs.getBoolean(key, def)
            setOnCheckedChangeListener { _, v -> prefs.edit().putBoolean(key, v).apply() }
        }

    private fun addSet(raw: String) {
        // id набора на 7TV — ULID: 26 символов Crockford base32.
        // Имя и постфикс подтянет сам модуль при первой загрузке набора.
        val m = Regex("[0-9A-HJKMNP-TV-Z]{26}", RegexOption.IGNORE_CASE).find(raw.trim())
        if (m == null) {
            toast("Вставь ссылку вида https://7tv.app/emote-sets/… или сам ID набора")
            return
        }
        val id = m.value.uppercase()
        val sets = JSONArray(str(Config.KEY_SETS, "[]"))
        for (i in 0 until sets.length()) {
            if (sets.optJSONObject(i)?.optString("id") == id) {
                toast("Этот набор уже добавлен")
                return
            }
        }
        sets.put(JSONObject().put("id", id).put("slug", "").put("name", id))
        prefs.edit().putString(Config.KEY_SETS, sets.toString()).apply()
        redraw()
    }

    private fun removeSet(id: String) {
        val sets = JSONArray(str(Config.KEY_SETS, "[]"))
        val next = JSONArray()
        for (i in 0 until sets.length()) {
            val o = sets.optJSONObject(i) ?: continue
            if (o.optString("id") != id) next.put(o)
        }
        prefs.edit().putString(Config.KEY_SETS, next.toString()).apply()
        redraw()
    }

    private fun pickBackup() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        startActivityForResult(i, REQ_BACKUP)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_BACKUP || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try {
            val text = contentResolver.openInputStream(uri)!!.bufferedReader().readText()
            val json = JSONObject(text)
            val e = prefs.edit()
            json.optJSONArray("sets")?.let { e.putString(Config.KEY_SETS, it.toString()) }
            json.optJSONObject("customEmotes")?.let { e.putString(Config.KEY_CUSTOM, it.toString()) }
            json.optJSONArray("favorites")?.let { e.putString(Config.KEY_FAVORITES, it.toString()) }
            if (json.has("useGlobal")) e.putBoolean(Config.KEY_USE_GLOBAL, json.optBoolean("useGlobal", true))
            e.apply()
            redraw()
            toast("Настройки импортированы")
        } catch (t: Throwable) {
            toast("Не похоже на файл настроек VK7TV: ${t.message}")
        }
    }

    private fun title(s: String) = TextView(this).apply {
        text = s
        textSize = 22f
        setPadding(0, 0, 0, pad(12))
    }

    private fun note(s: String) = TextView(this).apply {
        text = s
        textSize = 12f
        setPadding(0, pad(12), 0, pad(4))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    private fun pad(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQ_BACKUP = 1
    }
}
