package io.github.stefanmayer06.inkbridge

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor

/**
 * Where Obsidian's page is in the overlay's coordinates.
 *
 * The plugin knows its rectangles in CSS pixels of Obsidian's window; the
 * firmware wants pixels of the overlay that covers the screen. The two differ by
 * the device pixel ratio and by where Obsidian's window starts (status bar,
 * split screen). The ratio comes with every message; the offset starts as a
 * guess (the status bar) and is measured from pen-downs: the firmware reports
 * each pen-down in overlay pixels, the plugin reports the same pen-down in CSS
 * pixels, and the difference is the offset. The median of the last few presses
 * is used, so one mismatched press does not move the page.
 */
class Calibration(private var guessX: Float = 0f, private var guessY: Float = 0f) {
    private data class Raw(val x: Float, val y: Float, val t: Long)

    private val raw = ArrayDeque<Raw>()
    private val samplesX = ArrayDeque<Float>()
    private val samplesY = ArrayDeque<Float>()
    private var lastMatched = Long.MIN_VALUE

    var offsetX = guessX
        private set
    var offsetY = guessY
        private set
    var calibrated = false
        private set

    /** Start again (the screen turned, the overlay changed size). */
    fun reset(guessX: Float = this.guessX, guessY: Float = this.guessY) {
        this.guessX = guessX
        this.guessY = guessY
        raw.clear()
        samplesX.clear()
        samplesY.clear()
        offsetX = guessX
        offsetY = guessY
        calibrated = false
        lastMatched = Long.MIN_VALUE
    }

    /** Use a stored offset (measured before at this screen size). */
    fun restore(x: Float, y: Float) {
        offsetX = x
        offsetY = y
        calibrated = true
    }

    /** The firmware reported a pen-down (overlay pixels, wall clock ms). */
    fun recordRaw(x: Float, y: Float, t: Long) {
        raw.addLast(Raw(x, y, t))
        while (raw.size > MAX_RAW) raw.removeFirst()
    }

    /**
     * The plugin reported a pen-down. Returns true when the offset changed (the
     * rectangles have to be sent to the firmware again).
     */
    fun match(down: PenDown, dpr: Float): Boolean {
        if (down.t == lastMatched) return false
        val best = raw.minByOrNull { abs(it.t - down.t) } ?: return false
        if (abs(best.t - down.t) > MAX_SKEW_MS) return false
        lastMatched = down.t
        val ox = best.x - down.x * dpr
        val oy = best.y - down.y * dpr
        // not the same press (or a wildly wrong one): the window never moves that far
        if (abs(ox) > MAX_OFFSET || abs(oy) > MAX_OFFSET) return false
        samplesX.addLast(ox)
        samplesY.addLast(oy)
        while (samplesX.size > MAX_SAMPLES) samplesX.removeFirst()
        while (samplesY.size > MAX_SAMPLES) samplesY.removeFirst()
        val nx = median(samplesX)
        val ny = median(samplesY)
        val changed = !calibrated || abs(nx - offsetX) > MIN_CHANGE || abs(ny - offsetY) > MIN_CHANGE
        offsetX = nx
        offsetY = ny
        calibrated = true
        return changed
    }

    /**
     * A CSS rectangle in overlay pixels as [left, top, right, bottom]. `grow`
     * rounds outwards and adds a margin (parts left out of the drawing area),
     * otherwise inwards (the drawing area itself).
     */
    fun toPx(r: CssRect, dpr: Float, grow: Boolean): IntArray {
        val l = r.x * dpr + offsetX
        val t = r.y * dpr + offsetY
        val rr = (r.x + r.w) * dpr + offsetX
        val b = (r.y + r.h) * dpr + offsetY
        return if (grow) {
            intArrayOf(floor(l - MARGIN).toInt(), floor(t - MARGIN).toInt(), ceil(rr + MARGIN).toInt(), ceil(b + MARGIN).toInt())
        } else {
            intArrayOf(ceil(l).toInt(), ceil(t).toInt(), floor(rr).toInt(), floor(b).toInt())
        }
    }

    companion object {
        private const val MAX_RAW = 16
        private const val MAX_SAMPLES = 5
        private const val MAX_SKEW_MS = 400L
        private const val MAX_OFFSET = 600f
        private const val MIN_CHANGE = 1.5f

        /** Device pixels added around parts left out of the drawing area. */
        const val MARGIN = 4f

        private fun median(values: Collection<Float>): Float {
            val s = values.sorted()
            val n = s.size
            return if (n % 2 == 1) s[n / 2] else (s[n / 2 - 1] + s[n / 2]) / 2f
        }
    }
}
