package com.vk7tv.module

import de.robv.android.xposed.XposedBridge

// Логи видно в LSPosed → Журнал. Наружу из хуков не должно вылетать
// ни одного исключения: мы живём в чужом процессе, и неперехваченная
// ошибка роняет не нас, а ВК.
internal object L {

    private const val TAG = "VK7TV"

    @Volatile
    var verbose = false

    fun i(msg: String) {
        XposedBridge.log("$TAG: $msg")
    }

    fun v(msg: String) {
        if (verbose) XposedBridge.log("$TAG: $msg")
    }

    fun e(msg: String, t: Throwable? = null) {
        XposedBridge.log("$TAG: $msg${if (t != null) " — $t" else ""}")
        if (t != null) XposedBridge.log(t)
    }

    inline fun <T> safe(what: String, block: () -> T): T? =
        try {
            block()
        } catch (t: Throwable) {
            e("сбой в $what", t)
            null
        }
}
