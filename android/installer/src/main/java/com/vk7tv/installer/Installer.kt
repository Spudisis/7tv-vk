package com.vk7tv.installer

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File

/**
 * Установка и удаление APK через системный PackageInstaller. Результат прилетает
 * широковещанием [ACTION]; там же система просит подтверждение у пользователя
 * (STATUS_PENDING_USER_ACTION с интентом диалога — его надо запустить).
 */
object Installer {

    const val ACTION = "com.vk7tv.installer.STATUS"
    const val EXTRA_OP = "op"
    const val OP_INSTALL = "install"
    const val OP_UNINSTALL = "uninstall"
    const val OP_SELF = "selfupdate"

    private fun pending(ctx: Context, code: Int, op: String): PendingIntent {
        val intent = Intent(ACTION).setPackage(ctx.packageName).putExtra(EXTRA_OP, op)
        // MUTABLE обязателен: систему нужно дать дописать в интент статус и,
        // при необходимости, интент диалога подтверждения.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        return PendingIntent.getBroadcast(ctx, code, intent, flags)
    }

    /** Ставит набор APK (база + сплиты) одной сессией. */
    fun install(ctx: Context, apks: List<File>, op: String = OP_INSTALL) {
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL
        )
        val sid = pi.createSession(params)
        pi.openSession(sid).use { session ->
            for (apk in apks) {
                session.openWrite(apk.name, 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
            }
            session.commit(pending(ctx, sid, op).intentSender)
        }
    }

    fun uninstall(ctx: Context, pkg: String) {
        ctx.packageManager.packageInstaller.uninstall(
            pkg, pending(ctx, pkg.hashCode(), OP_UNINSTALL).intentSender
        )
    }
}
