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
    fun pausesOverAToolbarAndDrawsAgainTheMomentThePenIsBack() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 170)
        assertFalse("paused while the pen is over the toolbar", g.draws)
        assertNotNull(g.reason)
        // it only hovered there (no pause in the hover reports): nothing can have been pressed, so the
        // firmware draws again at once – long before the pen touches the page, not just as it does
        g.hover(Zone.PAGE, 180)
        assertTrue(g.draws)
    }

    @Test
    fun afterTouchingSomethingOnTheVisitItWaitsForThePluginsWord() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 170)
        // the hover reports paused: the pen touched a button, then hovers over it again
        g.hover(Zone.AWAY, 300, gap = true)
        // back over the page: the plugin may still be sending what was picked
        g.hover(Zone.PAGE, 320)
        assertFalse(g.draws)
        // a state the plugin sent before the visit does not count
        g.stateSent(90)
        g.hover(Zone.PAGE, 330)
        assertFalse(g.draws)
        // one sent after it does
        g.stateSent(310)
        g.hover(Zone.PAGE, 340)
        assertTrue(g.draws)
    }

    @Test
    fun aQuickTapOnAToolbarCounts() {
        // touched before the pen hovered there long enough to make it a visit
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 130, gap = true)
        g.hover(Zone.AWAY, 200)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 250)
        assertFalse("waits for what the tap picked", g.draws)
        g.hover(Zone.PAGE, 351)
        assertTrue(g.draws)
    }

    @Test
    fun aHoverReportThatCameLateWhileThePenTouchesChangesNothing() {
        // paused (the page changed); a hover report over the page waited for the main thread while the
        // pen touched down: switching on now would be mid-stroke – the stroke would not be drawn by the
        // firmware, nor shown by Obsidian
        val g = armedOverPage()
        g.cleared()
        g.hover(Zone.PAGE, 100, penDown = true)
        assertFalse(g.draws)
        // the pen-up comes, then hovering again: drawing
        g.hover(Zone.PAGE, 300)
        assertTrue(g.draws)
    }

    @Test
    fun liftingThePenOutOfReachOverThePageIsNoVisit() {
        val g = armedOverPage()
        g.cleared()
        g.hover(Zone.PAGE, 1000, gap = true)
        assertTrue(g.draws)
    }

    @Test
    fun withoutNewsItDrawsAgainAMomentAfterTheVisit() {
        val g = armedOverPage()
        g.hover(Zone.AWAY, 100)
        g.hover(Zone.AWAY, 200, gap = true) // last hover over the toolbar, after a touch there
        g.hover(Zone.PAGE, 300)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 349)
        assertFalse(g.draws)
        g.hover(Zone.PAGE, 351)
        assertTrue(g.draws)
    }

    @Test
    fun afterAPressItWaitsForTheResultOfThatPress() {
        val g = armedOverPage()
        // press no. 3 on the toolbar; the plugin's message says it includes presses up to 2
        g.pressedElsewhere(sentAt = 1000, now = 1030, ui = 3, uiDone = 2)
        assertFalse(g.draws)
        // a message sent after the press, but from before its result (a lease renewal): still waiting
        g.stateSent(1050, uiDone = 2)
        g.hover(Zone.PAGE, 1100)
        assertFalse(g.draws)
        // the result: drawing again at once, not after the fixed wait
        g.stateSent(1120, uiDone = 3)
        g.hover(Zone.PAGE, 1130)
        assertTrue(g.draws)
    }

    @Test
    fun aPressThatArrivesWithItsResultDoesNotWait() {
        // the control file keeps only the latest message: the press and its result came as one
        val g = armedOverPage()
        g.pressedElsewhere(sentAt = 1000, now = 1030, ui = 3, uiDone = 3)
        assertFalse("the panel shows the result first", g.draws)
        g.hover(Zone.PAGE, 1040)
        assertTrue(g.draws)
    }

    @Test
    fun aPressThatArrivesMidStrokeStopsTheInkAtOnce() {
        // the firmware drew again before a slow press message came: that stroke may have the old pen
        val g = armedOverPage()
        g.penDown()
        g.pressedElsewhere(sentAt = 1000, now = 1030, ui = 1, uiDone = 0)
        assertFalse(g.draws)
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
        // the ink view around the page (the grey margin, below the page) is not a toolbar
        val withView = r.copy(limit = PxRect(40, 120, 960, 1400), surface = PxRect(0, 100, 1000, 1500))
        assertEquals(Zone.PAGE, zoneOf(500f, 800f, withView))
        assertEquals(Zone.EDGE, zoneOf(500f, 1480f, withView))
        assertEquals(Zone.EDGE, zoneOf(10f, 800f, withView))
        assertEquals(Zone.AWAY, zoneOf(800f, 300f, withView))
        assertEquals(Zone.AWAY, zoneOf(500f, 40f, withView))
    }
}
