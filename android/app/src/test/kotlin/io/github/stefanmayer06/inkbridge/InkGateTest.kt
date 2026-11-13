package io.github.stefanmayer06.inkbridge

import io.github.stefanmayer06.inkbridge.InkGate.Zone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the firmware may draw: only with the pen over the page, and never while something else changes on screen. */
class InkGateTest {
    private fun armedOverPage(): InkGate = InkGate().apply {
        arm()
        hover(Zone.PAGE, 0)
    }

    @Test
    fun drawsFromTheFirstHoverOverThePage() {
        val g = InkGate()
        assertFalse(g.draws)
        g.arm()
        // armed, but the pen is not there yet: the panel keeps showing Obsidian as it is
        assertFalse(g.draws)
        g.hover(Zone.EDGE, 0)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 5)
        assertTrue(g.draws)
        assertNull(g.reason)
    }

    @Test
    fun aQuickPassOverAToolbarChangesNothing() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 140)
        assertTrue(g.draws)
        g.hover(Zone.PAGE, 150)
        assertTrue(g.draws)
    }

    @Test
    fun pausesOverAToolbarAndWaitsForThePluginsWord() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 170)
        assertFalse("paused while the pen is over the toolbar", g.draws)
        assertNotNull(g.reason)
        // back over the page at once: the plugin may still be sending what was picked
        g.hover(Zone.PAGE, 200)
        assertFalse(g.draws)
        // a state the plugin sent before the visit does not count
        g.stateSent(90)
        g.hover(Zone.PAGE, 210)
        assertFalse(g.draws)
        // one sent after it does
        g.stateSent(180)
        g.hover(Zone.PAGE, 220)
        assertTrue(g.draws)
    }

    @Test
    fun withoutNewsItDrawsAgainAMomentAfterTheVisit() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 200) // last hover over the toolbar
        g.hover(Zone.PAGE, 300)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 449)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 451)
        assertTrue(g.draws)
    }

    @Test
    fun aPressElsewherePausesAtOnce() {
        val g = armedOverPage()
        g.pressedElsewhere(sentAt = 1000, now = 1030)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 1100)
        assertFalse("waits for what the press changes", g.draws)
        g.stateSent(1120)
        g.hover(Zone.PAGE, 1130)
        assertTrue(g.draws)
    }

    @Test
    fun aPressWithNoConsequenceWaitsOnlyAMoment() {
        val g = armedOverPage()
        g.pressedElsewhere(sentAt = 1000, now = 1030)
        g.hover(Zone.PAGE, 1399)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 1401)
        assertTrue(g.draws)
    }

    @Test
    fun aPressTimeFromAnotherClockIsNotTrusted() {
        val g = armedOverPage()
        g.pressedElsewhere(sentAt = 999_999_999, now = 1000)
        g.hover(Zone.PAGE, 1401)
        assertTrue(g.draws)
    }

    @Test
    fun changesPauseUntilThePenIsBackOverThePage() {
        val g = armedOverPage()
        g.changed()
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 10)
        assertTrue(g.draws)
        g.cleared()
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 20)
        assertTrue(g.draws)
    }

    @Test
    fun aChangeDoesNotCutAStrokeShort() {
        val g = armedOverPage()
        g.penDown()
        g.changed()
        assertTrue("the stroke being written keeps its ink", g.draws)
        g.penUp()
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 50)
        assertTrue(g.draws)
    }

    @Test
    fun aClearTakesTheInkAwayEvenMidStroke() {
        // hold to snap: the hand-drawn line gives way to the shape while the pen still rests
        val g = armedOverPage()
        g.penDown()
        g.cleared()
        assertFalse(g.draws)
    }

    @Test
    fun aLostPenUpDoesNotKeepTheInkOff() {
        val g = armedOverPage()
        g.penDown()
        g.changed()
        // the pen-up never came, but the pen hovers again
        g.hover(Zone.PAGE, 100)
        assertFalse("the change shows first", g.draws)
        g.hover(Zone.PAGE, 105)
        assertTrue(g.draws)
    }

    @Test
    fun offMeansOff() {
        val g = armedOverPage()
        g.disarm()
        assertFalse(g.draws)
        assertEquals("off", g.reason)
        g.hover(Zone.PAGE, 10)
        g.changed()
        g.pressedElsewhere(5, 10)
        assertFalse(g.draws)
        g.arm()
        g.hover(Zone.PAGE, 20)
        assertTrue(g.draws)
    }

    @Test
    fun zones() {
        val r = FirmwareRequest(
            limit = PxRect(0, 100, 1000, 1500),
            exclude = listOf(PxRect(700, 100, 1000, 500)),
            pen = PenSpec(BridgeState.STYLE_PENCIL, 3f, 0xFF000000.toInt()),
            refreshMs = 800,
            sideButton = true,
        )
        assertEquals(Zone.PAGE, zoneOf(500f, 800f, r))
        // a pen card over the page
        assertEquals(Zone.AWAY, zoneOf(800f, 300f, r))
        // just above the page: writing the first line
        assertEquals(Zone.EDGE, zoneOf(500f, 90f, r))
        // the toolbar above it
        assertEquals(Zone.AWAY, zoneOf(500f, 40f, r))
        assertEquals(Zone.AWAY, zoneOf(500f, 1600f, r))
    }
}
