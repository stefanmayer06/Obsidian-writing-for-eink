package io.github.stefanmayer06.inkbridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * The messages between the Ink Notebook plugin and this app (protocol version 1).
 *
 * The plugin sends its whole state every time something changes and at least
 * every few seconds (the lease): where the ink page is on screen, the parts of it
 * covered by its own toolbars and cards, the selected pen, and until when all this
 * holds. The same message travels over the WebSocket or through the control file,
 * so "clear the fast ink" is a counter in the state rather than a separate message.
 *
 * Rectangles are CSS pixels relative to Obsidian's window; [dpr] converts them to
 * device pixels and [Calibration] adds where that window is on the screen – which
 * the plugin reports itself ([WindowGeom]), so nothing has to be measured.
 */
data class CssRect(val x: Float, val y: Float, val w: Float, val h: Float) {
    val isEmpty: Boolean get() = !(w > 0f && h > 0f)
}

/**
 * Where Obsidian's window is on the screen, as Obsidian reports it (CSS pixels): its top-left corner
 * (from its pen and finger events, which carry the screen position too), its size and the screen's.
 * A CSS pixel (cx, cy) is the screen pixel ((cx + x) × dpr, (cy + y) × dpr).
 */
data class WindowGeom(val x: Float, val y: Float, val w: Float, val h: Float, val sw: Float, val sh: Float)

/** A pen-down as the plugin saw it (CSS pixels, wall clock ms), to calibrate the position. */
data class PenDown(val x: Float, val y: Float, val t: Long)

/** The pen the firmware draws with: an Onyx stroke style, a width in device pixels, ARGB colour. */
data class PenSpec(val style: Int, val width: Float, val color: Int)

