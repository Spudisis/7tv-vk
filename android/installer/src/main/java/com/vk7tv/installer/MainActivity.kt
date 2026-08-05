package com.vk7tv.installer

import android.app.Activity
import android.app.Dialog
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.util.concurrent.Executors

/**
 * Экран установщика. Три вкладки: «Установка» (карточки клиентов ВК + прогресс),
 * «Как это работает» (человеческое объяснение) и «Журнал» (сырой лог для разбора).
 *
 * Один поток на клиента: «Пропатчить» (оригинал) или «Обновить модуль» (уже
 * пропатчен). Всё тяжёлое — в фоновом потоке; установка и удаление — через
 * системные диалоги, результат ловим широковещанием. Пока идёт операция, вместо
 * простыни лога показываем крупную строку «что происходит сейчас» и прогресс —
 * подробности при желании смотрят на вкладке «Журнал».
 */
class MainActivity : Activity() {

    // Пересоздаётся при «Прервать»: если тяжёлая операция (скачивание/патч)
    // зависла, новый поток гарантирует, что следующая попытка не встанет за ней.
    private var io = Executors.newSingleThreadExecutor()

    private val ui = Handler(Looper.getMainLooper())

    // Журнал держим строками, а не только во вьюхе: активность пересоздаётся
    // (поворот, смена темы, возврат из системного установщика), вьюха при этом
    // новая и пустая — а строки нужны те же, ради них журнал и открывают.
    private companion object {
        val logLines = StringBuilder()
        const val LOG_CAP = 200_000
    }

    // Долгая пауза перед авто-разблокировкой: фоновой установке (Xiaomi и др.)
    // надо успеть прислать SUCCESS раньше, иначе покажем ложную «отмену».
    // Нетерпеливым и без того доступна кнопка «Прервать».
    private val USER_ACTION_GRACE_MS = 60_000L

    // --- палитра (значения по умолчанию — светлые; тёмные подставит initPalette) ---
    private var PAGE = Color.parseColor("#F4F5F7")
    private var CARD = Color.parseColor("#FFFFFF")
    private var ACCENT = Color.parseColor("#6C5CE7")
    private var INK = Color.parseColor("#1E1F24")
    private var MUTED = Color.parseColor("#6B7280")
    private var LINE = Color.parseColor("#E6E8EC")
    private var DANGER = Color.parseColor("#D64545")
    private var OK = Color.parseColor("#16A34A")
    private var CHIP_BG = Color.parseColor("#EEF0F3")
    private var OK_BG = Color.parseColor("#E7F7EE")
    private var WARN_BG = Color.parseColor("#FFF6E6")
    private var WARN_LINE = Color.parseColor("#F0C36D")
    private var TAB_BG = Color.parseColor("#E9EAEE")
    private var LOG_BG = Color.parseColor("#FFFFFF")

    /** Тёмная палитра — по системной теме устройства. */
    private fun initPalette(night: Boolean) {
        if (!night) return
        PAGE = Color.parseColor("#121317")
        CARD = Color.parseColor("#1E1F24")
        ACCENT = Color.parseColor("#8B7BFF")
        INK = Color.parseColor("#ECEDEF")
        MUTED = Color.parseColor("#9AA0A6")
        LINE = Color.parseColor("#2E3036")
        DANGER = Color.parseColor("#F26D6D")
        OK = Color.parseColor("#4ADE80")
        CHIP_BG = Color.parseColor("#2A2C33")
        OK_BG = Color.parseColor("#12331F")
        WARN_BG = Color.parseColor("#3A2F1A")
        WARN_LINE = Color.parseColor("#7A5C2E")
        TAB_BG = Color.parseColor("#202228")
        LOG_BG = Color.parseColor("#23262E")
    }

    // --- вкладки ---
    private val tabTitles = listOf("Установка", "Справка", "Журнал")
    // Минималистичные иконки (Material Symbols Light, Iconify) — тинтуются под тему.
    private val tabIconRes = intArrayOf(
        R.drawable.ic_tab_install, R.drawable.ic_tab_help, R.drawable.ic_tab_log
    )
    private lateinit var tabs: List<Tab>
    private lateinit var pages: List<View>

    private class Tab(val container: LinearLayout, val icon: ImageView, val label: TextView)

    // --- вкладка «Установка» ---
    private lateinit var topBanner: LinearLayout      // обновление установщика / просьба про источники
    private lateinit var progressCard: LinearLayout   // «что происходит сейчас» + прогресс
    private lateinit var stepView: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var percentView: TextView
    private lateinit var abortButton: Button       // выход из зависшей стадии
    private lateinit var resultBanner: LinearLayout   // «Открыть ВК» / «Переустановить»
    private lateinit var candidates: LinearLayout
    private lateinit var showAllButton: Button
    private lateinit var installScroll: ScrollView

    // Приложения, выбранные вручную через поиск в «Показать все приложения» —
    // могут не попадать в авто-список клиентов ВК, поэтому держим их отдельно.
    private val extraPicked = LinkedHashMap<String, Vk.Client>()

