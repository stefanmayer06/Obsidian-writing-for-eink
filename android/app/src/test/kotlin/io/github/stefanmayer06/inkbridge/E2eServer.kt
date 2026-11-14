package io.github.stefanmayer06.inkbridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * The Bridge without Android, for the end-to-end test (dev/fastink-e2e.cjs):
 * the production control socket, protocol, calibration and firmware request,
 * with the firmware replaced by a report of what it would be asked to do.
 *
 * The test page sends the plugin's state (the real plugin code) and, as the
 * firmware's pen reader would, `{"type":"raw-test","x":…,"y":…,"t":…}` for each
 * pen-down in screen pixels. The overlay starts at the screen's top-left corner
 * (`[overlayTop]` moves it down, as the status bar does on some tablets). Every request the firmware would get is broadcast
 * as `{"type":"firmware-test",…}`, and the Bridge's status as usual.
 *
 * The overlay spans the screen, whose status bar is `[statusBar]` px high (for placing Obsidian's window by
 * its size, as the Bridge does when no event says where it is).
 *
 * Run: java -cp <unit test classpath> io.github.stefanmayer06.inkbridge.E2eServer [port] [overlayW] [overlayH] [guessY] [overlayTop] [statusBar]
 */
object E2eServer {
    @JvmStatic
    fun main(args: Array<String>) {
        val port = args.getOrNull(0)?.toInt() ?: ControlSocket.PORT
        val w = args.getOrNull(1)?.toInt() ?: 1520
        val h = args.getOrNull(2)?.toInt() ?: 2000
        val guessY = args.getOrNull(3)?.toFloat() ?: 40f
        val overlayTop = args.getOrNull(4)?.toInt() ?: 0
        val bars = ScreenBars(w, h + overlayTop, statusTop = args.getOrNull(5)?.toInt() ?: 0, navBottom = 0)
        val cal = Calibration(0f, guessY)
        var state: BridgeState? = null
        var lastClear: Long? = null
        var clears = 0
        val strokes = StrokeCheck()
        val lock = Object()
        lateinit var server: ControlSocket

        fun report() {
            val now = System.currentTimeMillis()
            val req = firmwareRequest(state, cal, w, h, now)
            fun arr(r: PxRect) = JSONArray(listOf(r.l, r.t, r.r, r.b))
            val o = JSONObject()
                .put("type", "firmware-test")
                .put("seq", state?.seq ?: 0)
                .put("armed", req != null)
                .put("calibrated", cal.calibrated)
                .put("fromWindow", cal.fromWindow)
                .put("source", cal.windowSource)
                .put("correction", JSONArray(listOf(cal.correctionX.toDouble(), cal.correctionY.toDouble())))
                .put("offset", JSONArray(listOf(cal.offsetX.toDouble(), cal.offsetY.toDouble())))
                .put("clears", clears)
                .put("ui", state?.ui ?: 0)
                .put("uiDone", state?.uiDone ?: JSONObject.NULL)
                .put("missed", strokes.missed)
                .put("win", state?.win?.let { JSONArray(listOf(it.x.toDouble(), it.y.toDouble())) } ?: JSONObject.NULL)
            if (req != null) {
                o.put("limit", arr(req.limit))
                o.put("exclude", JSONArray(req.exclude.map { arr(it) }))
                o.put("pen", JSONObject().put("style", req.pen.style).put("width", req.pen.width.toDouble()).put("color", req.pen.color))
                o.put("refreshMs", req.refreshMs)
                o.put("sideButton", req.sideButton)
                req.surface?.let { o.put("surface", arr(it)) }
            }
            server.send(o.toString())
            server.send(BridgeState.status(req != null, cal.calibrated, cal.offsetX, cal.offsetY, "socket", null, state?.seq ?: 0))
        }

        server = ControlSocket(
            port,
            onText = { text ->
                synchronized(lock) {
                    val raw = runCatching { JSONObject(text) }.getOrNull()
                    if (raw?.optString("type") == "raw-test") {
                        cal.recordRaw(raw.getDouble("x").toFloat(), raw.getDouble("y").toFloat(), raw.getLong("t"))
                        strokes.firmwareDown(raw.getLong("t"))
                    } else {
                        val s = BridgeState.parse(text)
                        if (s != null) {
                            state = s
                            // as the Bridge: placed from Obsidian's window when its events say where that is, else by its size
                            val win = s.win
                            val vp = s.vp
                            if (win != null) {
                                val (x, y) = windowOffset(win, s.dpr, 0, overlayTop)
                                cal.placeFromWindow(x, y, "events")
                            } else if (vp != null) {
                                windowFromViewport(vp, s.dpr, bars)?.let { (x, y) -> cal.placeFromWindow(x, y - overlayTop, "size") }
                            }
                            val req = firmwareRequest(s, cal, w, h, System.currentTimeMillis())
                            for (d in s.allDowns) {
                                if (!strokes.pluginDown(d)) continue
                                // only strokes the firmware should draw: while drawing, and (placed from the window) on the page
                                val (px, py) = cal.pointToPx(d.x, d.y, s.dpr)
                                val onPage = req != null && px >= req.limit.l + 2 && px < req.limit.r - 2 && py >= req.limit.t + 2 && py < req.limit.b - 2
                                if (req == null || (cal.fromWindow && !onPage)) strokes.forget(d)
                                cal.match(d, s.dpr)
                            }
                            if (lastClear != null && lastClear != s.clear) clears++
                            lastClear = s.clear
                            report()
                        }
                    }
                }
            },
            onClientsChanged = {},
        )
        server.start()
        // strokes the firmware did not report (as the Bridge's main thread checks them)
        Thread {
            while (true) {
                Thread.sleep(50)
                synchronized(lock) { if (strokes.check(System.currentTimeMillis()).isNotEmpty()) report() }
            }
        }.apply { isDaemon = true }.start()
        println("e2e bridge listening on 127.0.0.1:$port")
        System.out.flush()
        Thread.currentThread().join()
    }
}