data class BridgeState(
    val seq: Long,
    val armed: Boolean,
    /** Wall clock ms until which this state holds (the plugin renews it while the page is open). */
    val until: Long,
    val dpr: Float,
    val region: CssRect?,
    val exclude: List<CssRect>,
    val pen: PenSpec,
    /** How long after lifting the pen the page shows the app's own drawing again. */
    val refreshMs: Int,
    /** The side button erases or selects in the plugin: the firmware must not draw ink while it is held. */
    val sideButtonErases: Boolean,
    /** Increased by the plugin when the last stroke was not ink (link tap, snapped shape, scribble erase). */
    val clear: Long,
    val down: PenDown?,
    /** Wall clock ms when the plugin sent this (0 from older plugins). */
    val at: Long = 0,
    /** Increased by the plugin when something other than the page is pressed (before that press changes anything). */
    val ui: Long = 0,
    /** The plugin's pen-downs of the last moments (each is sent the moment it happens; the control file keeps only the latest message). */
    val downs: List<PenDown> = emptyList(),
    /** The whole page (CSS pixels; [region] is its part on screen, where the pen writes ink). */
    val page: CssRect? = null,
    /** The ink view around the page: the pen hovering there is not away from the page. */
    val surface: CssRect? = null,
    /** Where Obsidian's window is on the screen (null: an older plugin, or no event has shown it yet). */
    val win: WindowGeom? = null,
    /** The presses (of [ui]) whose result this state includes (null: an older plugin, which does not say). */
    val uiDone: Long? = null,
) {
    /** Every pen-down this message reports. */
    val allDowns: List<PenDown> get() = if (down == null || downs.any { it.t == down.t }) downs else downs + down

    /** The firmware should draw now. */
    fun live(now: Long): Boolean = armed && until > now && region != null && !region.isEmpty

    /** The plugin still holds its lease (armed or not): its page is open, and it may arm at any moment. */
    fun leased(now: Long): Boolean = until > now

    /** The same request for the screen (the page, what covers it, the pen, the window); lease, counters and pen-down aside. */
    fun sameScreen(o: BridgeState?): Boolean =
        o != null && armed == o.armed && region == o.region && exclude == o.exclude && pen == o.pen && surface == o.surface && win == o.win

    companion object {
        const val VERSION = 1

        // TouchHelper.STROKE_STYLE_* (onyxsdk-pen)
        const val STYLE_PENCIL = 0
        const val STYLE_FOUNTAIN = 1
        const val STYLE_MARKER = 2
        const val STYLE_NEO_BRUSH = 3
        const val STYLE_CHARCOAL = 4
        const val STYLE_DASH = 5
        const val STYLE_CHARCOAL_V2 = 6

        fun styleOf(name: String?): Int = when (name) {
            "fountain" -> STYLE_FOUNTAIN
            "marker" -> STYLE_MARKER
            "brush" -> STYLE_NEO_BRUSH
            "charcoal" -> STYLE_CHARCOAL
            "dash" -> STYLE_DASH
            "charcoal2" -> STYLE_CHARCOAL_V2
            else -> STYLE_PENCIL
        }

        /** "#rrggbb" or "#aarrggbb" → ARGB; anything else is black. */
        fun colorOf(text: String?): Int {
            val hex = text?.removePrefix("#") ?: return BLACK
            val v = hex.toLongOrNull(16) ?: return BLACK
            return when (hex.length) {
                6 -> (0xFF000000L or v).toInt()
                8 -> v.toInt()
                else -> BLACK
            }
        }

        private const val BLACK = 0xFF000000.toInt()

        private fun rect(o: JSONObject?): CssRect? {
            if (o == null) return null
            val r = CssRect(
                o.optDouble("x", 0.0).toFloat(),
                o.optDouble("y", 0.0).toFloat(),
                o.optDouble("w", 0.0).toFloat(),
                o.optDouble("h", 0.0).toFloat(),
            )
            return if (r.x.isFinite() && r.y.isFinite() && r.w.isFinite() && r.h.isFinite()) r else null
        }

        private fun windowOf(o: JSONObject?): WindowGeom? {
            if (o == null || !o.has("x") || !o.has("y")) return null
            val w = WindowGeom(
                o.optDouble("x").toFloat(),
                o.optDouble("y").toFloat(),
                o.optDouble("w", 0.0).toFloat(),
                o.optDouble("h", 0.0).toFloat(),
                o.optDouble("sw", 0.0).toFloat(),
                o.optDouble("sh", 0.0).toFloat(),
            )
            val ok = listOf(w.x, w.y, w.w, w.h, w.sw, w.sh).all { it.isFinite() } && kotlin.math.abs(w.x) < 20_000 && kotlin.math.abs(w.y) < 20_000
            return if (ok) w else null
        }

        private fun downOf(o: JSONObject?): PenDown? {
            if (o == null || !o.has("t")) return null
            val d = PenDown(o.optDouble("x").toFloat(), o.optDouble("y").toFloat(), o.optLong("t"))
            return if (d.x.isFinite() && d.y.isFinite()) d else null
        }

        private fun downsOf(a: JSONArray?): List<PenDown> {
            if (a == null) return emptyList()
            return (0 until minOf(a.length(), 8)).mapNotNull { downOf(a.optJSONObject(it)) }
        }

        private fun rects(a: JSONArray?): List<CssRect> {
            if (a == null) return emptyList()
            val out = ArrayList<CssRect>(a.length())
            for (i in 0 until minOf(a.length(), 64)) rect(a.optJSONObject(i))?.let { if (!it.isEmpty) out.add(it) }
            return out
        }

        /** The state in a message, or null when it is not a state of a protocol version this app knows. */
        fun parse(text: String): BridgeState? = try {
            val o = JSONObject(text)
            if (o.optInt("v", 0) != VERSION || o.optString("type") != "state") {
                null
            } else {
                val pen = o.optJSONObject("pen")
                val down = o.optJSONObject("down")
                val dpr = o.optDouble("dpr", 1.0).toFloat()
                BridgeState(
                    seq = o.optLong("seq", 0),
                    armed = o.optBoolean("armed", false),
                    until = o.optLong("until", 0),
                    dpr = if (dpr.isFinite() && dpr in 0.5f..6f) dpr else 1f,
                    region = rect(o.optJSONObject("region")),
                    exclude = rects(o.optJSONArray("exclude")),
                    pen = PenSpec(
                        style = styleOf(pen?.optString("style")),
                        width = (pen?.optDouble("width", 3.0) ?: 3.0).toFloat().coerceIn(0.5f, 200f),
                        color = colorOf(pen?.optString("color")),
                    ),
                    refreshMs = o.optInt("refreshMs", 800).coerceIn(100, 10_000),
                    sideButtonErases = o.optBoolean("sideButtonErases", true),
                    clear = o.optLong("clear", 0),
                    down = down?.let { PenDown(it.optDouble("x").toFloat(), it.optDouble("y").toFloat(), it.optLong("t")) },
                    at = o.optLong("at", 0),
                    ui = o.optLong("ui", 0),
                    downs = downsOf(o.optJSONArray("downs")),
                    page = rect(o.optJSONObject("page"))?.takeIf { !it.isEmpty },
                    surface = rect(o.optJSONObject("surface"))?.takeIf { !it.isEmpty },
                    win = windowOf(o.optJSONObject("win")),
                    uiDone = if (o.has("uiDone")) o.optLong("uiDone", 0) else null,
                )
            }
        } catch (e: Exception) {
            null
        }

        /** What this app tells the plugin (over the socket, and in status.json next to the control file). */
        fun status(
            armed: Boolean,
            calibrated: Boolean,
            offsetX: Float,
            offsetY: Float,
            transport: String,
            error: String?,
            seq: Long,
            penHovers: Int = 0,
            penStrokes: Int = 0,
            /** Why the firmware is paused although armed (the pen is over a toolbar, …), or null. */
            paused: String? = null,
            /** Strokes the firmware did not draw (the plugin recorded them, the firmware's pen reader did not report them). */
            missed: Int = 0,
            lastMissed: PenDown? = null,
            /** The firmware's drawing area in words (for the plugin's settings). */
            area: String? = null,
            /** How the page was placed on screen, in words (from Obsidian's window, measured, guessed). */
            placement: String? = null,
            /** Strokes during which the firmware was kept off because the pen was already down when it was to switch on. */
            lateSwitchOns: Int = 0,
        ): String = JSONObject()
            .put("v", VERSION)
            .put("type", "status")
            .put("app", BuildConfigInfo.VERSION_NAME)
            .put("at", System.currentTimeMillis())
            .put("armed", armed)
            .put("calibrated", calibrated)
            .put("offset", JSONObject().put("x", offsetX.toDouble()).put("y", offsetY.toDouble()))
            .put("transport", transport)
            .put("seq", seq)
            .put("penHovers", penHovers)
            .put("penStrokes", penStrokes)
            .apply { if (error != null) put("error", error) }
            .apply { if (armed && paused != null) put("paused", paused) }
            .put("missed", missed)
            .apply { if (lastMissed != null) put("lastMissed", JSONObject().put("x", lastMissed.x.toDouble()).put("y", lastMissed.y.toDouble())) }
            .apply { if (area != null) put("area", area) }
            .apply { if (placement != null) put("placement", placement) }
            .put("lateSwitchOns", lateSwitchOns)
            .toString()
    }
}

/** The app version without depending on generated BuildConfig in unit tests. */
object BuildConfigInfo {
    const val VERSION_NAME = "0.10.0"
}