    // --- вкладка «Журнал» ---
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    // Последняя версия модуля на GitHub — узнаём одним лёгким запросом при старте,
    // без скачивания APK. Нужна, чтобы показать «доступно vX» на карточке.
    private var availableModule: Releases.Found? = null

    // текущая операция
    private var targetPkg: String? = null
    private var patchedApks: List<File> = emptyList()
    private var installAfterUninstall = false
    private var updateMode = false
    private var pendingModuleVersion: String? = null  // версия модуля, которую сейчас ставим

    // Пока true — операция идёт и мы ждём её завершения. «Прервать» и новый старт
    // сбрасывают флаг; поздние результаты брошенной операции (broadcast, возврат
    // фонового потока) после этого игнорируются, чтобы флоу не ожил сам собой.
    @Volatile private var flowActive = false
    // Ждём ответа на системный диалог установки/удаления. На части прошивок,
    // если закрыть его тапом мимо, терминального broadcast'а не будет — тогда
    // ловим возврат в onResume и сами разблокируем экран.
    @Volatile private var awaitingUserAction = false
    private var resumed = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val op = intent.getStringExtra(Installer.EXTRA_OP) ?: return
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirm = @Suppress("DEPRECATION")
                    (intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (confirm != null) {
                        awaitingUserAction = true
                        startActivity(confirm)
                    }
                }
                PackageInstaller.STATUS_SUCCESS -> onOpDone(op, true, null)
                else -> onOpDone(op, false, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        initPalette(night)
        window.setBackgroundDrawable(ColorDrawable(PAGE))
        setContentView(buildUi())
        applySystemBars(night)
        selectTab(0)
        logHeader()
        registerStatusReceiver()
        checkUpdates()
        render()
    }

    // Статус-бар и навбар в цвет фона, иконки — светлые/тёмные под тему.
    private fun applySystemBars(night: Boolean) {
        window.statusBarColor = PAGE
        window.navigationBarColor = CARD  // в цвет нижней панели вкладок
        var vis = window.decorView.systemUiVisibility
        val lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        vis = if (night) vis and lightBars.inv() else vis or lightBars
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = vis
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // Вернулись из системного диалога установки/удаления. Если его закрыли,
        // не подтвердив (тап мимо/«назад»), терминального broadcast'а на части
        // прошивок не будет — разблокируем экран сами. Но ждём ДОЛГО: часть
        // прошивок (Xiaomi/HyperOS и др.) возвращают в приложение сразу, а сам
        // пакет ставят в фоне и присылают SUCCESS через несколько секунд.
        // Короткий таймер срабатывал раньше него, показывал ложное «Отменено» и
        // ронял flowActive — из-за чего настоящий успех отбрасывался и версия
        // модуля не записывалась. На всякий случай успех теперь honor'ится и
        // после таймера (см. onOpDone), так что точность задержки некритична.
        if (awaitingUserAction) {
            ui.removeCallbacks(userActionCheck)
            ui.postDelayed(userActionCheck, USER_ACTION_GRACE_MS)
        }
    }

    override fun onPause() {
        super.onPause()
        resumed = false
    }

    private val userActionCheck = Runnable {
        if (awaitingUserAction && resumed && !isFinishing) {
            awaitingUserAction = false
            flowActive = false
            installAfterUninstall = false
            step("Отменено — системный диалог закрыт, ничего не изменилось.", error = true)
            busy(false)
            render()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(receiver) }
        ui.removeCallbacks(userActionCheck)
        io.shutdownNow()
    }

