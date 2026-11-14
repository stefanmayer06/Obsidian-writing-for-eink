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
 * touches it, never while it touches: switched on mid-stroke, the firmware would
 * not draw that stroke (it began before), and the panel, now in its handwriting
 * mode, would stop showing Obsidian's own drawing of it – the stroke would stay
 * invisible until the next pause. So a hover report that waited for the main
 * thread while the pen touched down is ignored ([hover]'s `penDown`, from the pen
 * reader's own thread).
 *
 * After the pen only hovered over a toolbar, it draws again the moment the pen is
 * back over the page (a wait there made the firmware switch on just as the pen
 * touched the top of the page). After the pen touched something on the visit
 * (the firmware's hover reports pause while the pen touches), or after a press the
 * plugin reports, it first waits for the plugin's word on what was chosen, so that
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
     * After a visit on which the pen touched something, wait this long after the pen left for the
     * plugin's state (unless it came sooner). A press there is sent the moment it starts, and is on its
     * way long before the pen is back over the page: this only covers a slow write of the control file.
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
    /** The pen visited something that is not the page (the firmware stopped for it) and has not drawn since. */
    private var visiting = false
    /** On that visit the pen touched something (or went out of reach): it may have pressed a button there. */
    private var touchedAway = false
    /** After such a visit: wait until then for the plugin's word (0: not waiting) … */
    private var awayWaitUntil = 0L
    /** … which a state it sent after this ends. */
    private var awayWaitFrom = 0L
    /** After a press elsewhere: wait until then (0: not waiting) … */
    private var pressWaitUntil = 0L
    /** … for a state sent after this … */
    private var pressWaitFrom = 0L
    /** … or, from plugins that say so, for a state that includes this press (0: none awaited). */
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
        endVisit()
        pressWaitUntil = 0
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
            pressWaitFrom = maxOf(pressWaitFrom, at)
            pressWaitUntil = maxOf(pressWaitUntil, at + pressGraceMs)
            if (uiDone != null) waitUi = maxOf(waitUi, ui)
        }
        hold("a toolbar was pressed")
    }

    /**
     * A state from the plugin, sent at [sentAt], including the presses up to [uiDone] (null: an older
     * plugin): what a wait was for – the result of the awaited press, or else anything sent after the
     * wait began.
     */
    fun stateSent(sentAt: Long, uiDone: Long? = null) {
        if (awayWaitUntil != 0L && sentAt > awayWaitFrom) awayWaitUntil = 0
        if (pressWaitUntil == 0L) return
        if (waitUi > 0 && uiDone != null) {
            if (uiDone >= waitUi) endPressWait()
        } else if (sentAt > pressWaitFrom) {
            endPressWait()
        }
    }

    /**
     * The firmware reports the pen hovering over [zone]. [gap]: its hover reports paused since the last
     * one (the pen touched something, or went out of reach). [penDown]: the pen reader says the pen
     * touches the screen now – this report is from before that, and changes nothing.
     */
    fun hover(zone: Zone, now: Long, gap: Boolean = false, penDown: Boolean = false) {
        if (!armed || penDown) return
        // hovering, so not touching: a lost pen-up must not keep the ink off (but what waited for
        // it pauses the firmware first, so the panel shows it; the next hover draws again)
        if (drawing) {
            penUp()
            if (held) return
        }
        if (gap && (visiting || awayFrom >= 0)) touchedAway = true
        when (zone) {
            Zone.PAGE -> {
                awayFrom = -1
                if (!visiting) touchedAway = false
                if (held && heldAtPenUp == null && waitsOver(now)) release()
            }
            Zone.EDGE -> awayFrom = -1
            Zone.AWAY -> {
                if (awayFrom < 0) awayFrom = now
                if (now - awayFrom >= awayDwellMs) {
                    if (!visiting) {
                        visiting = true
                        // the plugin's state from before this visit does not count
                        awayWaitFrom = awayFrom
                    }
                    // the wait runs from the last hover here
                    awayWaitUntil = maxOf(awayWaitUntil, now + awayGraceMs)
                    if (!held) hold("the pen is over a toolbar")
                }
            }
        }
    }

    private fun waitsOver(now: Long): Boolean {
        val press = pressWaitUntil == 0L || now >= pressWaitUntil
        val away = !touchedAway || awayWaitUntil == 0L || now >= awayWaitUntil
        return press && away
    }

    private fun release() {
        held = false
        reason = null
        endVisit()
        endPressWait()
    }

    private fun endVisit() {
        visiting = false
        touchedAway = false
        awayWaitUntil = 0
    }

    private fun endPressWait() {
        pressWaitUntil = 0
        waitUi = 0
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
