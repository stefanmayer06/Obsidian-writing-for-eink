package io.github.stefanmayer06.inkbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.SurfaceView
import android.view.WindowManager
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.data.note.TouchPoint
import com.onyx.android.sdk.pen.RawInputCallback
import com.onyx.android.sdk.pen.TouchHelper
import com.onyx.android.sdk.pen.data.TouchPointList

/**
 * Shows the pen's ink instantly over the Ink Notebook page, the way the Boox
 * Notes app does: the Boox firmware draws the stroke straight onto the e-ink
 * panel while the pen moves.
 *
 * A transparent window covers the screen. It takes no touches (so Obsidian gets
 * the pen and the fingers exactly as before and records the stroke itself) and
 * hosts Onyx's TouchHelper in its SurfaceFlinger mode, which reads the pen
 * directly and has the firmware draw. Raw drawing is open only while the plugin
 * holds a lease, only inside the ink page and never over the plugin's toolbars
 * and cards; everywhere else and at all other times the tablet behaves as if
 * this app did not exist.
 *
 * When the pen is lifted and the page has been still for the refresh time, the
 * firmware refreshes the area and the plugin's own drawing of the stroke shows.
 */
class BridgeService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private var overlay: SurfaceView? = null
    private var helper: TouchHelper? = null
    @Volatile private var open = false
    private var applied: FirmwareRequest? = null
    private var state: BridgeState? = null
    private var lastSeq = Long.MIN_VALUE
    private var lastUntil = Long.MIN_VALUE
    private var lastClear: Long? = null
    private var calibration = Calibration()
    private var overlayW = 0
    private var overlayH = 0
    private var file: ControlFile? = null
    private var socket: ControlSocket? = null
    private var transport = "none"
    private var error: String? = null
    private var lastStatusKey = ""
    private var lastStatusWrite = 0L

    /** When the plugin last sent its state (for the app's screen). */
    var lastMessageAt = 0L
        private set
    val isArmed: Boolean get() = open
    val isCalibrated: Boolean get() = calibration.calibrated
    val transportName: String get() = transport
    val lastError: String? get() = error
    val bridgeDirs get() = file?.bridgeDirs ?: emptyList()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        startInForeground()
        wm = getSystemService(WINDOW_SERVICE) as WindowManager
        calibration = Calibration(0f, statusBarHeight().toFloat())
        addOverlay()
        file = ControlFile(this) { text -> main.post { onText(text, "file") } }.also { it.start() }
        socket = try {
            ControlSocket(
                ControlSocket.PORT,
                onText = { text -> main.post { onText(text, "socket") } },
                onClientsChanged = { n -> main.post { onSocketClients(n) } },
            ).also { it.start() }
        } catch (e: Exception) {
            null
        }
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(screenOff, filter)
        main.postDelayed(leaseCheck, LEASE_CHECK_MS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                BootReceiver.setWanted(this, false)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RESCAN -> file?.rescanNow()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        closeRaw()
        try {
            unregisterReceiver(screenOff)
        } catch (_: Exception) {
        }
        file?.stop()
        socket?.let { s -> Thread { runCatching { s.stop(500) } }.start() }
        overlay?.let { runCatching { wm.removeViewImmediate(it) } }
        overlay = null
        helper = null
        instance = null
        super.onDestroy()
    }

    // ------------------------------------------------------------------ overlay

    private fun addOverlay() {
        val v = SurfaceView(this)
        v.setZOrderOnTop(true)
        v.holder.setFormat(PixelFormat.TRANSPARENT)
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSPARENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        // Android 12+ passes touches through another app's window only below 0.8 opacity
        lp.alpha = 0.2f
        lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        wm.addView(v, lp)
        overlay = v
        helper = try {
            TouchHelper.create(v, TouchHelper.FEATURE_SF_TOUCH_RENDER, callback)
        } catch (e: Throwable) {
            error = "Onyx pen SDK not available: ${e.javaClass.simpleName}"
            null
        }
        v.addOnLayoutChangeListener { _, l, t, r, b, _, _, _, _ ->
            val w = r - l
            val h = b - t
            if (w != overlayW || h != overlayH) {
                overlayW = w
                overlayH = h
                onOverlayResized()
            }
        }
    }

    /** The screen turned (or the overlay got its size): start over with the offset measured for this size. */
    private fun onOverlayResized() {
        closeRaw()
        calibration.reset(0f, statusBarHeight().toFloat())
        val saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(calibrationKey(), null)
        saved?.split(",")?.mapNotNull { it.toFloatOrNull() }?.takeIf { it.size == 2 }?.let { calibration.restore(it[0], it[1]) }
        applyNow()
        report()
    }

    private fun calibrationKey() = "cal_${overlayW}x$overlayH"

    private fun saveCalibration() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(calibrationKey(), "${calibration.offsetX},${calibration.offsetY}")
            .apply()
    }

    private fun statusBarHeight(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else 0
    }

    // ------------------------------------------------------------------ messages

    private fun onText(text: String, source: String) {
        val s = BridgeState.parse(text) ?: return
        lastMessageAt = System.currentTimeMillis()
        transport = source
        // the same state again (both channels, or an unchanged file)
        if (s.seq == lastSeq && s.until == lastUntil) return
        lastSeq = s.seq
        lastUntil = s.until
        state = s
        file?.active = s.live(lastMessageAt)
        s.down?.let {
            if (calibration.match(it, s.dpr)) {
                saveCalibration()
                applied = null
            }
        }
        val prevClear = lastClear
        lastClear = s.clear
        if (prevClear != null && prevClear != s.clear) clearInk()
        applyNow()
        report()
    }

    private fun onSocketClients(n: Int) {
        if (n == 0 && transport == "socket") {
            // Obsidian closed the connection (went to the background, or the page closed)
            state = state?.copy(armed = false)
            applyNow()
            report()
        }
    }

    private val leaseCheck = object : Runnable {
        override fun run() {
            val s = state
            val now = System.currentTimeMillis()
            if (open && (s == null || !s.live(now))) {
                closeRaw()
                report()
            }
            file?.active = s?.live(now) == true
            if (now - lastStatusWrite > STATUS_EVERY_MS) report(force = true)
            main.postDelayed(this, LEASE_CHECK_MS)
        }
    }

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            state = null
            closeRaw()
            report()
        }
    }

    // ------------------------------------------------------------------ firmware drawing

    private fun applyNow() {
        val h = helper ?: return
        val target = firmwareRequest(state, calibration, overlayW, overlayH, System.currentTimeMillis())
        if (target == null) {
            closeRaw()
            return
        }
        val cur = applied
        try {
            if (!open || cur == null || cur.limit != target.limit || cur.exclude != target.exclude) {
                // the SDK takes a new region only when raw drawing is opened again
                if (open) h.closeRawDrawing()
                open = false
                h.setStrokeStyle(target.pen.style)
                h.setStrokeColor(target.pen.color)
                h.openRawDrawing()
                h.setStrokeWidth(target.pen.width).setLimitRect(target.limit.toRect(), target.exclude.map { it.toRect() })
                h.setRawInputReaderEnable(true)
                open = true
                h.setRawDrawingEnabled(true)
            } else if (cur.pen != target.pen) {
                h.setStrokeStyle(target.pen.style)
                h.setStrokeColor(target.pen.color)
                h.setStrokeWidth(target.pen.width)
            }
            if (cur?.refreshMs != target.refreshMs) h.setPenUpRefreshTimeMs(target.refreshMs)
            if (cur?.sideButton != target.sideButton) h.enableSideBtnErase(target.sideButton)
            applied = target
            error = null
        } catch (e: Throwable) {
            error = "${e.javaClass.simpleName}: ${e.message ?: ""}"
            open = false
            applied = null
        }
    }

    private fun closeRaw() {
        val h = helper ?: return
        if (!open) return
        open = false
        applied = null
        try {
            h.setRawDrawingEnabled(false)
            h.closeRawDrawing()
        } catch (_: Throwable) {
        }
    }

    /** The last stroke was not ink after all: take the firmware's ink off the page now. */
    private fun clearInk() {
        val h = helper ?: return
        val v = overlay ?: return
        val a = applied ?: return
        try {
            h.setRawDrawingRenderEnabled(false)
            EpdController.handwritingRepaint(v, a.limit.toRect())
        } catch (_: Throwable) {
        }
        // drawing comes back when the pen next comes near the screen (onPenActive)
    }

    private val callback = object : RawInputCallback() {
        override fun onBeginRawDrawing(b: Boolean, p: TouchPoint?) {
            if (p == null) return
            val x = p.x
            val y = p.y
            val t = System.currentTimeMillis()
            main.post { calibration.recordRaw(x, y, t) }
        }

        override fun onEndRawDrawing(b: Boolean, p: TouchPoint?) {}
        override fun onRawDrawingTouchPointMoveReceived(p: TouchPoint?) {}
        override fun onRawDrawingTouchPointListReceived(list: TouchPointList?) {}
        override fun onBeginRawErasing(b: Boolean, p: TouchPoint?) {}
        override fun onEndRawErasing(b: Boolean, p: TouchPoint?) {}
        override fun onRawErasingTouchPointMoveReceived(p: TouchPoint?) {}
        override fun onRawErasingTouchPointListReceived(list: TouchPointList?) {}

        // as in Boox Rapid Draw: drawing on when the pen comes near the screen ...
        override fun onPenActive(point: TouchPoint?) {
            if (!open) return
            try {
                helper?.setRawDrawingEnabled(true)
            } catch (_: Throwable) {
            }
        }

        // ... and the firmware's layer off once the area was refreshed after the pen was lifted
        override fun onPenUpRefresh(refreshRect: RectF?) {
            try {
                if (open) helper?.setRawDrawingRenderEnabled(false)
            } catch (_: Throwable) {
            }
            super.onPenUpRefresh(refreshRect)
        }
    }

    // ------------------------------------------------------------------ status

    private fun report(force: Boolean = false) {
        val c = calibration
        val json = BridgeState.status(open, c.calibrated, c.offsetX, c.offsetY, transport, error, state?.seq ?: 0)
        socket?.send(json)
        val key = "$open|${c.calibrated}|$transport|$error"
        val now = System.currentTimeMillis()
        if (force || key != lastStatusKey || now - lastStatusWrite > STATUS_EVERY_MS) {
            file?.writeStatus(json)
            lastStatusKey = key
            lastStatusWrite = now
        }
    }

    private fun startInForeground() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Ink Notebook Bridge", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(
            this,
            0,
            Intent(this, BridgeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openApp = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("Ink Notebook Bridge")
            .setContentText("Instant ink on Ink Notebook pages")
            .setSmallIcon(R.drawable.ic_bridge)
            .setContentIntent(openApp)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    companion object {
        const val ACTION_STOP = "io.github.stefanmayer06.inkbridge.STOP"
        const val ACTION_RESCAN = "io.github.stefanmayer06.inkbridge.RESCAN"
        private const val CHANNEL = "bridge"
        private const val NOTIFICATION_ID = 1
        private const val PREFS = "bridge"
        private const val LEASE_CHECK_MS = 500L
        private const val STATUS_EVERY_MS = 5_000L

        @Volatile
        var instance: BridgeService? = null
            private set
    }
}

private fun PxRect.toRect() = Rect(l, t, r, b)