    private fun registerStatusReceiver() {
        val filter = IntentFilter(Installer.ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    // ---- примитивы вёрстки ----

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private fun sp(view: TextView, v: Float) = view.setTextSize(TypedValue.COMPLEX_UNIT_SP, v)

    private fun bg(fill: Int, radius: Int, strokeColor: Int? = null, strokeW: Int = 1) =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = dp(radius).toFloat()
            if (strokeColor != null) setStroke(dp(strokeW), strokeColor)
        }

    private fun ripple(content: Drawable, highlight: Int, radius: Int): Drawable =
        RippleDrawable(ColorStateList.valueOf(highlight), content, bg(Color.WHITE, radius))

    private fun lp(width: Int, height: Int, top: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(width, height).apply {
            topMargin = dp(top); bottomMargin = dp(bottom)
        }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = bg(CARD, 16, LINE)
        setPadding(dp(16), dp(14), dp(16), dp(14))
        layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 10)
    }

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false): TextView =
        TextView(this).apply {
            text = s
            sp(this, size)
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            setLineSpacing(dp(3).toFloat(), 1f)
        }

    private fun button(label: String, fill: Int, textColor: Int, strokeColor: Int? = null): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            stateListAnimator = null
            setTextColor(textColor)
            sp(this, 15f)
            minHeight = dp(48)
            setPadding(dp(16), dp(10), dp(16), dp(10))
            val highlight = if (fill == CARD || fill == Color.TRANSPARENT) 0x22000000 else 0x40FFFFFF
            background = ripple(bg(fill, 12, strokeColor), highlight, 12)
        }

    private fun primary(label: String) = button(label, ACCENT, Color.WHITE)
    private fun outline(label: String) = button(label, CARD, ACCENT, ACCENT)
    private fun danger(label: String) = button(label, DANGER, Color.WHITE)

    private fun chip(label: String, fg: Int, bgColor: Int): TextView =
        TextView(this).apply {
            text = label
            sp(this, 11f)
            setTextColor(fg)
            setTypeface(typeface, Typeface.BOLD)
            background = bg(bgColor, 8)
            setPadding(dp(8), dp(3), dp(8), dp(3))
        }

    // ---- сборка экрана ----

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(PAGE)
        }

        // Боковые отступы — на шапке и контенте страниц отдельно, а не на root:
        // так нижняя панель вкладок остаётся во всю ширину. frame — прямой
        // весовой ребёнок root (один уровень веса, чтобы высота гарантированно
        // тянулась; двойная вложенность весов на части устройств схлопывалась).
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(12))
        }
        head.addView(text("VK7TV", 22f, INK, bold = true))
        head.addView(text("Установщик для приложения ВК", 13f, MUTED).apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 2)
        })
        root.addView(head)

        val frame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
        }
        pages = listOf(buildInstallPage(), buildHelpPage(), buildLogPage())
        pages.forEach {
            frame.addView(it, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        root.addView(frame)

        // нижняя навигация — кнопки-вкладки во всю ширину
        root.addView(buildTabBar())
        return root
    }

    private fun buildTabBar(): View {
        // Отдельная поверхность внизу во всю ширину экрана, с отбивкой-линией.
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(CARD)
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
        }
        wrap.addView(View(this).apply {
            setBackgroundColor(LINE)
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(1))
        })
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), dp(6), dp(8), dp(6))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
        }
        tabs = tabTitles.mapIndexed { i, title ->
            val icon = ImageView(this).apply {
                setImageResource(tabIconRes[i])
                layoutParams = LinearLayout.LayoutParams(dp(18), dp(18)).apply { marginEnd = dp(6) }
            }
            val label = TextView(this).apply {
                text = title
                sp(this, 12.5f)
                setSingleLine()
            }
            val container = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                minimumHeight = dp(48)
                setPadding(dp(4), dp(10), dp(4), dp(10))
                isClickable = true
                layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply {
                    marginStart = dp(3); marginEnd = dp(3)
                }
                addView(icon)
                addView(label)
                setOnClickListener { selectTab(i) }
            }
            Tab(container, icon, label)
        }
        tabs.forEach { row.addView(it.container) }
        wrap.addView(row)
        return wrap
    }

    private fun selectTab(index: Int) {
        pages.forEachIndexed { i, v -> v.visibility = if (i == index) View.VISIBLE else View.GONE }
        tabs.forEachIndexed { i, t ->
            val active = i == index
            val fg = if (active) Color.WHITE else INK
            t.container.background = ripple(bg(if (active) ACCENT else TAB_BG, 12), 0x22808080, 12)
            t.icon.imageTintList = ColorStateList.valueOf(fg)
            t.label.setTextColor(fg)
            t.label.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
        }
    }

    private fun buildInstallPage(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), 0, dp(16), dp(24))
        }

        topBanner = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(topBanner)

        progressCard = card().apply {
            visibility = View.GONE
            background = bg(CARD, 16, ACCENT)
        }
        stepView = text("", 16f, INK, bold = true)
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            max = 100
            progressTintList = ColorStateList.valueOf(ACCENT)
            indeterminateTintList = ColorStateList.valueOf(ACCENT)
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10, bottom = 2)
        }
        percentView = text("", 12f, MUTED).apply { visibility = View.GONE }
        // «Прервать» живёт внутри карточки прогресса, которую busy() НЕ гасит, —
        // значит кнопка остаётся нажимаемой, даже когда весь остальной экран
        // заблокирован. Это гарантированный выход из любой зависшей стадии.
        abortButton = outline("Прервать").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 12)
            setOnClickListener { abortFlow() }
        }
        progressCard.addView(stepView)
        progressCard.addView(progressBar)
        progressCard.addView(percentView)
        progressCard.addView(abortButton)
        content.addView(progressCard)

        resultBanner = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(resultBanner)

        // короткое «что произойдёт»
        val intro = card()
        intro.addView(text("Что произойдёт", 15f, INK, bold = true).apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 6)
        })
        intro.addView(text(
            "•  Добавим в приложение ВК эмоуты 7TV. Аккаунт и переписка живут на " +
                "сервере ВК — их не трогаем.\n" +
                "•  Рут не нужен, всё обратимо: обычный ВК всегда можно вернуть из магазина.\n" +
                "•  Первый патч удалит оригинал и поставит пропатченный ВК — понадобится " +
                "войти заново. Обновления вход сохраняют.",
            13.5f, MUTED
        ))
        intro.addView(button("Подробнее — вкладка «Справка»", CARD, ACCENT).apply {
            setPadding(0, dp(10), 0, 0)
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            background = null
            minHeight = 0
            setOnClickListener { selectTab(1) }
        })
        content.addView(intro)

        content.addView(text("Клиенты ВК на устройстве", 13f, MUTED, bold = true).apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 2, bottom = 8)
        })

        candidates = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(candidates)

        showAllButton = outline("Показать все приложения").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 2)
            setOnClickListener { openAppPicker() }
        }
        content.addView(showAllButton)

        installScroll = ScrollView(this).apply { addView(content) }
        return installScroll
    }

    private fun buildHelpPage(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), 0, dp(16), dp(24))
        }
        fun section(title: String, body: String) {
            val c = card()
            c.addView(text(title, 15f, INK, bold = true).apply {
                layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 6)
            })
            c.addView(text(body, 13.5f, MUTED))
            content.addView(c)
        }
        section(
            "Зачем это нужно",
            "В приложении ВК нет браузера, поэтому обычное расширение туда не " +
                "поставить. Модуль VK7TV встраивается в само приложение и делает то же " +
                "самое: подменяет слова-коды на анимированные эмоуты 7TV и добавляет " +
                "кнопку-пикер в панель ввода."
        )
        section(
            "Что делает установщик",
            "1. Скачивает свежий модуль VK7TV с GitHub (или берёт вшитую копию, если " +
                "сети нет).\n" +
                "2. Через LSPatch дописывает в APK вашего ВК загрузчик модуля — код " +
                "самого ВК не меняется.\n" +
                "3. Подписывает получившийся APK и ставит его через системный установщик."
        )
        section(
            "Почему удаляется оригинал",
            "Оригинальный ВК подписан ключом разработчиков ВК, а пропатченный — нашим. " +
                "Android не даёт поставить одно поверх другого с другой подписью, поэтому " +
                "в первый раз оригинал удаляется и ставится пропатченная версия. После " +
                "этого в ВК нужно войти заново — но переписка, друзья и всё остальное " +
                "хранятся на сервере ВК и никуда не деваются."
        )
        section(
            "Обновления вход сохраняют",
            "Пропатченный ВК и новые патчи подписаны одним ключом, поэтому «Обновить " +
                "модуль» ставится поверх — данные и вход в аккаунт остаются, логиниться " +
                "заново не нужно."
        )
        section(
            "Это безопасно и обратимо",
            "Рут не нужен. В любой момент можно вернуть обычный ВК: удалить пропатченный " +
                "и поставить оригинал из Play Store или RuStore — телефон станет как был."
        )
        section(
            "Если что-то пошло не так",
            "Любой системный диалог можно отменить — до установки на телефоне ничего не " +
                "меняется. Подробности каждого шага собираются на вкладке «Журнал»; его " +
                "можно скопировать и приложить к вопросу."
        )
        return ScrollView(this).apply { addView(content) }
    }

    private fun buildLogPage(): View {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), 0, dp(16), dp(16))
        }
        col.addView(outline("Скопировать журнал").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 10)
            setOnClickListener { copyLog() }
        })
        // Коробка занимает всю высоту между кнопкой и подвалом, длинный журнал
        // прокручивается внутри неё. Своей прокрутки у текста нет: два
        // прокручиваемых механизма один в другом делят жест и высоту — на этом
        // вкладка когда-то и оказывалась пустой.
        logView = TextView(this).apply {
            sp(this, 12f)
            setTextColor(INK)
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        logScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
            background = bg(LOG_BG, 12, LINE)
            minimumHeight = dp(120) // на случай, если вес поделился неудачно
            isFillViewport = true
            addView(logView)
        }
        col.addView(logScroll)
        renderLog()
        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10)
        }
        footer.addView(text("GitHub проекта", 12f, ACCENT).apply {
            paintFlags = paintFlags or Paint.UNDERLINE_TEXT_FLAG
            setOnClickListener { openUrl("https://github.com/${Releases.REPO}") }
        })
        footer.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        })
        footer.addView(text("VK7TV Патчер · v${BuildConfig.VERSION_NAME}", 11.5f, MUTED))
        col.addView(footer)
        return col
    }

    private fun openUrl(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    // ---- карточки клиентов ----

    private fun render() {
        candidates.removeAllViews()
        val found = Vk.clients(this)
        val shown = LinkedHashSet<String>()
        for (client in found) { addCandidateRow(client); shown.add(client.pkg) }
        // выбранные вручную — только те, что не попали в авто-список
        for (client in extraPicked.values) if (shown.add(client.pkg)) addCandidateRow(client)
        if (shown.isEmpty()) {
            val c = card()
            c.addView(text(
                "Клиент ВК не найден автоматически. Нажми «Показать все приложения» — " +
                    "там есть поиск, выбери свой клиент ВК вручную.",
                13.5f, MUTED
            ))
            candidates.addView(c)
        }
    }

    // ---- полный список приложений с поиском ----

    /**
     * Модалка со всеми приложениями: сверху липкое поле поиска, прокручивается
     * только список. Тап по приложению добавляет его карточкой в основной список —
     * там пользователь увидит последствие и осознанно нажмёт «Пропатчить».
     */
    private fun openAppPicker() {
        val all = Vk.all(this)
        val dialog = Dialog(this)

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(PAGE)
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 4)
        }
        header.addView(text("Все приложения", 18f, INK, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        })
        header.addView(button("Закрыть", CARD, ACCENT).apply {
            background = null
            minHeight = 0
            setPadding(dp(8), dp(6), 0, dp(6))
            setOnClickListener { dialog.dismiss() }
        })
        panel.addView(header)
        panel.addView(text(
            "Выбери свой клиент ВК — патч имеет смысл только для него.", 12.5f, MUTED
        ).apply { layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 10) })

        val search = EditText(this).apply {
            hint = "Поиск по названию или пакету"
            setSingleLine()
            sp(this, 15f)
            setTextColor(INK)
            setHintTextColor(MUTED)
            background = bg(CARD, 12, LINE)
            setPadding(dp(12), dp(11), dp(12), dp(11))
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 10)
        }
        panel.addView(search)

        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        panel.addView(ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
            addView(list)
        })

        // строки создаём один раз, фильтр только прячет/показывает (иконки не
        // перезагружаются на каждую букву)
        val rows = all.map { it to pickerRow(it, dialog) }
        rows.forEach { list.addView(it.second) }
        val emptyState = text("Ничего не найдено", 14f, MUTED).apply {
            visibility = View.GONE
            setPadding(dp(2), dp(12), 0, 0)
        }
        list.addView(emptyState)

        fun applyFilter(query: String) {
            val q = query.trim().lowercase()
            var any = false
            for ((c, v) in rows) {
                val show = q.isEmpty() ||
                    c.label.lowercase().contains(q) || c.pkg.lowercase().contains(q)
                v.visibility = if (show) View.VISIBLE else View.GONE
                if (show) any = true
            }
            emptyState.visibility = if (any || rows.isEmpty()) View.GONE else View.VISIBLE
        }
        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) = applyFilter(s?.toString() ?: "")
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })

        dialog.setContentView(panel)
        dialog.window?.setBackgroundDrawable(ColorDrawable(PAGE))
        dialog.window?.setLayout(MATCH_PARENT, MATCH_PARENT)
        dialog.show()
    }

    private fun pickerRow(c: Vk.Client, dialog: Dialog): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = ripple(bg(CARD, 12, LINE), 0x22808080, 12)
            setPadding(dp(10), dp(10), dp(10), dp(10))
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 6)
            isClickable = true
            setOnClickListener { dialog.dismiss(); pickApp(c) }
        }
        row.addView(ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(10) }
            runCatching { setImageDrawable(packageManager.getApplicationIcon(c.pkg)) }
        })
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
            addView(text(c.label, 15f, INK, bold = true))
            addView(text(c.pkg, 11.5f, MUTED))
        })
        if (c.patched) row.addView(chip("пропатчен", OK, OK_BG))
        return row
    }

    private fun pickApp(c: Vk.Client) {
        extraPicked[c.pkg] = c
        render()
        selectTab(0)
        installScroll.post { installScroll.smoothScrollTo(0, candidates.top) }
    }

    private fun addCandidateRow(c: Vk.Client) {
        val cardView = card()

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val icon = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(42), dp(42)).apply { marginEnd = dp(12) }
            runCatching { setImageDrawable(packageManager.getApplicationIcon(c.pkg)) }
        }
        head.addView(icon)

        val nameCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }
        nameCol.addView(text(c.label, 16f, INK, bold = true))
        nameCol.addView(text(c.pkg, 12f, MUTED))
        head.addView(nameCol)

        if (c.patched) {
            head.addView(chip("пропатчен", OK, OK_BG))
        } else {
            head.addView(chip("оригинал", MUTED, CHIP_BG))
        }
        cardView.addView(head)

        // строка про версию модуля и последствие действия
        val installed = installedModuleVersion(c.pkg)
        val avail = availableModule?.version
        val updateAvailable = c.patched && avail != null &&
            (installed == null || Releases.isNewer(avail, installed))

        val info = StringBuilder()
        if (c.patched) {
            info.append("Установлен модуль: ").append(installed ?: "версия неизвестна")
            when {
                avail == null -> {}
                updateAvailable -> info.append("\nДоступно обновление: v").append(avail)
                else -> info.append("\nУ вас последняя версия (v").append(avail).append(")")
            }
            info.append("\nОбновление встанет поверх — вход в ВК сохранится.")
        } else {
            if (avail != null) info.append("Будет установлен модуль v").append(avail).append(".\n")
            info.append("Оригинал удалится и поставится заново — в ВК нужно будет войти снова.")
        }
        cardView.addView(text(info.toString(), 12.5f, MUTED).apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10)
        })

        // чейнджлог доступного обновления — из текста релиза, без скачивания APK
        if (updateAvailable) {
            val notes = availableModule?.notes?.let(::cleanNotes).orEmpty()
            if (notes.isNotEmpty()) {
                val box = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    background = bg(CHIP_BG, 10)
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10)
                }
                box.addView(text("Что нового в v$avail", 12.5f, INK, bold = true))
                box.addView(text(notes, 12.5f, MUTED).apply {
                    layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 4)
                })
                cardView.addView(box)
            }
        }

        val actionLabel = when {
            !c.patched -> "Пропатчить"
            updateAvailable -> "Обновить до v$avail"
            else -> "Обновить модуль"
        }
        // Если обновлять нечего (та же версия) — кнопка неяркая, чтобы не тянуть
        // тот же APK лишний раз; захотел — всё равно переустановит.
        val action = if (c.patched && !updateAvailable && avail != null) outline(actionLabel)
                     else primary(actionLabel)
        action.layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 12)
        action.setOnClickListener { startFlow(c) }
        cardView.addView(action)

        candidates.addView(cardView)
    }

    // ---- статус, прогресс, журнал ----

    private fun step(s: String, error: Boolean = false) = runOnUiThread {
        stepView.text = s
        stepView.setTextColor(if (error) DANGER else INK)
        log(s)
    }

    private fun log(s: String) = runOnUiThread {
        synchronized(logLines) {
            if (logLines.isNotEmpty()) logLines.append('\n')
            logLines.append(s)
            // потолок: патч большого APK пишет много, а держать всё в памяти
            // и в буфере обмена незачем — режем начало
            if (logLines.length > LOG_CAP) logLines.delete(0, logLines.length - LOG_CAP)
        }
        renderLog()
        // прокручиваем к свежей строке, иначе на длинном журнале видно начало
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    /**
     * Шапка журнала: версия, канал, устройство. Пишется один раз за жизнь
     * процесса — при пересоздании экрана строки уже есть и дублировать их
     * незачем. Заодно журнал никогда не бывает пустым: раньше на вкладке до
     * первой установки была пустая коробка, и было не понять, то ли нечего
     * показывать, то ли сломался показ.
     */
    private fun logHeader() {
        if (synchronized(logLines) { logLines.isNotEmpty() }) return
        val channel = if (BuildConfig.DEV_CHANNEL) " · пробный канал" else ""
        log("VK7TV Патчер v${BuildConfig.VERSION_NAME}$channel")
        log("${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
    }

    /** Показать журнал во вьюхе. Строки живут в модели, вьюха — отражение. */
    private fun renderLog() {
        val text = synchronized(logLines) { logLines.toString() }
        if (text.isEmpty()) {
            logView.setTextColor(MUTED)
            logView.text = "Журнал пуст — он наполняется во время установки."
        } else {
            logView.setTextColor(INK)
            logView.text = text
        }
    }

    private fun percent(done: Long, total: Long) = runOnUiThread {
        if (total <= 0) return@runOnUiThread
        progressBar.isIndeterminate = false
        progressBar.progress = (done * 100 / total).toInt()
        percentView.visibility = View.VISIBLE
        percentView.text = "${done * 100 / total}% · ${human(done)} из ${human(total)}"
    }

    private fun indeterminate() = runOnUiThread {
        progressBar.isIndeterminate = true
        percentView.visibility = View.GONE
    }

    private fun human(bytes: Long): String {
        val mb = bytes / 1048576.0
        return if (mb >= 1) "%.1f МБ".format(mb) else "%.0f КБ".format(bytes / 1024.0)
    }

    // Лёгкая чистка markdown из текста релиза для показа в приложении.
    private fun cleanNotes(raw: String): String =
        raw.trim().replace("**", "").lines().joinToString("\n") { line ->
            val t = line.trimEnd()
            if (t.startsWith("- ")) "•  ${t.substring(2)}" else t
        }

    private fun copyLog() {
        val text = synchronized(logLines) { logLines.toString() }
        if (text.isEmpty()) {
            Toast.makeText(this, "Журнал пуст", Toast.LENGTH_SHORT).show()
            return
        }
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("vk7tv log", text))
        Toast.makeText(this, "Журнал скопирован", Toast.LENGTH_SHORT).show()
    }

    private fun busy(on: Boolean) = runOnUiThread {
        progressCard.visibility = if (on) View.VISIBLE else View.GONE
        if (on) indeterminate()
        setEnabledDeep(candidates, !on)
        setEnabledDeep(topBanner, !on)
        setEnabledDeep(resultBanner, !on)
        showAllButton.isEnabled = !on
    }

    private fun setEnabledDeep(v: View, enabled: Boolean) {
        v.isEnabled = enabled
        if (v is ViewGroup) for (i in 0 until v.childCount) setEnabledDeep(v.getChildAt(i), enabled)
    }

    // ---- баннеры ----

    private fun notice(msg: String) = runOnUiThread {
        topBanner.removeAllViews()
        val c = card().apply { background = bg(WARN_BG, 16, WARN_LINE) }
        c.addView(text(msg, 13.5f, INK))
        topBanner.addView(c)
    }

    private fun offerOpen() {
        val pkg = targetPkg ?: return
        val launch = packageManager.getLaunchIntentForPackage(pkg) ?: return
        resultBanner.removeAllViews()
        val c = card().apply { background = bg(OK_BG, 16, OK) }
        c.addView(text("Готово — VK7TV установлен.", 14f, INK, bold = true).apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, bottom = 4)
        })
        c.addView(primary("Открыть ВК").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 8)
            setOnClickListener { startActivity(launch) }
        })
        resultBanner.addView(c)
    }

    private fun offerReinstall() {
        // Подписи разошлись (например, ВК патчили другой версией LSPatch): поверх
        // не встало. Полная переустановка — с потерей входа.
        resultBanner.removeAllViews()
        val c = card().apply { background = bg(WARN_BG, 16, WARN_LINE) }
        c.addView(text(
            "Обновление поверх не встало — видимо, ВК патчили другой версией. " +
                "Можно переустановить начисто, но вход в ВК сбросится.",
            13.5f, INK
        ))
        c.addView(danger("Переустановить начисто").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10)
            setOnClickListener {
                val pkg = targetPkg ?: return@setOnClickListener
                flowActive = true
                busy(true)
                resultBanner.removeAllViews()
                installAfterUninstall = true
                step("Удаляю пропатченный ВК…")
                Installer.uninstall(this@MainActivity, pkg)
            }
        })
        resultBanner.addView(c)
    }

    private fun showSelfUpdate(upd: Releases.Found) {
        topBanner.removeAllViews()
        val c = card().apply { background = bg(WARN_BG, 16, WARN_LINE) }
        c.addView(text("Доступно обновление установщика — v${upd.version}", 14f, INK, bold = true))
        c.addView(primary("Обновить установщик").apply {
            layoutParams = lp(MATCH_PARENT, WRAP_CONTENT, top = 10)
            setOnClickListener { startSelfUpdate(upd) }
        })
        topBanner.addView(c)
    }

    // ---- поток патча ----

    private fun ensureCanInstall(): Boolean {
        if (packageManager.canRequestPackageInstalls()) return true
        notice("Разреши установку приложений из этого источника и вернись сюда.")
        startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
        )
        return false
    }

    private fun startFlow(c: Vk.Client) {
        if (!ensureCanInstall()) return
        targetPkg = c.pkg
        updateMode = c.patched
        pendingModuleVersion = null
        flowActive = true
        resultBanner.removeAllViews()
        selectTab(0)
        busy(true)
        step(if (updateMode) "Обновляю модуль в «${c.label}»…" else "Патчу «${c.label}»…")
        log("=== ${c.label} (${c.pkg})")
        io.execute {
            try {
                step("Скачиваю модуль VK7TV…")
                val module = Releases.moduleApk(this, ::log, ::percent)
                pendingModuleVersion = moduleVersionOf(module)
                pendingModuleVersion?.let { step("Модуль: v$it") }
                indeterminate()
                val keystore = extractKeystore()
                step(if (c.patched) "Извлекаю приложение ВК…" else "Копирую приложение ВК…")
                val work = File(cacheDir, "work").apply { deleteRecursively(); mkdirs() }
                val originals = Vk.originals(this, c, work, ::log)
                step("Патчу приложение ВК…")
                indeterminate()
                val out = File(cacheDir, "out")
                patchedApks = Patcher.patch(originals, module, keystore, out, ::log)
                runOnUiThread { proceedAfterPatch() }
            } catch (t: Throwable) {
                // операцию прервали — её падение/прерывание нас уже не касается
                if (!flowActive) return@execute
                flowActive = false
                step("Ошибка: ${t.message}", error = true)
                log(t.stackTraceToString())
                busy(false)
            }
        }
    }

    // Постоянный ключ подписи из assets → в файл (LSPatch хочет путь).
    private fun extractKeystore(): File {
        val dst = File(cacheDir, "vk7tv.p12")
        assets.open("signing/vk7tv.p12").use { inp -> dst.outputStream().use { inp.copyTo(it) } }
        return dst
    }

    // Версия APK-модуля без установки — читаем versionName прямо из файла.
    private fun moduleVersionOf(apk: File): String? =
        runCatching { packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.versionName }.getOrNull()

    private fun proceedAfterPatch() {
        if (!flowActive) return  // прервали, пока патчили — дальше не идём
        val pkg = targetPkg ?: return
        if (updateMode) {
            // Пропатченный ВК и новый патч подписаны одним ключом LSPatch —
            // ставим поверх, данные и вход в аккаунт сохраняются.
            step("Ставлю обновление поверх — вход сохранится…")
            installAfterUninstall = false
            Installer.install(this, patchedApks)
        } else {
            // Оригинал подписан ключом ВК, патч — ключом LSPatch. Поверх нельзя,
            // сначала удаляем оригинал. После этого придётся войти заново.
            step("Удаляю оригинальный ВК — переписка на сервере, вход спросят заново…")
            installAfterUninstall = true
            Installer.uninstall(this, pkg)
        }
    }

    private fun onOpDone(op: String, ok: Boolean, msg: String?) {
        // системный диалог ответил — фолбэк из onResume больше не нужен
        awaitingUserAction = false
        ui.removeCallbacks(userActionCheck)
        // Успех honor'им ВСЕГДА, даже если flowActive уже сброшен (сработал
        // таймаут onResume на медленной фоновой установке или нажали «Прервать»,
        // а пакет всё же встал): приложение реально обновилось. Ошибки же и
        // продолжение цепочки — только у живого флоу, иначе воскресили бы
        // отменённую операцию или показали чужую «неудачу».
        when (op) {
            Installer.OP_UNINSTALL -> {
                if (ok && installAfterUninstall && flowActive) {
                    installAfterUninstall = false
                    step("Оригинал удалён, ставлю VK7TV…")
                    Installer.install(this, patchedApks)
                } else if (flowActive) {
                    flowActive = false
                    step(if (ok) "Удалено." else "Удаление отменено.")
                    busy(false)
                }
            }
            Installer.OP_INSTALL -> {
                if (ok) {
                    flowActive = false
                    installAfterUninstall = false
                    targetPkg?.let { pkg ->
                        pendingModuleVersion?.let { rememberModuleVersion(pkg, it) }
                    }
                    step("Готово! VK7TV установлен.")
                    busy(false)
                    offerOpen()
                    render()
                } else if (flowActive) {
                    flowActive = false
                    step("Установка не удалась: ${msg ?: "отменено"}", error = true)
                    if (updateMode) offerReinstall()
                    busy(false)
                }
            }
            Installer.OP_SELF -> {
                if (ok) {
                    flowActive = false
                    step("Установщик обновлён.")
                    busy(false)
                } else if (flowActive) {
                    flowActive = false
                    step("Обновление установщика не удалось: ${msg ?: "отменено"}", error = true)
                    busy(false)
                }
            }
        }
    }

    /**
     * Выход из любой стадии по кнопке «Прервать». Саму тяжёлую операцию
     * (скачивание/патч LSPatch) прервать нельзя, поэтому просто помечаем флоу
     * брошенным — её поздний результат onOpDone/proceedAfterPatch проигнорируют —
     * и пересоздаём рабочий поток, чтобы следующая попытка не встала за зависшей.
     * Системный диалог установки, если он ещё открыт, отменит сам пользователь.
     */
    private fun abortFlow() {
        flowActive = false
        awaitingUserAction = false
        installAfterUninstall = false
        ui.removeCallbacks(userActionCheck)
        io.shutdownNow()
        io = Executors.newSingleThreadExecutor()
        step("Прервано.", error = true)
        busy(false)
        render()
    }

    // ---- версия модуля: помним, что реально встроили ----

    private fun prefs() = getSharedPreferences("vk7tv", MODE_PRIVATE)
    private fun installedModuleVersion(pkg: String): String? = prefs().getString("mod_$pkg", null)
    private fun rememberModuleVersion(pkg: String, v: String) =
        prefs().edit().putString("mod_$pkg", v).apply()

    // ---- проверка обновлений при старте (без скачивания APK) ----

    private fun checkUpdates() {
        log("Проверяю релизы на GitHub…")
        io.execute {
            val snap = runCatching { Releases.snapshot(BuildConfig.VERSION_NAME) }
            val ok = snap.getOrNull()
            if (ok == null) {
                // сеть — самая частая причина, по которой установщик «ничего не
                // делает»: без неё не узнать ни версию модуля, ни обновление
                log("Релизы не проверились: ${snap.exceptionOrNull()?.message ?: "нет ответа"}")
                return@execute
            }
            runOnUiThread {
                log("Свежий модуль на GitHub: ${ok.module?.version ?: "не нашёлся"}")
                ok.installerUpdate?.let { log("Есть обновление установщика: v${it.version}") }
                availableModule = ok.module
                ok.installerUpdate?.let { showSelfUpdate(it) }
                render()  // перерисовать карточки с доступной версией модуля
            }
        }
    }

    private fun startSelfUpdate(upd: Releases.Found) {
        if (!ensureCanInstall()) return
        flowActive = true
        busy(true)
        step("Качаю установщик v${upd.version}…")
        io.execute {
            try {
                val apk = Http.download(upd.assetUrl, File(cacheDir, "installer.apk"), ::percent)
                runOnUiThread {
                    if (!flowActive) return@runOnUiThread
                    indeterminate()
                    Installer.install(this, listOf(apk), Installer.OP_SELF)
                }
            } catch (t: Throwable) {
                if (!flowActive) return@execute
                flowActive = false
                step("Не скачалось: ${t.message}", error = true)
                busy(false)
            }
        }
    }
}
