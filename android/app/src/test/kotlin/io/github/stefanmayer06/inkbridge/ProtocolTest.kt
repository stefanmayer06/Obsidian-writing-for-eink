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
