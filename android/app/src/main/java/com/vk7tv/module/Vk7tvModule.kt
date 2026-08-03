package com.vk7tv.module

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import de.robv.android.xposed.IXposedHookLoadPackage
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import de.robv.android.xposed.callbacks.XC_LoadPackage
import java.io.File

class Vk7tvModule : IXposedHookLoadPackage {

    override fun handleLoadPackage(lpp: XC_LoadPackage.LoadPackageParam) {
        // Белого списка пакетов тут нет намеренно. Приложение уже выбрано
        // человеком — в LSPatch при патче, в LSPosed в области действия.
        // Фильтровать второй раз означало бы ломать сторонние клиенты ВК
        // (Sova, Kate и прочие), у которых свои имена пакетов.
        if (lpp.packageName in SKIP) return
        L.i("зацепились за ${lpp.packageName}")

        // Каждый хук в своём try/catch. Раньше они стояли под одним, и падение
        // первого молча отменяло второй: не было ни эмоутов, ни кнопки, и по
        // симптому нельзя было понять, что именно сломалось.
        hookApplication()
        hookSetText()
        L.safe("хук панели ввода") { Inject.hook() }
    }

    /** Контекст нужен как можно раньше: без него диагностику некуда показывать. */
    private fun hookApplication() {
        L.safe("хук Application") {
            XposedHelpers.findAndHookMethod(
                Application::class.java,
                "onCreate",
                object : XC_MethodHook() {
                    override fun afterHookedMethod(param: MethodHookParam) {
                        L.safe("старт") { Boot.ensure(param.thisObject as? Context) }
                    }
                },
            )
        }
    }

    private fun hookSetText() {
        val hook = object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                L.safe("setText") {
                    val tv = param.thisObject as? TextView ?: return@safe
                    val cs = param.args[0] as? CharSequence ?: return@safe
                    Boot.ensure(tv.context)
                    val out = Replacer.apply(tv, cs) ?: return@safe
                    param.args[0] = out
                }
            }
        }

        // Приватный setText(CharSequence, BufferType, boolean, int) — через него
        // TextView прогоняет вообще все варианты setText, включая setText(int).
        // Цепляться за классы ВК нельзя: они обфусцированы и переименовываются
        // от версии к версии, а платформенный TextView стабилен.
        val full = L.safe("хук setText(4 аргумента)") {
            XposedHelpers.findAndHookMethod(
                TextView::class.java,
                "setText",
                CharSequence::class.java,
                TextView.BufferType::class.java,
                java.lang.Boolean.TYPE,
                Integer.TYPE,
                hook,
            )
            true
        }
        if (full == true) {
            Diag.note("хук setText установлен")
            return
        }

        // На части прошивок приватной перегрузки нет — цепляемся за публичную.
        // Она ловит меньше (setText(int) пройдёт мимо), но лучше, чем ничего.
        val simple = L.safe("хук setText(2 аргумента)") {
            XposedHelpers.findAndHookMethod(
                TextView::class.java,
                "setText",
                CharSequence::class.java,
                TextView.BufferType::class.java,
                hook,
            )
            true
        }
        Diag.note(
            if (simple == true) "хук setText запасной — работает"
            else "ХУК setText НЕ ВСТАЛ — эмоутов не будет",
        )
    }

    companion object {
        // системный процесс и мы сами — единственное, куда лезть не надо
        val SKIP = setOf("android", BuildConfig.APPLICATION_ID)
    }
}

object Boot {

    @Volatile
    private var started = false

    fun ensure(ctx: Context?) {
        if (started) return
        synchronized(this) {
            if (started) return
            val app = ctx?.applicationContext ?: return
            started = true
            Config.init(app)
            Diag.attach(app)
            Diag.note("модуль загружен ${BuildConfig.VERSION_NAME} в ${app.packageName}")
            val cache = File(app.cacheDir, "vk7tv").apply { mkdirs() }
            EmoteCache.init(cache)
            Suggest.init(cache)
            Thread({
                seedDefaultSet()
                L.safe("загрузка наборов") { Emotes.load(cache) }
                // диалог мог быть уже открыт — перерисовываем то, что на экране
                Replacer.rerenderAll()
                Inject.markReady()
                Diag.note("наборов ${Config.sets.size}, эмоутов ${Emotes.size()}")
                canary()
            }, "vk7tv-sets").apply { isDaemon = true }.start()
        }
    }

    /**
     * Первый запуск — подключаем набор стримера, как это делает расширение.
     * Одноразово: удалил из списка — сам не вернётся.
     */
    private fun seedDefaultSet() {
        if (Config.seeded || Config.sets.isNotEmpty()) return
        val ok = L.safe("набор по умолчанию") {
            Config.addSet(SevenTv.resolve(DEFAULT_STREAMER))
            true
        }
        // не было сети — попробуем при следующем запуске
        if (ok == true) Config.markSeeded()
    }

    /**
     * Перечитать наборы. Только не на UI-потоке.
     * force — выкачать заново даже то, что уже лежит в кэше (кнопка в настройках).
     */
    fun reload(ctx: Context, force: Boolean = false) {
        val cache = File(ctx.applicationContext.cacheDir, "vk7tv").apply { mkdirs() }
        L.safe("перезагрузка наборов") { Emotes.load(cache, force) }
        Replacer.rerenderAll()
        Inject.markReady()
    }

    /**
     * Канарейка. Если текста через нас прошло много, а подменять оказалось
     * нечего — скорее всего ВК рисует сообщения не через TextView, и хук
     * надо переделывать. Лучше честная строчка, чем неделя догадок.
     */
    private fun canary() {
        Handler(Looper.getMainLooper()).postDelayed({
            val msg = "текстов ${Replacer.seen}, подмен ${Replacer.replaced}, " +
                "кнопка ${if (Inject.attached) "есть" else "НЕТ"}"
            Diag.note(msg)
            if (Emotes.ready && Replacer.seen > 200 && Replacer.replaced == 0L) {
                Diag.note("подмен ноль — похоже, ВК рисует текст не через TextView")
            }
        }, 30_000)
    }

    private const val DEFAULT_STREAMER = "bratishkinoff"
}
