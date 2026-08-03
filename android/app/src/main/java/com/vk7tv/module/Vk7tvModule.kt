package com.vk7tv.module

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
        if (lpp.packageName !in TARGETS) return
        L.i("зацепились за ${lpp.packageName}")

        L.safe("инициализация") {
            hookSetText()
            Inject.hook()
        }
    }

    private fun hookSetText() {
        // Приватный setText(CharSequence, BufferType, boolean, int) — через него
        // TextView прогоняет вообще все варианты setText, включая setText(int).
        // Цепляться за классы ВК нельзя: они обфусцированы и переименовываются
        // от версии к версии, а платформенный TextView стабилен.
        XposedHelpers.findAndHookMethod(
            TextView::class.java,
            "setText",
            CharSequence::class.java,
            TextView.BufferType::class.java,
            java.lang.Boolean.TYPE,
            Integer.TYPE,
            object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    L.safe("setText") {
                        val tv = param.thisObject as? TextView ?: return@safe
                        val cs = param.args[0] as? CharSequence ?: return@safe
                        Boot.ensure(tv.context)
                        val out = Replacer.apply(tv, cs) ?: return@safe
                        param.args[0] = out
                    }
                }
            },
        )
        L.i("хук setText поставлен")
    }

    companion object {
        val TARGETS = setOf(
            "com.vkontakte.android", // ВКонтакте
            "com.vk.im",             // VK Мессенджер
        )
    }
}

/**
 * Ленивая инициализация: контекст приложения нужен ради cacheDir, а к моменту
 * первого setText он уже точно есть. Так обходимся без хука на Application.
 */
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
            val cache = File(app.cacheDir, "vk7tv").apply { mkdirs() }
            EmoteCache.init(cache)
            Thread({
                seedDefaultSet()
                L.safe("загрузка наборов") { Emotes.load(cache) }
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

    /** Перечитать наборы после правки настроек. Только не на UI-потоке. */
    fun reload(ctx: Context) {
        val cache = File(ctx.applicationContext.cacheDir, "vk7tv").apply { mkdirs() }
        L.safe("перезагрузка наборов") { Emotes.load(cache) }
    }

    private const val DEFAULT_STREAMER = "bratishkinoff"

    /**
     * Канарейка. Если наборы загрузились, текста через нас прошло много,
     * а подменять оказалось нечего — скорее всего ВК переехал на Compose
     * и хук setText больше не видит сообщений. Лучше честная строчка
     * в журнале, чем неделя догадок «почему пусто».
     */
    private fun canary() {
        Handler(Looper.getMainLooper()).postDelayed({
            L.i("статус: эмоутов ${Emotes.size()}, текстов ${Replacer.seen}, подмен ${Replacer.replaced}")
            if (Emotes.ready && Replacer.seen > 200 && Replacer.replaced == 0L) {
                L.i(
                    "ВНИМАНИЕ: ни одной подмены. Похоже, ВК обновился и рисует " +
                        "сообщения не через TextView — хук надо переделывать."
                )
            }
        }, 30_000)
    }
}
