package io.github.stefanmayer06.inkbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Starts the Bridge again after the tablet restarts, when it was running before. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!isWanted(context) || !Settings.canDrawOverlays(context)) return
        runCatching { context.startForegroundService(Intent(context, BridgeService::class.java)) }
    }

    companion object {
        private const val PREFS = "bridge"
        private const val KEY = "wanted"

        fun isWanted(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)

        fun setWanted(context: Context, wanted: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, wanted).apply()
        }
    }
}
