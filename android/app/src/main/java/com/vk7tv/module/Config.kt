package com.vk7tv.module

import de.robv.android.xposed.XSharedPreferences
import org.json.JSONArray
import org.json.JSONObject

class SetRef(val id: String, val slug: String, val name: String)

// Конфиг лежит в SharedPreferences приложения-модуля, а читается из процесса
// ВК — поэтому здесь только мелочь: id наборов, «свои» эмоуты, избранное.
// Сами списки эмоутов (у набора стримера это ~1000 имён) модуль тянет из
// 7tv.io уже внутри процесса ВК: гонять сотни килобайт через prefs незачем,
// да и формат тогда совпадает с тем, что качает расширение.
object Config {

    const val PKG = "com.vk7tv.module"
    const val PREFS = "vk7tv"

    const val KEY_ENABLED = "enabled"
    const val KEY_USE_GLOBAL = "useGlobal"
    const val KEY_SETS = "sets"
    const val KEY_CUSTOM = "customEmotes"
    const val KEY_FAVORITES = "favorites"
    const val KEY_DOCK = "dockButton"

    @Volatile
    var enabled = true
        private set

    @Volatile
    var useGlobal = true
        private set

    @Volatile
    var dockButton = true
        private set

    @Volatile
    var sets: List<SetRef> = emptyList()
        private set

    @Volatile
    var custom: Map<String, String> = emptyMap()
        private set

    @Volatile
    var favorites: List<String> = emptyList()
        private set

    private var prefs: XSharedPreferences? = null

    fun init() {
        val p = XSharedPreferences(PKG, PREFS)
        p.makeWorldReadable()
        prefs = p
        read(p)
    }

    /** Настройки поменяли в приложении-модуле — подхватываем без перезапуска ВК. */
    fun reloadIfChanged(): Boolean {
        val p = prefs ?: return false
        if (!p.hasFileChanged()) return false
        p.reload()
        read(p)
        return true
    }

    private fun read(p: XSharedPreferences) {
        enabled = p.getBoolean(KEY_ENABLED, true)
        useGlobal = p.getBoolean(KEY_USE_GLOBAL, true)
        dockButton = p.getBoolean(KEY_DOCK, true)
        sets = parseSets(p.getString(KEY_SETS, "[]"))
        custom = parseCustom(p.getString(KEY_CUSTOM, "{}"))
        favorites = parseList(p.getString(KEY_FAVORITES, "[]"))
        L.i("конфиг: наборов ${sets.size}, своих ${custom.size}, избранных ${favorites.size}")
    }

    private fun parseSets(raw: String?): List<SetRef> {
        val out = ArrayList<SetRef>()
        L.safe("разбор списка наборов") {
            val arr = JSONArray(raw ?: "[]")
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id")
                if (id.isEmpty()) continue
                out.add(SetRef(id, o.optString("slug"), o.optString("name", id)))
            }
        }
        return out
    }

    private fun parseCustom(raw: String?): Map<String, String> {
        val out = HashMap<String, String>()
        L.safe("разбор своих эмоутов") {
            val o = JSONObject(raw ?: "{}")
            for (k in o.keys()) {
                // расширение хранит либо строку-URL, либо {u, z}
                val v = o.get(k)
                val url = if (v is JSONObject) v.optString("u") else v.toString()
                if (url.isNotEmpty()) out[k] = url
            }
        }
        return out
    }

    private fun parseList(raw: String?): List<String> {
        val out = ArrayList<String>()
        L.safe("разбор избранного") {
            val arr = JSONArray(raw ?: "[]")
            for (i in 0 until arr.length()) out.add(arr.optString(i))
        }
        return out.filter { it.isNotEmpty() }
    }
}
