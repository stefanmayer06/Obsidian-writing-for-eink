package io.github.stefanmayer06.inkbridge

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    private val message = """
        {"v":1,"type":"state","seq":42,"armed":true,"until":5000,"dpr":2,
         "region":{"x":0,"y":56,"w":620,"h":800},
         "exclude":[{"x":0,"y":0,"w":620,"h":56},{"x":400,"y":70,"w":0,"h":10}],
         "pen":{"style":"fountain","width":4.2,"color":"#d32f2f"},
         "refreshMs":800,"sideButtonErases":true,"clear":3,
         "down":{"x":100.5,"y":200.25,"t":4000}}
    """.trimIndent()

    @Test
    fun parsesTheState() {
        val s = BridgeState.parse(message)
        assertNotNull(s)
        s!!
        assertEquals(42L, s.seq)
        assertTrue(s.armed)
        assertEquals(2f, s.dpr)
        assertEquals(CssRect(0f, 56f, 620f, 800f), s.region)
        // the empty rectangle is dropped
        assertEquals(listOf(CssRect(0f, 0f, 620f, 56f)), s.exclude)
        assertEquals(BridgeState.STYLE_FOUNTAIN, s.pen.style)
        assertEquals(4.2f, s.pen.width, 1e-6f)
        assertEquals(0xFFD32F2F.toInt(), s.pen.color)
        assertEquals(3L, s.clear)
        assertEquals(PenDown(100.5f, 200.25f, 4000L), s.down)
    }

    @Test
    fun readsWhenItWasSentAndThePresses() {
        val s = BridgeState.parse(message)!!
        // from plugins before 2.4: none
        assertEquals(0L, s.at)
        assertEquals(0L, s.ui)
        val t = BridgeState.parse(message.replace("\"clear\":3,", "\"clear\":3,\"at\":123456,\"ui\":7,"))!!
        assertEquals(123456L, t.at)
        assertEquals(7L, t.ui)
    }

    @Test
    fun readsTheRecentPenDowns() {
        val s = BridgeState.parse(message.replace("\"clear\":3,", "\"clear\":3,\"downs\":[{\"x\":1,\"y\":2,\"t\":3900},{\"x\":100.5,\"y\":200.25,\"t\":4000},{\"y\":5}],"))!!
        // the broken one is dropped, the last one is the same as "down"
        assertEquals(listOf(PenDown(1f, 2f, 3900), PenDown(100.5f, 200.25f, 4000)), s.allDowns)
        // without the list: the last pen-down alone
        assertEquals(listOf(PenDown(100.5f, 200.25f, 4000)), BridgeState.parse(message)!!.allDowns)
    }

    @Test
    fun tellsScreenChangesFromRenewals() {
        val s = BridgeState.parse(message)!!
        assertTrue(s.sameScreen(s.copy(seq = 43, until = 9000, at = 5, ui = 1, clear = 4, down = null)))
        assertFalse(s.sameScreen(null))
        assertFalse(s.sameScreen(s.copy(exclude = emptyList())))
        assertFalse(s.sameScreen(s.copy(pen = s.pen.copy(width = 6f))))
        assertFalse(s.sameScreen(s.copy(armed = false)))
    }

    @Test
    fun leasedArmedOrNot() {
        val s = BridgeState.parse(message)!!.copy(armed = false)
        assertTrue(s.leased(4999))
        assertFalse(s.live(4999))
        assertFalse(s.leased(5000))
    }

    @Test
    fun liveOnlyWhileTheLeaseHolds() {
        val s = BridgeState.parse(message)!!
        assertTrue(s.live(4999))
        assertFalse(s.live(5000))
        assertFalse(s.copy(armed = false).live(0))
        assertFalse(s.copy(region = CssRect(0f, 0f, 0f, 10f)).live(0))
    }

    @Test
    fun rejectsOtherVersionsAndBrokenText() {
        assertNull(BridgeState.parse(message.replace("\"v\":1", "\"v\":2")))
        assertNull(BridgeState.parse("{\"v\":1,\"type\":\"status\"}"))
        assertNull(BridgeState.parse("{\"v\":1,\"type\":\"sta"))
        assertNull(BridgeState.parse(""))
    }

    @Test
    fun clampsNonsense() {
        val s = BridgeState.parse("""{"v":1,"type":"state","dpr":100,"pen":{"width":-3,"color":"red"},"refreshMs":5}""")!!
        assertEquals(1f, s.dpr)
        assertEquals(0.5f, s.pen.width)
        assertEquals(0xFF000000.toInt(), s.pen.color)
        assertEquals(100, s.refreshMs)
        assertEquals(BridgeState.STYLE_PENCIL, s.pen.style)
    }

    @Test
    fun stylesAndColours() {
        assertEquals(BridgeState.STYLE_NEO_BRUSH, BridgeState.styleOf("brush"))
        assertEquals(BridgeState.STYLE_CHARCOAL_V2, BridgeState.styleOf("charcoal2"))
        assertEquals(0x80112233.toInt(), BridgeState.colorOf("#80112233"))
        assertEquals(0xFF000000.toInt(), BridgeState.colorOf("#12345"))
    }

    @Test
    fun treePaths() {
        assertEquals("/storage/emulated/0/Documents/Vault", Vaults.pathOfTree("primary:Documents/Vault") { "/storage/emulated/0" })
        assertEquals("/storage/1234-ABCD/Notes", Vaults.pathOfTree("1234-ABCD:Notes"))
        assertNull(Vaults.pathOfTree("nonsense"))
    }
}

