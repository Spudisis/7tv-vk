package com.vk7tv.module

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.io.File

/**
 * Аварийный режим: счётчик запусков, которые модуль не пережил.
 *
 * Нативный вылет — например, в системном декодере картинок — не ловится ни
 * [L.safe], ни ловушкой вылетов: процесс умирает целиком. Единственная защита
 * от клиента, который перестал открываться, — на следующем запуске не начинать
 * рискованную работу вовсе.
 *
 * Счётчик взводится не при старте процесса, а перед первым декодированием
 * картинки, и гаснет, как только запуск пережит. Раньше он рос на каждом
 * старте любого процесса клиента, а гас через 20 секунд: процессов у ВК
 * несколько, живут они секундами, и система (на Samsung это «глубокий сон»)
 * убивает их раньше. Для модуля каждый такой процесс выглядел как вылет на
 * старте, и аварийный режим взводился без единого падения.
 *
 * Счётчик лежит отдельным файлом, а не в SharedPreferences клиента: там же
 * лежат наборы и свои эмоуты, а SharedPreferences переписывают файл целиком —
 * служебная запись из фонового процесса уносила бы с собой чужие правки.
 */
object Startup {

    private const val FILE = "startup.txt"
    private const val TMP = "startup.tmp"

    // После скольких невыживших запусков подряд уходить в аварийный режим.
    // 1 — хватает одного: клиент-«кирпич» мучительнее, чем разово выключенные
    // эмоуты.
    private const val SAFE_MODE_AFTER = 1

    // Сколько процесс должен прожить после начала рискованной работы, чтобы
    // считать запуск пережитым. Крэш при отрисовке первого экрана бывает не
    // мгновенным, поэтому с запасом.
    private const val SURVIVED_MS = 20_000L

    // Сколько раз подряд модуль выходит из аварийного режима сам. Одного хватает
    // на разовую поломку (битая картинка в кэше, оборванная загрузка): она
    // уходит вместе с файлом, и эмоуты возвращаются без участия человека. Если
    // после возврата запуск снова не пережит — причина устойчивая, и режим
    // остаётся до кнопки в настройках.
    private const val AUTO_RETURNS = 1

    /**
     * Подмена, картинки, автоподсказки и пикер выключены, чтобы клиент,
     * падавший на старте, всё-таки открылся.
     */
    @Volatile
    var safeMode = false
        private set

    /**
     * Снимется ли аварийный режим сам на следующем запуске. Ложь означает, что
     * возврат уже пробовали и он кончился новым невыжившим запуском, — дальше
     * только кнопкой в настройках.
     */
    @Volatile
    var willReturn = false
        private set

    private val lock = Any()

    private var dir: File? = null

    // невыжившие запуски подряд
    private var attempts = 0

    // сколько раз подряд включался аварийный режим; обнуляется пережитым
    // обычным запуском
    private var entries = 0

    // взвели счётчик перед рискованной работой в этом процессе
    @Volatile
    private var armed = false

    // итог этого запуска уже записан — второй раз не считаем
    @Volatile
    private var settled = false

    /**
     * Поднять счётчик и решить, не пора ли в аварийный режим. [dir] —
     * постоянное хранилище модуля (filesDir), [ctx] нужен, чтобы заметить уход
     * клиента в фон.
     */
    fun attach(dir: File, ctx: Context) {
        synchronized(lock) {
            this.dir = dir
            read()
            safeMode = attempts >= SAFE_MODE_AFTER
            willReturn = safeMode && entries < AUTO_RETURNS
        }
        (ctx as? Application)?.let { watchForeground(it) }
        if (safeMode) {
            // Аварийный запуск рискованной работы не делает, поэтому пережить
            // его — вопрос времени, а не декодера: ждём столько же и гасим
            // счётчик, чтобы следующий запуск снова был обычным.
            postSurvived()
        }
    }

    /**
     * Начинается рискованная работа — декодирование картинки. Пишем попытку
     * синхронно: нативный вылет не даст дописать файл позже.
     *
     * Взводим один раз на процесс и только в первые секунды его жизни. Дальше
     * не взводим намеренно: аварийный режим чинит клиент, который не
     * открывается, а вылет посреди рабочей сессии открыться не мешает.
     */
    fun arm() {
        if (safeMode || armed || settled) return
        synchronized(lock) {
            if (armed || settled) return
            armed = true
            write(attempts + 1, entries)
        }
        L.i("рискованная работа началась, счётчик запуска взведён")
        postSurvived()
    }

    /** Ручной выход из аварийного режима (кнопка в настройках). */
    fun exitSafeMode() {
        synchronized(lock) {
            safeMode = false
            settled = true
            write(0, 0)
        }
    }

    /**
     * Запуск пережит. Зовётся по времени и при уходе клиента в фон: процесс,
     * который система убьёт свёрнутым, вылетом модуля не является.
     */
    private fun survived() {
        val mode = synchronized(lock) {
            if (settled) return
            if (!safeMode && !armed) return // рискованной работы не было — считать нечего
            settled = true
            if (safeMode && entries >= AUTO_RETURNS) {
                // счётчик не гасим: следующий запуск снова будет аварийным
                return@synchronized "остаётся"
            }
            if (safeMode) write(0, entries + 1) else write(0, 0)
            if (safeMode) "снимется на следующем запуске" else "обычный"
        }
        L.i("запуск пережит, режим: $mode")
    }

    private fun postSurvived() {
        Handler(Looper.getMainLooper()).postDelayed(
            { L.safe("итог запуска") { survived() } },
            SURVIVED_MS,
        )
    }

    /**
     * Уход в фон — тоже доказательство, что клиент открылся. Без него запуск
     * засчитывался только по времени, а свёрнутый клиент система убивает
     * раньше, и это выглядело как вылет.
     */
    private fun watchForeground(app: Application) {
        L.safe("наблюдение за экранами") {
            app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                private var shown = 0

                override fun onActivityStarted(activity: Activity) {
                    shown++
                }

                override fun onActivityStopped(activity: Activity) {
                    shown--
                    if (shown <= 0) L.safe("уход в фон") { survived() }
                }

                override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
                override fun onActivityResumed(activity: Activity) = Unit
                override fun onActivityPaused(activity: Activity) = Unit
                override fun onActivitySaveInstanceState(activity: Activity, out: Bundle) = Unit
                override fun onActivityDestroyed(activity: Activity) = Unit
            })
        }
    }

    private fun read() {
        val f = File(dir ?: return, FILE)
        val parts = L.safe("чтение счётчика запусков") {
            if (f.isFile) f.readText().trim().split(' ') else null
        } ?: return
        attempts = parts.getOrNull(0)?.toIntOrNull() ?: 0
        entries = parts.getOrNull(1)?.toIntOrNull() ?: 0
    }

    /**
     * Пишем через .tmp + rename: файл нужен именно после гибели процесса,
     * а обрыв записи на месте оставил бы пустой — то есть «всё хорошо».
     */
    private fun write(attempts: Int, entries: Int) {
        this.attempts = attempts
        this.entries = entries
        val d = dir ?: return
        L.safe("запись счётчика запусков") {
            val tmp = File(d, TMP)
            tmp.writeText("$attempts $entries")
            if (!tmp.renameTo(File(d, FILE))) tmp.delete()
        }
    }
}
