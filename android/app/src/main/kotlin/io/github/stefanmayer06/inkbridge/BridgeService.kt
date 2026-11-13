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
 * (again only when the screen turns) and then only paused and resumed, the
 * drawing area is changed in place, and the pen is set after every resume
 * (opening and resuming reset it). The firmware draws only while the plugin holds
 * a lease, only inside the ink page and never over the plugin's toolbars and
 * cards.
 *
 * While the firmware draws, the panel is in its handwriting mode and does not
 * keep up with Obsidian's screen (a tool change or a new page would show late).
 * So the firmware draws only while the pen is over the page: it pauses the moment
 * the pen goes to a toolbar, something else is pressed, or the page changes, and
 * draws again when the pen next hovers over the page ([InkGate]).
 */
class BridgeService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private var overlay: SurfaceView? = null
    private var helper: TouchHelper? = null
    /** Raw drawing is open (once per overlay size). */
    private var rawOpen = false
    /** Instant ink is on: the firmware's pen reader runs, and the firmware draws whenever [gate] lets it. */
    @Volatile private var enabled = false
    /** When the firmware may draw, moment by moment (the pen over the page, nothing else changing). */
    private val gate = InkGate()
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
    /** Instant ink in words, for the app's screen. */
    val inkState: String get() = when {
        !enabled -> "off"
        gate.draws -> "drawing (pen over the page)"
        else -> "paused – ${gate.reason}"
    }
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
            ACTION_RECALIBRATE -> recalibrate()
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
        saved?.split(",")?.map { it.toFloatOrNull() }?.let {
            if (it.size >= 2 && it[0] != null && it[1] != null) calibration.restore(it[0]!!, it[1]!!, it.getOrNull(2), it.getOrNull(3))
        }
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

    // v2: offset and scale (the 0.4/0.5 offsets were measured assuming the device pixel ratio)
    private fun calibrationKey() = "cal2_${overlayW}x$overlayH"

    private fun saveCalibration() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(calibrationKey(), "${calibration.offsetX},${calibration.offsetY},${calibration.scaleX ?: ""},${calibration.scaleY ?: ""}")
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
        val prev = state
        state = s
        file?.active = s.leased(lastMessageAt)
        // what the gate waited for (a state sent after a toolbar visit), then what this one changes
        gate.stateSent(s.at)
        val screenChanged = prev != null && !s.sameScreen(prev)
        // a press elsewhere: wait for what it changes – unless that came with it (the control file
        // keeps only the latest state, so the press and the new tool can arrive as one)
        if (prev != null && s.ui != prev.ui && !screenChanged) gate.pressedElsewhere(s.at, lastMessageAt)
        if (screenChanged) gate.changed()
        s.down?.let {
            if (calibration.match(it, s.dpr)) {
                saveCalibration()
                applied = null
            }
        }
        val prevClear = lastClear
        lastClear = s.clear
        if (prevClear != null && prevClear != s.clear) gate.cleared()
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
            file?.active = state?.leased(now) == true
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
            // drawn only while the plugin asks: paused (opening leaves the firmware "started", not paused)
            h.forceSetRawDrawingEnabled(false)
            rawOpen = true
            enabled = false
            gate.disarm()
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
        gate.disarm()
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
                gate.disarm()
                return
            }
            val cur = applied
            if (cur == null || cur.limit != target.limit || cur.exclude != target.exclude) {
                h.setLimitRect(target.limit.toRect(), target.exclude.map { it.toRect() })
            }
            if (!enabled) {
                // the pen reader runs; the firmware draws from the pen's first hover over the page
                h.setRawInputReaderEnable(true)
                h.resetPenDefaultRawDrawing()
                enabled = true
                gate.arm()
            }
            if (cur?.refreshMs != target.refreshMs) h.setPenUpRefreshTimeMs(target.refreshMs)
            if (cur?.sideButton != target.sideButton) h.enableSideBtnErase(target.sideButton)
            applied = target
            error = null
            syncInk(h, penChanged = cur?.pen != target.pen)
        } catch (e: Throwable) {
            error = "${e.javaClass.simpleName}: ${e.message ?: ""}"
            applied = null
        }
    }

    /**
     * The firmware draws or pauses as [gate] says. Pausing takes the panel out of its handwriting
     * mode, so it shows Obsidian's screen again (the page's own drawing of every stroke, the
     * toolbar, cards, a new page).
     */
    private fun syncInk(h: TouchHelper, penChanged: Boolean = false) {
        val want = enabled && gate.draws
        try {
            if (want && !h.isRawDrawingRenderEnabled) {
                h.setRawDrawingRenderEnabled(true)
                applied?.let { setPen(h, it) }
            } else if (!want && h.isRawDrawingRenderEnabled) {
                h.setRawDrawingRenderEnabled(false)
            } else if (want && penChanged) {
                applied?.let { setPen(h, it) }
            }
        } catch (e: Throwable) {
            error = "${e.javaClass.simpleName}: ${e.message ?: ""}"
        }
        // a tablet whose pen reader reports no hovering: draw again a moment later instead
        if (enabled && !want && penHovers == 0) {
            main.removeCallbacks(releaseWithoutHover)
            main.postDelayed(releaseWithoutHover, NO_HOVER_RELEASE_MS)
        }
    }

    private val releaseWithoutHover = Runnable {
        val h = helper ?: return@Runnable
        if (!enabled || penHovers > 0) return@Runnable
        gate.hover(InkGate.Zone.PAGE, System.currentTimeMillis())
        syncInk(h)
    }

    /** The pen hovers at (x, y) in the overlay: over the page, its edge, or a toolbar. */
    private fun onHover(x: Float, y: Float) {
        val h = helper ?: return
        val r = applied ?: return
        if (!enabled || testHelper != null) return
        gate.hover(zoneOf(x, y, r), System.currentTimeMillis())
        syncInk(h)
    }

    /** Opening and resuming reset the pen, so it is set again after each. */
    private fun setPen(h: TouchHelper, r: FirmwareRequest) {
        h.setStrokeStyle(r.pen.style)
        h.setStrokeColor(r.pen.color)
        h.setStrokeWidth(r.pen.width)
    }

    /** What the firmware is asked now, in words (for the app's screen). */
    val drawingArea: String
        get() {
            val a = applied ?: return "none"
            val c = calibration
            val scale = if (c.scaleX != null || c.scaleY != null) {
                " – scale measured: %.3f × %.3f".format(c.scaleX ?: 0f, c.scaleY ?: 0f)
            } else {
                ""
            }
            return "x ${a.limit.l}–${a.limit.r}, y ${a.limit.t}–${a.limit.b} of ${overlayW}×$overlayH, " +
                "${a.exclude.size} part(s) left out, offset %.0f, %.0f".format(c.offsetX, c.offsetY) + scale
        }

    /** Measure where Obsidian's page is again (from the next pen-downs). */
    private fun recalibrate() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(calibrationKey()).apply()
        calibration.reset(0f, guessOffsetY())
        applied = null
        applyNow()
        report()
    }

    /** A hover from another thread waits for the main thread (hovers come hundreds of times a second: one at a time). */
    private val hoverPending = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var hoverX = 0f
    @Volatile private var hoverY = 0f

    /** Run on the main thread (the SDK calls back on it, through its view; other pen engines may not). */
    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) block() else main.post { block() }
    }

    private val callback = object : RawInputCallback() {
        override fun onBeginRawDrawing(b: Boolean, p: TouchPoint?) {
            penStrokes++
            val t = System.currentTimeMillis()
            val x = p?.x
            val y = p?.y
            onMain {
                gate.penDown()
                if (x != null && y != null) calibration.recordRaw(x, y, t)
            }
        }

        override fun onEndRawDrawing(b: Boolean, p: TouchPoint?) {
            onMain {
                gate.penUp()
                helper?.let { syncInk(it) }
            }
        }
        override fun onRawDrawingTouchPointMoveReceived(p: TouchPoint?) {}
        override fun onRawDrawingTouchPointListReceived(list: TouchPointList?) {}
        override fun onBeginRawErasing(b: Boolean, p: TouchPoint?) {}
        override fun onEndRawErasing(b: Boolean, p: TouchPoint?) {}
        override fun onRawErasingTouchPointMoveReceived(p: TouchPoint?) {}
        override fun onRawErasingTouchPointListReceived(list: TouchPointList?) {}

        // The pen hovers. This comes hundreds of times a second: the check is cheap, and the
        // firmware is only called when the gate changes its mind (a flood of firmware calls here
        // once held up the plugin's pen and colour changes for seconds).
        override fun onPenActive(point: TouchPoint?) {
            penHovers++
            val p = point ?: return
            if (Looper.myLooper() === Looper.getMainLooper()) {
                onHover(p.x, p.y)
                return
            }
            hoverX = p.x
            hoverY = p.y
            if (!hoverPending.compareAndSet(false, true)) return
            main.post {
                hoverPending.set(false)
                onHover(hoverX, hoverY)
            }
        }

        // The pen was lifted: nothing to do. The firmware's ink stays where Obsidian draws the same
        // stroke until the panel shows Obsidian again (the pen goes to a toolbar, the page changes).
        // Turning the layer off here, as Boox Rapid Draw does, repaints the whole area after every
        // stroke.
        override fun onPenUpRefresh(refreshRect: RectF?) {}
    }

    // ------------------------------------------------------------------ status

    private fun report(force: Boolean = false) {
        val c = calibration
        val json = BridgeState.status(enabled, c.calibrated, c.offsetX, c.offsetY, transport, error, state?.seq ?: 0, penHovers, penStrokes, gate.reason)
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
        const val ACTION_RECALIBRATE = "io.github.stefanmayer06.inkbridge.RECALIBRATE"
        private const val CHANNEL = "bridge"
        private const val NOTIFICATION_ID = 1
        private const val PREFS = "bridge"
        private const val LEASE_CHECK_MS = 500L
        /** Without hover reports, the firmware draws again this long after it paused. */
        private const val NO_HOVER_RELEASE_MS = 300L
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
