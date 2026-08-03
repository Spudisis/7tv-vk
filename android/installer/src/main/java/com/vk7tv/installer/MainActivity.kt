package com.vk7tv.installer

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.method.ScrollingMovementMethod
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.concurrent.Executors

/**
 * Экран установщика. Одна кнопка на клиента ВК: «Пропатчить» (оригинал) или
 * «Обновить модуль» (уже пропатчен). Всё тяжёлое — в фоновом потоке, установка
 * и удаление — через системные диалоги, результат ловим широковещанием.
 */
class MainActivity : Activity() {

    private val io = Executors.newSingleThreadExecutor()

    private lateinit var candidates: LinearLayout
    private lateinit var banner: LinearLayout
    private lateinit var logView: TextView
    private lateinit var progress: ProgressBar
    private lateinit var hint: TextView

    // текущая операция
    private var targetPkg: String? = null
    private var patchedApks: List<File> = emptyList()
    private var installAfterUninstall = false
    private var updateMode = false
    private var selfUpdateApk: File? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val op = intent.getStringExtra(Installer.EXTRA_OP) ?: return
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    val confirm = @Suppress("DEPRECATION")
                    (intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (confirm != null) startActivity(confirm)
                }
                PackageInstaller.STATUS_SUCCESS -> onOpDone(op, true, null)
                else -> onOpDone(op, false, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        registerStatusReceiver()
        checkSelfUpdate()
        render()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(receiver) }
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

    // ---- UI ----

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        root.addView(TextView(this).apply {
            text = "VK7TV — установщик для ВК"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        hint = TextView(this).apply {
            setPadding(0, dp(8), 0, dp(8))
            text = "Выбери клиент ВК, который нужно пропатчить."
        }
        root.addView(hint)

        banner = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(banner)

        candidates = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(candidates)

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.GONE
        }
        root.addView(progress)

        logView = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(Color.DKGRAY)
            typeface = android.graphics.Typeface.MONOSPACE
            movementMethod = ScrollingMovementMethod()
            setPadding(0, dp(12), 0, 0)
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
            addView(logView)
        }
        root.addView(scroll)

