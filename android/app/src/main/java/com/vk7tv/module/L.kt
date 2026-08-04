package com.vk7tv.module

import de.robv.android.xposed.XposedBridge
import java.io.IOException

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

    /**
     * Ошибка → текст для пользователя. Сетевой сбой (таймаут, обрыв, хост не
     * резолвится) в РФ почти всегда значит, что 7tv.io режет провайдер, —
     * подсказываем про VPN. Остальное отдаём как есть: там уже человеческий
     * текст («Стример не найден» и т.п.).
     */
    fun human(t: Throwable): String {
        var e: Throwable? = t
        while (e != null) {
            if (e is IOException) return "Не удаётся связаться с 7tv.io — похоже, без VPN он недоступен"
            e = e.cause
        }
        val msg = t.message
        // подстраховка: если куда-то просочилось сырое «HTTP 500» (не наш
        // человеческий текст) — не показываем код пользователю
        if (msg != null && Regex("HTTP \\d{3}").containsMatchIn(msg)) {
            return "7TV сейчас недоступен, попробуй позже"
        }
        return msg ?: t.toString()
    }
}
