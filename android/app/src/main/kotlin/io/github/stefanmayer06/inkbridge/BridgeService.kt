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
 * directly and has the firmware draw.
 *
 * The TouchHelper is driven the way Boox Rapid Draw drives it, which is known to
 * work over other apps: raw drawing is opened once when the window has its size
 * (again only when the screen turns) and then only paused and resumed
 * (setRawDrawingEnabled), the drawing area is changed in place, and the pen is
 * set after every resume (opening and resuming reset it). The firmware draws
 * only while the plugin holds a lease, only inside the ink page and never over
 * the plugin's toolbars and cards.
 *
 * When the pen is lifted and the page has been still for the refresh time, the
 * firmware refreshes the area and the plugin's own drawing of the stroke shows.
 */
class BridgeService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private var overlay: SurfaceView? = null
    private var helper: TouchHelper? = null
    /** Raw drawing is open (once per overlay size). */
    private var rawOpen = false
    /** The firmware draws now (resumed). */
    @Volatile private var enabled = false
    /** What the firmware was last asked (area, pen). */
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
    /** The self-test (whole screen, no Obsidian needed) runs until then. */
    private var testUntil = 0L
    /**
     * The self-test's pen engine (TouchHelper.FEATURE_*): 2, the firmware's own reader reads the pen
     * (what instant ink uses); 4 and 1, this window takes the pen for the test and hands its events
     * to the firmware drawing (to find out what works on a tablet whose reader does not).
     */
    private var testFeature = TouchHelper.FEATURE_SF_TOUCH_RENDER
    private var testHelper: TouchHelper? = null
    /** Pen/finger events this window received during a test that takes the pen. */
    @Volatile var touchEvents = 0
        private set

    /** What the firmware's pen reader reported (to tell whether the firmware path works on this tablet). */
    @Volatile var penHovers = 0
        private set
    @Volatile var penStrokes = 0
        private set

    /** When the plugin last sent its state (for the app's screen). */
    var lastMessageAt = 0L
        private set
    val isArmed: Boolean get() = enabled
    val isTesting: Boolean get() = testUntil > System.currentTimeMillis()
    val testName: String get() = testNameOf(testFeature)
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
            ACTION_TEST -> startTest(intent.getIntExtra(EXTRA_FEATURE, TouchHelper.FEATURE_SF_TOUCH_RENDER))
        }
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        testHelper?.let { runCatching { it.closeRawDrawing() } }
        testHelper = null
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
        // the same window as Boox Rapid Draw's
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSPARENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        // Android 12+ passes touches through another app's window only below 0.8 opacity
        lp.alpha = 0.2f
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
            if (w > 0 && h > 0 && (w != overlayW || h != overlayH)) {
                overlayW = w
                overlayH = h
                onOverlayResized()
            }
        }
    }

    /** The overlay got its size or the screen turned: open raw drawing for it and start the position over. */
    private fun onOverlayResized() {
        closeRaw()
        calibration.reset(0f, guessOffsetY())
        val saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(calibrationKey(), null)
        saved?.split(",")?.mapNotNull { it.toFloatOrNull() }?.takeIf { it.size == 2 }?.let { calibration.restore(it[0], it[1]) }
        openRaw()
        applyNow()
        report()
    }

    /** Where Obsidian's window probably starts in the overlay: below the status bar. */
    private fun guessOffsetY(): Float {
        val loc = IntArray(2)
        overlay?.getLocationOnScreen(loc)
        return (statusBarHeight() - loc[1]).toFloat()
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
            val now = System.currentTimeMillis()
            val live = state?.live(now) == true
            if (enabled && !live && !isTesting) {
                applyNow()
                report()
            }
            file?.active = live
            if (now - lastStatusWrite > STATUS_EVERY_MS) report(force = true)
            main.postDelayed(this, LEASE_CHECK_MS)
        }
    }

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            state = null
            testUntil = 0
            applyNow()
            report()
        }
    }

    // ------------------------------------------------------------------ the self-test

    /** The firmware drawing over the whole screen for a while, with no Obsidian involved. */
    private fun startTest(feature: Int) {
        endAppTest()
        testFeature = feature
        testUntil = System.currentTimeMillis() + TEST_MS
        penHovers = 0
        penStrokes = 0
        touchEvents = 0
        if (feature == TouchHelper.FEATURE_SF_TOUCH_RENDER) {
            applied = null
            applyNow()
        } else {
            startAppTest(feature)
        }
        report()
        main.postDelayed({
            if (!isTesting) {
                endAppTest()
                applied = null
                applyNow()
                report()
            }
        }, TEST_MS + 100)
    }

    /** A test where this window takes the pen and hands its events to the firmware drawing. */
    private fun startAppTest(feature: Int) {
        val v = overlay ?: return
        // the firmware-reader helper steps aside for the test
        closeRaw()
        setTouchable(true)
        val h = try {
            TouchHelper.create(v, feature, callback)
        } catch (e: Throwable) {
            error = "Test ${testNameOf(feature)}: ${e.javaClass.simpleName} ${e.message ?: ""}"
            null
        } ?: return
        testHelper = h
        v.setOnTouchListener { _, e ->
            touchEvents++
            try {
                h.onTouchEvent(e)
            } catch (_: Throwable) {
            }
            true
        }
        try {
            h.openRawDrawing()
            h.setLimitRect(Rect(0, 0, overlayW, overlayH), emptyList())
            h.setRawInputReaderEnable(true)
            h.setRawDrawingEnabled(true)
            h.setStrokeStyle(BridgeState.STYLE_PENCIL)
            h.setStrokeColor(0xFF000000.toInt())
            h.setStrokeWidth(3f)
        } catch (e: Throwable) {
            error = "Test ${testNameOf(feature)}: ${e.javaClass.simpleName} ${e.message ?: ""}"
        }
    }

    private fun endAppTest() {
        val h = testHelper ?: return
        testHelper = null
        runCatching {
            h.setRawDrawingEnabled(false)
            h.closeRawDrawing()
        }
        overlay?.setOnTouchListener(null)
        setTouchable(false)
        // back to the firmware's own reader
        openRaw()
    }

    private fun setTouchable(on: Boolean) {
        val v = overlay ?: return
        val lp = v.layoutParams as? WindowManager.LayoutParams ?: return
        lp.flags = if (on) lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv() else lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        runCatching { wm.updateViewLayout(v, lp) }
    }

    // ------------------------------------------------------------------ firmware drawing

    private fun openRaw() {
        val h = helper ?: return
        if (rawOpen || overlayW == 0) return
        try {
            h.openRawDrawing()
            h.setLimitRect(Rect(0, 0, overlayW, overlayH), emptyList())
            h.setRawInputReaderEnable(true)
            // drawn only while the plugin asks
            h.setRawDrawingEnabled(false)
            rawOpen = true
            enabled = false
            applied = null
        } catch (e: Throwable) {
            error = "Could not open raw drawing: ${e.javaClass.simpleName} ${e.message ?: ""}"
        }
    }

    private fun closeRaw() {
        val h = helper ?: return
        if (!rawOpen) return
        rawOpen = false
        enabled = false
        applied = null
        try {
            h.setRawDrawingEnabled(false)
            h.closeRawDrawing()
        } catch (_: Throwable) {
        }
    }

    /** The firmware request now: the self-test, the plugin's state, or nothing. */
    private fun request(now: Long): FirmwareRequest? {
        if (testUntil > now && overlayW > 0 && testFeature == TouchHelper.FEATURE_SF_TOUCH_RENDER) {
            return FirmwareRequest(PxRect(0, 0, overlayW, overlayH), emptyList(), PenSpec(BridgeState.STYLE_PENCIL, 3f, 0xFF000000.toInt()), 1000, true)
        }
        return firmwareRequest(state, calibration, overlayW, overlayH, now)
    }

    private fun applyNow() {
        // a test that takes the pen is running: it has the window to itself
        if (testHelper != null) return
        val h = helper ?: return
        if (!rawOpen) openRaw()
        if (!rawOpen) return
        val target = request(System.currentTimeMillis())
        try {
            if (target == null) {
                if (enabled) h.setRawDrawingEnabled(false)
                enabled = false
                return
            }
            val cur = applied
            if (cur == null || cur.limit != target.limit || cur.exclude != target.exclude) {
                h.setLimitRect(target.limit.toRect(), target.exclude.map { it.toRect() })
            }
            if (!enabled) {
                h.setRawDrawingEnabled(true)
                enabled = true
            }
            setPen(h, target)
            if (cur?.refreshMs != target.refreshMs) h.setPenUpRefreshTimeMs(target.refreshMs)
            if (cur?.sideButton != target.sideButton) h.enableSideBtnErase(target.sideButton)
            applied = target
            error = null
        } catch (e: Throwable) {
            error = "${e.javaClass.simpleName}: ${e.message ?: ""}"
            applied = null
        }
    }

    /** Opening and resuming reset the pen, so it is set again after each. */
    private fun setPen(h: TouchHelper, r: FirmwareRequest) {
        h.setStrokeStyle(r.pen.style)
        h.setStrokeColor(r.pen.color)
        h.setStrokeWidth(r.pen.width)
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
            penStrokes++
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
            penHovers++
            main.post {
                val h = helper ?: return@post
                val r = applied ?: return@post
                if (!enabled) return@post
                try {
                    h.setRawDrawingEnabled(true)
                    setPen(h, r)
                } catch (_: Throwable) {
                }
            }
        }

        // ... and the firmware's layer off once the area was refreshed after the pen was lifted
        override fun onPenUpRefresh(refreshRect: RectF?) {
            try {
                if (enabled) helper?.setRawDrawingRenderEnabled(false)
            } catch (_: Throwable) {
            }
            super.onPenUpRefresh(refreshRect)
        }
    }

    // ------------------------------------------------------------------ status

    private fun report(force: Boolean = false) {
        val c = calibration
        val json = BridgeState.status(enabled, c.calibrated, c.offsetX, c.offsetY, transport, error, state?.seq ?: 0, penHovers, penStrokes)
        socket?.send(json)
        val key = "$enabled|${c.calibrated}|$transport|$error|$penStrokes"
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
        const val ACTION_TEST = "io.github.stefanmayer06.inkbridge.TEST"
        private const val CHANNEL = "bridge"
        private const val NOTIFICATION_ID = 1
        private const val PREFS = "bridge"
        private const val LEASE_CHECK_MS = 500L
        private const val STATUS_EVERY_MS = 5_000L
        const val TEST_MS = 30_000L
        const val EXTRA_FEATURE = "feature"
        /** TouchHelper.FEATURE_APP_PEN_TOUCH_RENDER (SDK 1.5.9). */
        const val FEATURE_APP_PEN = 4

        fun testNameOf(feature: Int) = when (feature) {
            TouchHelper.FEATURE_SF_TOUCH_RENDER -> "1 (firmware reads the pen)"
            FEATURE_APP_PEN -> "2 (Bridge hands on the pen, pen mode)"
            TouchHelper.FEATURE_APP_TOUCH_RENDER -> "3 (Bridge hands on the pen, touch mode)"
            else -> "$feature"
        }

        @Volatile
        var instance: BridgeService? = null
            private set
    }
}

private fun PxRect.toRect() = Rect(l, t, r, b)
