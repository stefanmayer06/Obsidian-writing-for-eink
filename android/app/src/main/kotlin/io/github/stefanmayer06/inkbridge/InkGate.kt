package io.github.stefanmayer06.inkbridge

/**
 * When the firmware may draw ink, moment by moment.
 *
 * While the Boox firmware draws (its pen state is "drawing"), the panel is in
 * its handwriting mode and does not keep up with Obsidian's own screen: a
 * toolbar button, a pen card or a new page shows late, or only once the firmware
 * stops drawing. So the firmware draws only while the pen is over the ink page,
 * and stops (the panel shows Obsidian again, at its normal speed) whenever
 * anything else happens:
 *
 * - the pen hovers over a toolbar, a card or anything else that is not the page,
 * - the user presses something that is not the page (the plugin says so at once),
 * - the plugin's toolbars, cards or pen changed,
 * - the page changed (page turn, undo, erasing, a stroke that was not ink),
 * - instant ink was just turned on.
 *
 * It draws again as soon as the pen hovers over the page – always before the pen
 * touches it, so no stroke is missed. After a visit to a toolbar (or a press on
 * one) it first waits a moment for the plugin's word on what was chosen, so that
 * the old pen does not draw after the eraser was picked. Newer plugins say which
 * presses their state includes, so after a press the wait ends exactly when the
 * result arrives.
 *
 * The page itself, and the ink view around it, never stop it: the pen moving
 * there, writing or hovering, keeps the firmware drawing.
 */
class InkGate(
    /** The pen must hover over something that is not the page this long before the firmware stops (a quick pass is not a visit). */
    private val awayDwellMs: Long = 60,
    /**
     * After the pen left a toolbar, wait this long for the plugin's state (unless it came sooner). A press
     * there is sent the moment it starts, and is on its way long before the pen is back over the page:
     * this only covers a slow write of the control file.
     */
    private val awayGraceMs: Long = 150,
    /** After a press on a toolbar, wait this long from the press for the plugin's state (unless it came sooner). */
    private val pressGraceMs: Long = 400,
) {
    enum class Zone {
        /** Over the page, where the firmware draws. */
        PAGE,
        /** Next to the page – its edge, or the ink view around it: no change (writing near the edge must not stop the ink). */
        EDGE,
        /** Over something else: a toolbar, a card, Obsidian. */
        AWAY,
    }

    private var armed = false
    private var held = true
    private var drawing = false
    /** A stop that waits for the pen to lift (the firmware's ink is not cut off mid-stroke). */
    private var heldAtPenUp: String? = null
    /** The pen hovers over something that is not the page since then (-1: it does not). */
    private var awayFrom = -1L
    /** Waiting for the plugin's word until then (0: not waiting) … */
    private var waitUntil = 0L
    /** … which a state it sent after this ends … */
    private var waitFrom = 0L
    /** … or, from plugins that say so, a state that includes this press (0: none awaited). */
    private var waitUi = 0L

    /** Why the firmware does not draw now, in words (null when it draws). */
    var reason: String? = "off"
        private set

    /** The firmware should draw now. */
    val draws: Boolean get() = armed && !held

    /** Instant ink was turned on: it draws from the first hover over the page. */
    fun arm() {
        if (armed) return
        armed = true
        hold("waiting for the pen over the page")
    }

    fun disarm() {
        armed = false
        held = true
        reason = "off"
        heldAtPenUp = null
        drawing = false
        awayFrom = -1
        waitUntil = 0
        waitUi = 0
    }

    /** The plugin's toolbars, cards or pen changed: the panel shows that first. */
    fun changed() = holdSoon("the page's toolbars changed")

    /** The page changed under the firmware's ink (it shows the page again), even mid-stroke (a stroke snapped to a shape). */
    fun cleared() = hold("the page changed")

    /**
     * The pen writes where the firmware does not draw: pause at once, mid-stroke, so the panel shows
     * Obsidian's own drawing of the stroke (it would stay invisible until the next pause).
     */
    fun missed() = hold("the pen wrote where the firmware does not draw")

    /**
     * Something other than the page was pressed (the plugin reports it at once, before it changes
     * anything): stop, and wait for what the press changes. [ui] is the press's number and [uiDone] the
     * presses the same message already includes (null: an older plugin, which does not say).
     *
     * It stops even mid-stroke: the plugin does not count presses while the pen writes on the page, so
     * a stroke now is one the firmware began before this press arrived (a slow control file), maybe
     * with the pen from before it.
     */
    fun pressedElsewhere(sentAt: Long, now: Long, ui: Long = 0, uiDone: Long? = null) {
        if (!armed) return
        if (uiDone == null || uiDone < ui) {
            val at = if (sentAt in (now - 5_000)..now) sentAt else now
            waitFrom = maxOf(waitFrom, at)
            waitUntil = maxOf(waitUntil, at + pressGraceMs)
            if (uiDone != null) waitUi = maxOf(waitUi, ui)
        }
        hold("a toolbar was pressed")
    }

    /**
     * A state from the plugin, sent at [sentAt], including the presses up to [uiDone] (null: an older
     * plugin): what the wait was for – the result of the awaited press, or else anything sent after the
     * wait began.
     */
    fun stateSent(sentAt: Long, uiDone: Long? = null) {
        if (waitUntil == 0L) return
        if (waitUi > 0 && uiDone != null) {
            if (uiDone >= waitUi) endWait()
            return
        }
        if (sentAt > waitFrom) endWait()
    }

    private fun endWait() {
        waitUntil = 0
        waitUi = 0
    }

    /** The firmware reports the pen hovering over [zone]. */
    fun hover(zone: Zone, now: Long) {
        if (!armed) return
        // hovering, so not touching: a lost pen-up must not keep the ink off (but what waited for
        // it pauses the firmware first, so the panel shows it; the next hover draws again)
        if (drawing) {
            penUp()
            if (held) return
        }
        when (zone) {
            Zone.PAGE -> {
                awayFrom = -1
                if (held && heldAtPenUp == null && !drawing && (waitUntil == 0L || now >= waitUntil)) {
                    held = false
                    reason = null
                    endWait()
                }
            }
            Zone.EDGE -> awayFrom = -1
            Zone.AWAY -> {
                if (awayFrom < 0) awayFrom = now
                if (now - awayFrom >= awayDwellMs) {
                    // the plugin's state from before this visit does not count, and the wait runs from the last hover here
                    if (waitUntil == 0L) waitFrom = awayFrom
                    waitUntil = maxOf(waitUntil, now + awayGraceMs)
                    if (!held) hold("the pen is over a toolbar")
                }
            }
        }
    }

    fun penDown() {
        drawing = true
        awayFrom = -1
    }

    fun penUp() {
        drawing = false
        heldAtPenUp?.let {
            heldAtPenUp = null
            hold(it)
        }
    }

    private fun hold(why: String) {
        if (!armed) return
        held = true
        reason = why
    }

    private fun holdSoon(why: String) {
        if (!armed) return
        if (drawing) heldAtPenUp = why else hold(why)
    }
}