class CalibrationTest {
    @Test
    fun startsFromTheGuess() {
        val c = Calibration(0f, 40f)
        assertFalse(c.calibrated)
        // drawing area rounds inwards, parts left out round outwards with a margin
        assertArrayEquals(intArrayOf(0, 152, 1240, 1752), c.toPx(CssRect(0f, 56f, 620f, 800f), 2f, grow = false))
        assertArrayEquals(intArrayOf(-4, 36, 1244, 156), c.toPx(CssRect(0f, 0f, 620f, 56f), 2f, grow = true))
    }

    @Test
    fun measuresTheOffsetFromPenDowns() {
        val c = Calibration(0f, 40f)
        // the window really starts 64 px down and 10 px right
        c.recordRaw(210f, 464f, 1000)
        assertTrue(c.match(PenDown(100f, 200f, 1030), 2f))
        assertTrue(c.calibrated)
        assertEquals(10f, c.offsetX)
        assertEquals(64f, c.offsetY)
        // the same press again changes nothing
        assertFalse(c.match(PenDown(100f, 200f, 1030), 2f))
    }

    @Test
    fun ignoresPressesThatDoNotMatch() {
        val c = Calibration(0f, 40f)
        c.recordRaw(210f, 464f, 1000)
        // too long after the firmware's pen-down
        assertFalse(c.match(PenDown(100f, 200f, 2000), 2f))
        // the same time but far away: another press
        assertFalse(c.match(PenDown(1000f, 1500f, 1000), 2f))
        assertFalse(c.calibrated)
    }

    @Test
    fun measuresTheScaleFromPressesSpreadOverThePage() {
        // the page's real scale is 1.8 (not the ratio 2 the plugin reports, e.g. Boox's per-app DPI)
        val c = Calibration(0f, 40f)
        val presses = listOf(100f to 100f, 500f to 300f, 300f to 700f, 600f to 900f)
        for ((i, p) in presses.withIndex()) {
            val t = 1000L * (i + 1)
            c.recordRaw(p.first * 1.8f + 5f, p.second * 1.8f + 30f, t)
            c.match(PenDown(p.first, p.second, t + 5), 2f)
        }
        assertEquals(1.8f, c.scaleX!!, 0.001f)
        assertEquals(1.8f, c.scaleY!!, 0.001f)
        assertEquals(5f, c.offsetX, 0.1f)
        assertEquals(30f, c.offsetY, 0.1f)
        // the whole page, not just part of it
        assertArrayEquals(intArrayOf(5, 30, 1121, 1470), c.toPx(CssRect(0f, 0f, 620f, 800f), 2f, grow = false))
        // a press that does not fit (another pen-down at nearly the same time) changes nothing
        c.recordRaw(50f, 50f, 9000)
        assertFalse(c.match(PenDown(600f, 600f, 9001), 2f))
        assertEquals(1.8f, c.scaleX!!, 0.001f)
    }

    @Test
    fun keepsTheRatioWhenItFits() {
        val c = Calibration(0f, 40f)
        for ((i, p) in listOf(100f to 100f, 500f to 300f, 300f to 700f).withIndex()) {
            val t = 1000L * (i + 1)
            c.recordRaw(p.first * 2f, p.second * 2f + 48f, t)
            c.match(PenDown(p.first, p.second, t), 2f)
        }
        assertNull(c.scaleX)
        assertEquals(48f, c.offsetY, 0.01f)
    }

    @Test
    fun twoPressesAtOnceAreNotAMeasurement() {
        val c = Calibration(0f, 40f)
        c.recordRaw(210f, 464f, 1000)
        c.recordRaw(900f, 900f, 1100)
        assertFalse(c.match(PenDown(100f, 200f, 1030), 2f))
        assertFalse(c.calibrated)
    }

    @Test
    fun aScaleFromPressesCloseTogetherIsNotMeasured() {
        // three presses within 200 CSS px: a scale from them would be a guess far from them
        val c = Calibration(0f, 40f)
        for ((i, p) in listOf(300f to 300f, 400f to 380f, 480f to 330f).withIndex()) {
            val t = 1000L * (i + 1)
            c.recordRaw(p.first * 1.8f + 5f, p.second * 1.8f + 30f, t)
            c.match(PenDown(p.first, p.second, t), 2f)
        }
        assertNull(c.scaleX)
        assertNull(c.scaleY)
    }

    @Test
    fun aMissedStrokeTakesTheMeasuredScaleAway() {
        val c = Calibration(0f, 40f)
        val presses = listOf(100f to 100f, 500f to 300f, 300f to 700f, 600f to 900f)
        for ((i, p) in presses.withIndex()) {
            val t = 1000L * (i + 1)
            c.recordRaw(p.first * 1.8f + 5f, p.second * 1.8f + 30f, t)
            c.match(PenDown(p.first, p.second, t), 2f)
        }
        assertNotNull(c.scaleX)
        assertTrue(c.distrustScale(2f))
        assertNull(c.scaleX)
        assertNull(c.scaleY)
        // the offset fits the presses at the device pixel ratio (their median)
        assertEquals(-75f, c.offsetX, 0.5f)
        assertFalse(c.distrustScale(2f))
    }

    @Test
    fun oneOddPressDoesNotMoveThePage() {
        val c = Calibration()
        for ((i, dy) in listOf(64f, 64f, 64f, 90f, 64f).withIndex()) {
            val t = 1000L * (i + 1)
            c.recordRaw(200f, 400f + dy, t)
            c.match(PenDown(100f, 200f, t + 10), 2f)
        }
        assertEquals(64f, c.offsetY)
    }
}
