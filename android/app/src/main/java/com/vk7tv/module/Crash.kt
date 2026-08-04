package com.vk7tv.module

import de.robv.android.xposed.XposedBridge
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Ловушка вылетов.
 *
 * На Android непойманное исключение в любом потоке отдаётся глобальному
 * обработчику, а тот убивает процесс — для человека это «ВК/Sova вылетел».
 * Такие трейсы уходят в системный logcat, а не в журнал LSPosed, и с телефона
 * без кабеля их не достать. Отсюда и слепые догадки о причине.
 *
 * Ставим свой обработчик ПЕРВЫМ делом в процессе: полный стек уходит в журнал
 * LSPosed (виден прямо в менеджере на телефоне), а если вылет наш —
 * записывается ещё и в файл, чтобы показать его строкой в настройках при
 * следующем запуске. Родной обработчик после нас вызываем всегда: мы вылет
 * не глотаем, только записываем, — иначе спрячем чужую поломку и оставим
 * процесс в подвешенном состоянии.
 */
object Crash {

    private const val FILE = "last-crash.txt"

    @Volatile
    private var dir: File? = null

    /** Последний прочитанный вылет — для строки в настройках этой сессии. */
    @Volatile
    var last: String? = null
        private set

    /** Ставим обработчик один раз на процесс. */
    fun install() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        if (prev is Guard) return
        Thread.setDefaultUncaughtExceptionHandler(Guard(prev))
    }

    /** Появился кэш — теперь есть куда писать файл вылета. */
    fun attach(cacheDir: File) {
        dir = cacheDir
    }

    /**
     * Прочитать записанный прошлый вылет (если был), запомнить для настроек и
     * удалить файл, чтобы не показывать один и тот же дважды.
     */
    fun lastAndClear(): String? {
        val f = File(dir ?: return null, FILE)
        if (!f.isFile) return null
        val text = L.safe("чтение вылета") { f.readText() }?.takeIf { it.isNotBlank() }
        L.safe("очистка вылета") { f.delete() }
        last = text
        return text
    }

    private class Guard(private val prev: Thread.UncaughtExceptionHandler?) :
        Thread.UncaughtExceptionHandler {
        override fun uncaughtException(t: Thread, e: Throwable) {
            L.safe("запись вылета") {
                val trace = stack(e)
                XposedBridge.log("VK7TV: НЕПОЙМАННЫЙ вылет в потоке «${t.name}»")
                XposedBridge.log(e)
                // записываем только свои вылеты: чужая поломка ВК/Sova — не наша,
                // подсовывать её в настройки как «вылет модуля» нечестно
                if (trace.contains("com.vk7tv.module")) {
                    dir?.let { File(it, FILE).writeText("поток «${t.name}»\n$trace") }
                }
            }
            // вылет не глотаем — отдаём родному обработчику, пусть процесс
            // завершится как обычно
            prev?.uncaughtException(t, e)
        }
    }

    private fun stack(e: Throwable): String {
        val sw = StringWriter()
        e.printStackTrace(PrintWriter(sw))
        return sw.toString()
    }
}
