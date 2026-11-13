package io.github.stefanmayer06.inkbridge

import kotlin.math.abs

/**
 * Did the firmware draw the strokes the plugin records?
 *
 * The plugin reports each pen-down the moment it happens; the firmware's pen
 * reader reports the pen-downs it draws. A pen-down of the plugin's with none of
 * the firmware's at the same moment is a stroke the firmware is not drawing
 * (the pen is outside the firmware's drawing area, which can be placed slightly
 * wrong, or over something left out of it). The firmware then has to pause at
 * once: while it is in its drawing mode the panel does not show Obsidian's own
 * drawing of the stroke either, and the stroke would stay invisible until the
 * next tool change or page turn.
 */
class StrokeCheck(
    /** The firmware's and the plugin's pen-down of the same press are this close in time (same clock, different paths). */
    private val windowMs: Long = 250,
    /** How long after the plugin's pen-down the firmware's may still come in (its report waits for the main thread). */
    private val waitMs: Long = 150,
) {
    private val firmware = ArrayDeque<Long>()
    private val pending = ArrayDeque<PenDown>()
    private val handled = ArrayDeque<Long>()

    /** Strokes the firmware did not draw, since the Bridge started. */
    var missed = 0
        private set
    var lastMissed: PenDown? = null
        private set

    /** The firmware's pen reader reported a pen-down (it draws this stroke). */
    fun firmwareDown(t: Long) {
        firmware.addLast(t)
        while (firmware.size > MAX_KEPT) firmware.removeFirst()
    }

    /** The plugin reported a pen-down. False when it was reported before (it comes with later messages too). */
    fun pluginDown(d: PenDown): Boolean {
        if (d.t in handled || pending.any { it.t == d.t }) return false
        handled.addLast(d.t)
        while (handled.size > MAX_KEPT) handled.removeFirst()
        pending.addLast(d)
        return true
    }

    /** Not a stroke to check after all (the firmware was paused then). */
    fun forget(d: PenDown) {
        pending.removeAll { it.t == d.t }
    }

    /** The plugin's pen-downs the firmware did not draw, decided now. */
    fun check(now: Long): List<PenDown> {
        val out = ArrayList<PenDown>()
        val iter = pending.iterator()
        while (iter.hasNext()) {
            val d = iter.next()
            when {
                firmware.any { f -> abs(f - d.t) <= windowMs } -> iter.remove()
                now >= d.t + waitMs -> {
                    iter.remove()
                    missed++
                    lastMissed = d
                    out.add(d)
                }
            }
        }
        return out
    }

    /** When to check again (null: nothing waits). */
    fun nextCheckAt(): Long? = pending.minOfOrNull { it.t + waitMs }

    companion object {
        private const val MAX_KEPT = 32
    }
}
