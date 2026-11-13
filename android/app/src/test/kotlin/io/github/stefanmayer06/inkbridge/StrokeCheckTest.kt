package io.github.stefanmayer06.inkbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A stroke the plugin records but the firmware does not draw is found, so the firmware can pause for it. */
class StrokeCheckTest {
    @Test
    fun aStrokeTheFirmwareDrewIsFine() {
        val c = StrokeCheck()
        c.firmwareDown(1000)
        assertTrue(c.pluginDown(PenDown(10f, 20f, 1020)))
        assertTrue(c.check(1060).isEmpty())
        assertNull(c.nextCheckAt())
        assertEquals(0, c.missed)
    }

    @Test
    fun aStrokeTheFirmwareDidNotDrawIsFoundAMomentLater() {
        val c = StrokeCheck()
        c.pluginDown(PenDown(500f, 90f, 1000))
        // the firmware's report may still be on its way
        assertTrue(c.check(1060).isEmpty())
        assertEquals(1150L, c.nextCheckAt())
        val missed = c.check(1150)
        assertEquals(listOf(PenDown(500f, 90f, 1000)), missed)
        assertEquals(1, c.missed)
        assertEquals(PenDown(500f, 90f, 1000), c.lastMissed)
        assertNull(c.nextCheckAt())
    }

    @Test
    fun theFirmwaresReportMayComeAfterThePlugins() {
        val c = StrokeCheck()
        c.pluginDown(PenDown(1f, 1f, 1000))
        c.firmwareDown(1010)
        assertTrue(c.check(1200).isEmpty())
    }

    @Test
    fun anotherStrokeOfTheFirmwaresDoesNotCount() {
        val c = StrokeCheck()
        c.firmwareDown(500)
        c.pluginDown(PenDown(1f, 1f, 1000))
        assertEquals(1, c.check(1200).size)
    }

    @Test
    fun eachPenDownOnce() {
        val c = StrokeCheck()
        assertTrue(c.pluginDown(PenDown(1f, 1f, 1000)))
        assertFalse(c.pluginDown(PenDown(1f, 1f, 1000)))
        c.check(2000)
        // later messages repeat the last pen-downs
        assertFalse(c.pluginDown(PenDown(1f, 1f, 1000)))
        assertTrue(c.check(3000).isEmpty())
        assertEquals(1, c.missed)
    }

    @Test
    fun aStrokeWhileTheFirmwareWasPausedIsNotChecked() {
        val c = StrokeCheck()
        val d = PenDown(1f, 1f, 1000)
        c.pluginDown(d)
        c.forget(d)
        assertTrue(c.check(2000).isEmpty())
        assertEquals(0, c.missed)
    }
}
