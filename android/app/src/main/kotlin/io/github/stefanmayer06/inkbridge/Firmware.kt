package io.github.stefanmayer06.inkbridge

/** A rectangle in overlay (device) pixels. */
data class PxRect(val l: Int, val t: Int, val r: Int, val b: Int) {
    val isEmpty: Boolean get() = r <= l || b <= t
    fun intersects(o: PxRect) = l < o.r && o.l < r && t < o.b && o.t < b
    fun contains(x: Float, y: Float, margin: Int = 0) = x >= l - margin && x < r + margin && y >= t - margin && y < b + margin
}

/** Pixels around the page where the pen counts as still over it (writing near the edge). */
const val EDGE_PX = 24

/** What the pen hovers over, for [InkGate]: the page, its edge, or something else (a toolbar, a card, Obsidian). */
fun zoneOf(x: Float, y: Float, r: FirmwareRequest): InkGate.Zone = when {
    r.exclude.any { it.contains(x, y) } -> InkGate.Zone.AWAY
    r.limit.contains(x, y) -> InkGate.Zone.PAGE
    r.limit.contains(x, y, EDGE_PX) -> InkGate.Zone.EDGE
    else -> InkGate.Zone.AWAY
}

/** What the firmware is asked to do: draw inside [limit] but not in [exclude], with [pen]. */
data class FirmwareRequest(
    val limit: PxRect,
    val exclude: List<PxRect>,
    val pen: PenSpec,
    val refreshMs: Int,
    val sideButton: Boolean,
)

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
    return FirmwareRequest(limit, exclude, state.pen, state.refreshMs, state.sideButtonErases)
}