        return root
    }

    private fun render() {
        candidates.removeAllViews()
        val found = Vk.clients(this)
        if (found.isEmpty()) {
            candidates.addView(TextView(this).apply {
                text = "Клиент ВК не найден. Можно выбрать приложение вручную."
                setPadding(0, dp(8), 0, dp(8))
            })
        }
        for (c in found) addCandidateRow(c)
        candidates.addView(Button(this).apply {
            text = "Показать все приложения"
            setOnClickListener { showAll() }
        })
    }

    private fun addCandidateRow(c: Vk.Client) {
        candidates.addView(Button(this).apply {
            text = "${c.label} — " + if (c.patched) "обновить модуль" else "пропатчить"
            setOnClickListener { startFlow(c) }
        })
    }

    private fun showAll() {
        candidates.removeAllViews()
        candidates.addView(TextView(this).apply {
            text = "Все приложения. Выбирай только клиент ВК."
            setPadding(0, dp(8), 0, dp(8))
        })
        for (c in Vk.all(this)) addCandidateRow(c)
    }

    private fun bannerButton(text: String, onClick: () -> Unit) {
        banner.removeAllViews()
        banner.addView(Button(this).apply {
            this.text = text
            setOnClickListener { onClick() }
        })
    }

    private fun log(s: String) = runOnUiThread {
        logView.append(if (logView.text.isEmpty()) s else "\n$s")
    }

    private fun busy(on: Boolean) = runOnUiThread {
        progress.visibility = if (on) View.VISIBLE else View.GONE
        for (i in 0 until candidates.childCount) candidates.getChildAt(i).isEnabled = !on
        for (i in 0 until banner.childCount) banner.getChildAt(i).isEnabled = !on
    }

    // ---- поток патча ----

    private fun ensureCanInstall(): Boolean {
        if (packageManager.canRequestPackageInstalls()) return true
        hint.text = "Разреши установку приложений из этого источника и вернись."
        startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
        )
        return false
    }

    private fun startFlow(c: Vk.Client) {
        if (!ensureCanInstall()) return
        targetPkg = c.pkg
        updateMode = c.patched
        busy(true)
        log("=== ${c.label} (${c.pkg})")
        io.execute {
            try {
                val module = Releases.moduleApk(this, ::log)
                val keystore = extractKeystore()
                val work = File(cacheDir, "work").apply { deleteRecursively(); mkdirs() }
                val originals = Vk.originals(this, c, work, ::log)
                val out = File(cacheDir, "out")
                patchedApks = Patcher.patch(originals, module, keystore, out, ::log)
                runOnUiThread { proceedAfterPatch() }
            } catch (t: Throwable) {
                log("! Ошибка: ${t.message}")
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

    private fun proceedAfterPatch() {
        val pkg = targetPkg ?: return
        if (updateMode) {
            // Пропатченный ВК и новый патч подписаны одним ключом LSPatch —
            // ставим поверх, данные и вход в аккаунт сохраняются.
            log("Ставлю обновление поверх (вход сохранится)…")
            installAfterUninstall = false
            Installer.install(this, patchedApks)
        } else {
            // Оригинал подписан ключом ВК, патч — ключом LSPatch. Поверх нельзя,
            // сначала удаляем оригинал. После этого придётся войти заново.
            log("Удаляю оригинальный ВК (переписка на сервере, вход — заново)…")
            installAfterUninstall = true
            Installer.uninstall(this, pkg)
        }
    }

    private fun onOpDone(op: String, ok: Boolean, msg: String?) {
        when (op) {
            Installer.OP_UNINSTALL -> {
                if (ok && installAfterUninstall) {
                    installAfterUninstall = false
                    log("Оригинал удалён, ставлю VK7TV…")
                    Installer.install(this, patchedApks)
                } else {
                    log(if (ok) "Удалено." else "Удаление отменено.")
                    busy(false)
                }
            }
            Installer.OP_INSTALL -> {
                if (ok) {
                    log("Готово. VK7TV установлен.")
                    busy(false)
                    offerOpen()
                    render()
                } else {
                    log("! Установка не удалась: ${msg ?: "отменено"}")
                    if (updateMode) offerReinstall()
                    busy(false)
                }
            }
            Installer.OP_SELF -> {
                log(if (ok) "Установщик обновлён." else "Обновление установщика не удалось: ${msg ?: "отменено"}")
                busy(false)
            }
        }
    }

    private fun offerOpen() {
        val pkg = targetPkg ?: return
        val launch = packageManager.getLaunchIntentForPackage(pkg) ?: return
        banner.removeAllViews()
        banner.addView(Button(this).apply {
            text = "Открыть ВК"
            setOnClickListener { startActivity(launch) }
        })
    }

    private fun offerReinstall() {
        // Подписи разошлись (например, ВК патчили другой версией LSPatch):
        // поверх не встало. Полная переустановка — с потерей входа.
        banner.removeAllViews()
        banner.addView(Button(this).apply {
            text = "Переустановить начисто (вход сбросится)"
            setOnClickListener {
                val pkg = targetPkg ?: return@setOnClickListener
                busy(true)
                installAfterUninstall = true
                log("Удаляю пропатченный ВК…")
                Installer.uninstall(this@MainActivity, pkg)
            }
        })
    }

    // ---- самообновление установщика ----

    private fun checkSelfUpdate() {
        io.execute {
            val upd = Releases.installerUpdate(BuildConfig.VERSION_NAME) ?: return@execute
            runOnUiThread {
                bannerButton("Обновить установщик до ${upd.version}") { startSelfUpdate(upd) }
            }
        }
    }

    private fun startSelfUpdate(upd: Releases.Found) {
        if (!ensureCanInstall()) return
        busy(true)
        log("Качаю установщик ${upd.version}…")
        io.execute {
            try {
                val apk = Http.download(upd.assetUrl, File(cacheDir, "installer.apk")) { d, t ->
                    if (t > 0) log("  ${d * 100 / t}%")
                }
                selfUpdateApk = apk
                runOnUiThread {
                    Installer.install(this, listOf(apk), Installer.OP_SELF)
                }
            } catch (t: Throwable) {
                log("! Не скачалось: ${t.message}")
                busy(false)
            }
        }
    }
}
