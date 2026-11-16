package io.github.stefanmayer06.inkbridge

import android.app.Application
import android.os.Build
import com.onyx.android.sdk.rx.RxManager
import org.lsposed.hiddenapibypass.HiddenApiBypass

class BridgeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // the Onyx SDK runs its work on this; it must know the app first
        runCatching { RxManager.Builder.initAppContext(this) }
        // the SDK reaches the firmware (EpdController) through hidden Android APIs
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { HiddenApiBypass.addHiddenApiExemptions("") }
        }
    }
}
