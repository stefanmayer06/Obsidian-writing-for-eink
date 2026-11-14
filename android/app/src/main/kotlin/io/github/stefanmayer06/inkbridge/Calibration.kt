package io.github.stefanmayer06.inkbridge

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * Where Obsidian's page is in the overlay's coordinates.
 *
 * The plugin knows its rectangles in CSS pixels of Obsidian's window; the
 * firmware wants pixels of the overlay that covers the screen. Per axis,
 * overlay = css × scale + offset. The scale is normally the device pixel ratio
 * the plugin sends, and the offset where Obsidian's window starts (the status
 * bar), but neither can be trusted blindly: Boox can give each app its own DPI,
 * and split screen moves the window. So both are measured from pen-downs: the
 * firmware reports each pen-down in overlay pixels, the plugin reports the same
 * pen-down in CSS pixels. With one press the offset is measured (scale = ratio);
 * with presses spread over the page, scale and offset are fitted per axis
 * (least squares), and the fit is used only when the presses agree with it.
 * Until then the first guess holds.
 *
 * That measuring is only for plugins that do not say where their window is.
 * Newer ones do ([placeFromWindow]): every pen and finger event in Obsidian
 * carries its screen position too, so the plugin knows where its window starts
 * and the placement follows exactly – the scale is the device pixel ratio, the
 * offset the window's position less the overlay's. Pen-downs then only check it:
 * if the firmware's pen-downs are all shifted by the same amount (its pixels
 * count from somewhere other than the overlay's corner), that shift is taken
 * over once and kept; nothing is fitted, and nothing changes stroke by stroke.
 */
class Calibration(private var guessX: Float = 0f, private var guessY: Float = 0f) {
    private data class Raw(val x: Float, val y: Float, val t: Long)
    private data class Press(val cx: Float, val cy: Float, val rx: Float, val ry: Float)

    private val raw = ArrayDeque<Raw>()
    private val pairs = ArrayDeque<Press>()
    private var lastMatched = Long.MIN_VALUE

    var offsetX = guessX
        private set
    var offsetY = guessY
        private set
    /** Overlay pixels per CSS pixel, when measured (null: the device pixel ratio). */
    var scaleX: Float? = null
        private set
    var scaleY: Float? = null
        private set
    var calibrated = false
        private set

    /** Placed from Obsidian's own report of where its window is ([placeFromWindow]); pen-downs only check it. */
    var fromWindow = false
        private set
    /** What told where the window is: "events" (its pen and finger events) or "size" (its size and the screen's bars). */
    var windowSource = ""
        private set
    /** A constant shift the firmware's pen-downs showed against Obsidian's report (kept per screen size). */
    var correctionX = 0f
        private set
    var correctionY = 0f
        private set
    /** How far the firmware's recent pen-downs were from where the placement puts them (px, median), or null. */
    var checkedOff: kotlin.Pair<Float, Float>? = null
        private set
    private val checks = ArrayDeque<kotlin.Pair<Float, Float>>()

    /** Start again (the screen turned, the overlay changed size, or asked from the app). */
    fun reset(guessX: Float = this.guessX, guessY: Float = this.guessY) {
        this.guessX = guessX
        this.guessY = guessY
        raw.clear()
        pairs.clear()
        offsetX = guessX
        offsetY = guessY
        scaleX = null
        scaleY = null
        calibrated = false
        lastMatched = Long.MIN_VALUE
        fromWindow = false
        correctionX = 0f
        correctionY = 0f
        checks.clear()
        checkedOff = null
    }

    /**
     * Obsidian said where its window is: the offset is [baseX], [baseY] (the window's corner in overlay
     * pixels) plus a shift the firmware's pen-downs showed before, and the scale is the device pixel
     * ratio. True when the placement changed.
     */
    fun placeFromWindow(baseX: Float, baseY: Float, source: String = "events"): Boolean {
        val x = baseX + correctionX
        val y = baseY + correctionY
        windowSource = source
        val changed = !fromWindow || abs(x - offsetX) > 0.25f || abs(y - offsetY) > 0.25f || scaleX != null || scaleY != null
        if (!fromWindow) {
            checks.clear()
            checkedOff = null
        }
        fromWindow = true
        calibrated = true
        offsetX = x
        offsetY = y
        scaleX = null
        scaleY = null
        return changed
    }

    /** A shift measured before at this screen size (see [placeFromWindow]). */
    fun restoreCorrection(x: Float, y: Float) {
        if (fromWindow) {
            offsetX += x - correctionX
            offsetY += y - correctionY
        }
        correctionX = x
        correctionY = y
    }

