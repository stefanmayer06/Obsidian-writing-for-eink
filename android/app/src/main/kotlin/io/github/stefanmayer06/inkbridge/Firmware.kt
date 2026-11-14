package io.github.stefanmayer06.inkbridge

/** A rectangle in overlay (device) pixels. */
data class PxRect(val l: Int, val t: Int, val r: Int, val b: Int) {
    val isEmpty: Boolean get() = r <= l || b <= t
    fun intersects(o: PxRect) = l < o.r && o.l < r && t < o.b && o.t < b
    fun contains(x: Float, y: Float, margin: Int = 0) = x >= l - margin && x < r + margin && y >= t - margin && y < b + margin
}

/** Pixels around the page where the pen counts as still over it (writing near the edge). */
const val EDGE_PX = 24

/**
 * What the pen hovers over, for [InkGate]: the page, next to it (its edge, or the ink view around
 * it, which the plugin says is not a toolbar), or something else (a toolbar, a card, Obsidian).
 */
fun zoneOf(x: Float, y: Float, r: FirmwareRequest): InkGate.Zone = when {
    r.exclude.any { it.contains(x, y) } -> InkGate.Zone.AWAY
    r.limit.contains(x, y) -> InkGate.Zone.PAGE
    r.limit.contains(x, y, EDGE_PX) -> InkGate.Zone.EDGE
    r.surface?.contains(x, y) == true -> InkGate.Zone.EDGE
    else -> InkGate.Zone.AWAY
}

/**
 * What the firmware is asked to do: draw inside [limit] (the page, where ink stays) but not in
 * [exclude], with [pen]. [surface] is the ink view around the page (null from older plugins), and
 * [page] the page's part on screen as it is, before it was cut to the overlay (where the pen writes ink,
 * whether the firmware can draw there or not).
 */
data class FirmwareRequest(
    val limit: PxRect,
    val exclude: List<PxRect>,
    val pen: PenSpec,
    val refreshMs: Int,
    val sideButton: Boolean,
    val surface: PxRect? = null,
    val page: PxRect = limit,
)

/**
 * Where Obsidian's window starts in the overlay's pixels, from the plugin's report ([WindowGeom], CSS
 * pixels on the screen) and where the overlay starts on the screen.
 */
fun windowOffset(win: WindowGeom, dpr: Float, overlayLeft: Int, overlayTop: Int): kotlin.Pair<Float, Float> =
    kotlin.Pair(win.x * dpr - overlayLeft, win.y * dpr - overlayTop)

/** The screen and its system bars, in device pixels (what the Bridge's own full-screen window is told). */
data class ScreenBars(val w: Int, val h: Int, val statusTop: Int, val navBottom: Int, val navLeft: Int = 0, val navRight: Int = 0)

/**
 * Where Obsidian's window starts on the screen (device pixels), from its size alone – for when no
 * event has said so. A full-screen app's window spans the screen, less the status bar or not, less the
 * navigation bar or not: the one combination its size fits is where it is. When two fit (bars of the
 * same height), the safe area says whether Obsidian draws under the status bar. Null when its size
 * fits none (split screen, a floating window): then the place is not known this way.
 */
fun windowFromViewport(vp: ViewportGeom, dpr: Float, bars: ScreenBars): kotlin.Pair<Float, Float>? {
    val w = vp.w * dpr
    val h = vp.h * dpr
    // the size is whole CSS pixels (innerWidth/innerHeight): up to a device pixel ratio off, and a little more
    val tol = 2f * dpr + 2f
    fun fitting(starts: List<Int>, ends: List<Int>, size: Float): List<Int> =
        starts.distinct().flatMap { a -> ends.distinct().filter { b -> kotlin.math.abs((b - a) - size) <= tol }.map { a } }.distinct()
    val lefts = fitting(listOf(0, bars.navLeft), listOf(bars.w, bars.w - bars.navRight), w)
    val tops = fitting(listOf(0, bars.statusTop), listOf(bars.h, bars.h - bars.navBottom), h)
    if (lefts.isEmpty() || tops.isEmpty()) return null
    val left = lefts.min()
    val top = when {
        tops.size == 1 -> tops[0]
        vp.top > 0f -> 0
        else -> tops.max()
    }
    return kotlin.Pair(left.toFloat(), top.toFloat())
}

/**
 * The firmware request for the plugin's state, or null when the firmware should
 * not draw at all (no state, the lease ran out, the pen tool is not selected, the
 * page is off the overlay).
 */
fun firmwareRequest(state: BridgeState?, calibration: Calibration, overlayW: Int, overlayH: Int, now: Long): FirmwareRequest? {
    val region = state?.region
    if (state == null || region == null || !state.live(now) || overlayW <= 0 || overlayH <= 0) return null
    val lim = calibration.toPx(region, state.dpr, grow = false)
    val limit = PxRect(lim[0].coerceIn(0, overlayW), lim[1].coerceIn(0, overlayH), lim[2].coerceIn(0, overlayW), lim[3].coerceIn(0, overlayH))
    if (limit.isEmpty) return null
    val exclude = state.exclude
        .map { calibration.toPx(it, state.dpr, grow = true) }
        .map { PxRect(it[0], it[1], it[2], it[3]) }
        .filter { it.intersects(limit) }
    val surface = state.surface?.let { calibration.toPx(it, state.dpr, grow = true) }?.let { PxRect(it[0], it[1], it[2], it[3]) }
    return FirmwareRequest(limit, exclude, state.pen, state.refreshMs, state.sideButtonErases, surface, PxRect(lim[0], lim[1], lim[2], lim[3]))
}
