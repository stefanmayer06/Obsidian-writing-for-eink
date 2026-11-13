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
 * pen-down in screen pixels. Every request the firmware would get is broadcast
 * as `{"type":"firmware-test",…}`, and the Bridge's status as usual.
 *
 * Run: java -cp <unit test classpath> io.github.stefanmayer06.inkbridge.E2eServer [port] [overlayW] [overlayH] [guessY]
 */
object E2eServer {
    @JvmStatic
    fun main(args: Array<String>) {
        val port = args.getOrNull(0)?.toInt() ?: ControlSocket.PORT
        val w = args.getOrNull(1)?.toInt() ?: 1520
        val h = args.getOrNull(2)?.toInt() ?: 2000
        val guessY = args.getOrNull(3)?.toFloat() ?: 40f
        val cal = Calibration(0f, guessY)
        var state: BridgeState? = null
        var lastClear: Long? = null
        var clears = 0
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
                .put("offset", JSONArray(listOf(cal.offsetX.toDouble(), cal.offsetY.toDouble())))
                .put("clears", clears)
                .put("ui", state?.ui ?: 0)
            if (req != null) {
                o.put("limit", arr(req.limit))
                o.put("exclude", JSONArray(req.exclude.map { arr(it) }))
                o.put("pen", JSONObject().put("style", req.pen.style).put("width", req.pen.width.toDouble()).put("color", req.pen.color))
                o.put("refreshMs", req.refreshMs)
                o.put("sideButton", req.sideButton)
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
                    } else {
                        val s = BridgeState.parse(text)
                        if (s != null) {
                            state = s
                            s.down?.let { cal.match(it, s.dpr) }
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
        println("e2e bridge listening on 127.0.0.1:$port")
        System.out.flush()
        Thread.currentThread().join()
    }
}