    /** Use a stored measurement (made before at this screen size). */
    fun restore(x: Float, y: Float, sx: Float? = null, sy: Float? = null) {
        offsetX = x
        offsetY = y
        scaleX = sx
        scaleY = sy
        calibrated = true
    }

    /** The firmware reported a pen-down (overlay pixels, wall clock ms). */
    fun recordRaw(x: Float, y: Float, t: Long) {
        raw.addLast(Raw(x, y, t))
        while (raw.size > MAX_RAW) raw.removeFirst()
    }

    /**
     * The plugin reported a pen-down. Returns true when the placement changed (the
     * rectangles have to be sent to the firmware again). Only a press the firmware
     * reported once at that moment counts: with two, which is which is a guess.
     */
    fun match(down: PenDown, dpr: Float): Boolean {
        if (down.t == lastMatched) return false
        val near = raw.filter { abs(it.t - down.t) <= MAX_SKEW_MS }
        if (near.size != 1) return false
        val best = near[0]
        lastMatched = down.t
        val p = Press(down.x, down.y, best.x, best.y)
        if (fromWindow) return check(p, dpr)
        // not the same press (or a wildly wrong one): with the current placement it would be far off
        val ex = abs(p.rx - (p.cx * (scaleX ?: dpr) + offsetX))
        val ey = abs(p.ry - (p.cy * (scaleY ?: dpr) + offsetY))
        if (calibrated && (ex > MAX_JUMP || ey > MAX_JUMP) && pairs.size >= 3) return false
        if (!calibrated && (abs(p.rx - p.cx * dpr - guessX) > MAX_OFFSET || abs(p.ry - p.cy * dpr - guessY) > MAX_OFFSET)) return false
        pairs.addLast(p)
        while (pairs.size > MAX_PAIRS) pairs.removeFirst()
        return refit(dpr)
    }

    /**
     * Obsidian placed the page; a pen-down only checks the placement. When the last few pen-downs are
     * all off by the same amount (within a few pixels of each other), that is a constant shift between
     * the firmware's pixels and the overlay's: it is taken over once. True when that changed the placement.
     */
    private fun check(p: Press, dpr: Float): Boolean {
        val ex = p.rx - (p.cx * dpr + offsetX)
        val ey = p.ry - (p.cy * dpr + offsetY)
        if (abs(ex) > MAX_OFFSET || abs(ey) > MAX_OFFSET) return false
        checks.addLast(kotlin.Pair(ex, ey))
        while (checks.size > CHECKS_KEPT) checks.removeFirst()
        checkedOff = kotlin.Pair(median(checks.map { it.first }), median(checks.map { it.second }))
        if (checks.size < CHECKS_AGREE) return false
        val last = checks.toList().takeLast(CHECKS_AGREE)
        val xs = last.map { it.first }
        val ys = last.map { it.second }
        if (xs.max() - xs.min() > CHECK_SPREAD || ys.max() - ys.min() > CHECK_SPREAD) return false
        val dx = median(xs).takeIf { abs(it) > CHECK_TOLERANCE } ?: 0f
        val dy = median(ys).takeIf { abs(it) > CHECK_TOLERANCE } ?: 0f
        if (dx == 0f && dy == 0f) return false
        correctionX += dx
        correctionY += dy
        offsetX += dx
        offsetY += dy
        checks.clear()
        checkedOff = null
        return true
    }

    private fun refit(dpr: Float): Boolean {
        val fx = fit(pairs.map { it.cx }, pairs.map { it.rx }, dpr)
        val fy = fit(pairs.map { it.cy }, pairs.map { it.ry }, dpr)
        val changed = !calibrated ||
            abs(fx.second - offsetX) > MIN_CHANGE || abs(fy.second - offsetY) > MIN_CHANGE ||
            abs((fx.first ?: dpr) - (scaleX ?: dpr)) > 0.005f || abs((fy.first ?: dpr) - (scaleY ?: dpr)) > 0.005f
        scaleX = fx.first
        offsetX = fx.second
        scaleY = fy.first
        offsetY = fy.second
        calibrated = true
        return changed
    }

    /**
     * A stroke where the firmware should have drawn was not drawn: a measured scale is not trusted
     * any more (the device pixel ratio is used, and the offset is measured again from the presses).
     * True when that changed the placement.
     */
    fun distrustScale(dpr: Float): Boolean {
        if (fromWindow || (scaleX == null && scaleY == null)) return false
        scaleX = null
        scaleY = null
        if (pairs.isNotEmpty()) {
            offsetX = median(pairs.map { it.rx - it.cx * dpr })
            offsetY = median(pairs.map { it.ry - it.cy * dpr })
        }
        return true
    }

    /** A CSS point in overlay pixels. */
    fun pointToPx(x: Float, y: Float, dpr: Float): kotlin.Pair<Float, Float> = kotlin.Pair(x * (scaleX ?: dpr) + offsetX, y * (scaleY ?: dpr) + offsetY)

    /** CSS pixels in overlay pixels as [left, top, right, bottom]; `grow` rounds outwards and adds a margin. */
    fun toPx(r: CssRect, dpr: Float, grow: Boolean): IntArray {
        val sx = scaleX ?: dpr
        val sy = scaleY ?: dpr
        val l = r.x * sx + offsetX
        val t = r.y * sy + offsetY
        val rr = (r.x + r.w) * sx + offsetX
        val b = (r.y + r.h) * sy + offsetY
        return if (grow) {
            intArrayOf(floor(l - MARGIN).toInt(), floor(t - MARGIN).toInt(), ceil(rr + MARGIN).toInt(), ceil(b + MARGIN).toInt())
        } else {
            intArrayOf(ceil(l).toInt(), ceil(t).toInt(), floor(rr).toInt(), floor(b).toInt())
        }
    }

    companion object {
        private const val MAX_RAW = 64
        private const val MAX_PAIRS = 12
        private const val MAX_SKEW_MS = 200L
        /** The first press may be this far from the guess (split screen moves the window a lot). */
        private const val MAX_OFFSET = 1400f
        /** Later presses this far from the fit are another press, not a new measurement. */
        private const val MAX_JUMP = 60f
        private const val MIN_CHANGE = 1.5f
        /** CSS pixels the presses must be spread over before the scale is measured (a scale from a small cluster is a guess far from it). */
        private const val MIN_SPREAD = 300f
        /** The fitted scale must be this close to the device pixel ratio (factor) and fit the presses this well (px). */
        private const val SCALE_RANGE = 1.25f
        private const val MAX_RESIDUAL = 12f

        /** Device pixels added around parts left out of the drawing area. */
        const val MARGIN = 4f

        /** Pen-downs kept to check a placement from Obsidian's window, and how many must agree on a shift. */
        private const val CHECKS_KEPT = 8
        private const val CHECKS_AGREE = 3
        /** They agree when within this many pixels of each other … */
        private const val CHECK_SPREAD = 6f
        /** … and a shift is taken over only when larger than this (the pen's own scatter is smaller). */
        private const val CHECK_TOLERANCE = 6f

        private fun median(values: List<Float>): Float {
            val s = values.sorted()
            val n = s.size
            return if (n % 2 == 1) s[n / 2] else (s[n / 2 - 1] + s[n / 2]) / 2f
        }

        /**
         * raw = css × scale + offset for one axis: (measured scale or null, offset). The scale is
         * measured only from presses spread over the page that it fits well; otherwise the device
         * pixel ratio is used and the offset is the median.
         */
        internal fun fit(css: List<Float>, rawPx: List<Float>, dpr: Float): kotlin.Pair<Float?, Float> {
            val n = css.size
            val offsetAtDpr = median(css.indices.map { rawPx[it] - css[it] * dpr })
            if (n < 3 || (css.maxOrNull()!! - css.minOrNull()!!) < MIN_SPREAD) return kotlin.Pair(null, offsetAtDpr)
            val mx = css.average().toFloat()
            val my = rawPx.average().toFloat()
            var sxy = 0f
            var sxx = 0f
            for (i in 0 until n) {
                sxy += (css[i] - mx) * (rawPx[i] - my)
                sxx += (css[i] - mx) * (css[i] - mx)
            }
            if (sxx <= 0f) return kotlin.Pair(null, offsetAtDpr)
            val scale = sxy / sxx
            val offset = my - scale * mx
            if (scale < dpr / SCALE_RANGE || scale > dpr * SCALE_RANGE) return kotlin.Pair(null, offsetAtDpr)
            var ss = 0f
            for (i in 0 until n) {
                val e = rawPx[i] - (css[i] * scale + offset)
                ss += e * e
            }
            if (sqrt(ss / n) > MAX_RESIDUAL) return kotlin.Pair(null, offsetAtDpr)
            // the ratio fits as well as the measured scale: keep it (no needless change)
            if (abs(scale - dpr) < 0.01f * dpr) return kotlin.Pair(null, offsetAtDpr)
            return kotlin.Pair(scale, offset)
        }
    }
}
