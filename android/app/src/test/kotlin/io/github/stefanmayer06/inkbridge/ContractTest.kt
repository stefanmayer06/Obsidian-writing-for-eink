package io.github.stefanmayer06.inkbridge

import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.ServerSocket
import java.net.URI
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The plugin and the app agree: the message here is what the plugin's buildMessage produces (tests/fastInk.test.ts checks the same file). */
class ContractTest {
    private fun fixture(): String = javaClass.classLoader!!.getResource("plugin-message.json")!!.readText()

    @Test
    fun readsThePluginsMessage() {
        val s = BridgeState.parse(fixture())
        assertNotNull(s)
        s!!
        assertTrue(s.live(4999))
        assertEquals(CssRect(0f, 57f, 620f, 799f), s.region)
        assertEquals(listOf(CssRect(400f, 70f, 201f, 300f), CssRect(600f, 800f, 20f, 56f)), s.exclude)
        assertEquals(PenSpec(BridgeState.STYLE_FOUNTAIN, 5.4f, 0xFFD32F2F.toInt()), s.pen)
        assertEquals(PenDown(100.5f, 200.3f, 4000), s.down)
        assertEquals(1000L, s.at)
        assertEquals(2L, s.ui)
        // in device pixels below a 40 px status bar
        val c = Calibration(0f, 40f)
        assertArrayEquals(intArrayOf(0, 154, 1240, 1752), c.toPx(s.region!!, s.dpr, grow = false))
        assertArrayEquals(intArrayOf(796, 176, 1206, 784), c.toPx(s.exclude[0], s.dpr, grow = true))
        // where the page, the ink view and Obsidian's window are, and the presses the message includes
        assertEquals(1L, s.uiDone)
        assertEquals(CssRect(0f, 56.4f, 620f, 877.3f), s.page)
        assertEquals(CssRect(0f, 56f, 620f, 801f), s.surface)
        assertEquals(WindowGeom(0f, 24f, 620f, 956.4f, 620f, 980.4f), s.win)
        assertEquals(ViewportGeom(620f, 956.4f, 620f, 980.4f, 0f), s.vp)
        assertEquals("9.9.9-test", s.app)
        // placed from the window: 24 CSS px down is 48 px, nothing measured
        val (x, y) = windowOffset(s.win!!, s.dpr, 0, 0)
        val w = Calibration(0f, 40f).apply { placeFromWindow(x, y) }
        assertArrayEquals(intArrayOf(0, 162, 1240, 1760), w.toPx(s.region!!, s.dpr, grow = false))
        val r = firmwareRequest(s, w, 1240, 2000, 4000)!!
        assertEquals(PxRect(-4, 156, 1244, 1766), r.surface)
    }
}

/** The real WebSocket server, on the JVM. */
class ControlSocketTest {
    private fun freePort() = ServerSocket(0).use { it.localPort }

    private class Client(port: Int, origin: String) : WebSocketClient(URI("ws://127.0.0.1:$port"), mapOf("Origin" to origin)) {
        val opened = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val received = LinkedBlockingQueue<String>()
        override fun onOpen(h: ServerHandshake?) = opened.countDown()
        override fun onMessage(message: String) {
            received.add(message)
        }
        override fun onClose(code: Int, reason: String?, remote: Boolean) = closed.countDown()
        override fun onError(ex: Exception?) {}
    }

    @Test
    fun obsidianConnectsAndSendsItsState() {
        val port = freePort()
        val got = LinkedBlockingQueue<String>()
        val clients = LinkedBlockingQueue<Int>()
        val server = ControlSocket(port, { got.add(it) }, { clients.add(it) })
        server.start()
        try {
            Thread.sleep(300)
            val c = Client(port, "http://localhost")
            assertTrue(c.connectBlocking(3, TimeUnit.SECONDS))
            assertEquals(1, clients.poll(3, TimeUnit.SECONDS))
            c.send(fixture())
            val text = got.poll(3, TimeUnit.SECONDS)
            assertNotNull(BridgeState.parse(text!!))
            // the status goes back to Obsidian
            server.send(BridgeState.status(true, false, 0f, 40f, "socket", null, 42))
            assertTrue(c.received.poll(3, TimeUnit.SECONDS)!!.contains("\"type\":\"status\""))
            c.closeBlocking()
            assertEquals(0, clients.poll(3, TimeUnit.SECONDS))
        } finally {
            server.stop(500)
        }
    }

    @Test
    fun aWebsiteCannotConnect() {
        val port = freePort()
        val server = ControlSocket(port, {}, {})
        server.start()
        try {
            Thread.sleep(300)
            val c = Client(port, "https://example.com")
            assertFalse(c.connectBlocking(3, TimeUnit.SECONDS))
        } finally {
            server.stop(500)
        }
    }

    private fun fixture(): String = javaClass.classLoader!!.getResource("plugin-message.json")!!.readText()
}

class VaultsTest {
    @Test
    fun findsVaultsWithThePlugin() {
        val root = Files.createTempDirectory("storage").toFile()
        try {
            File(root, "Documents/Notes/.obsidian/plugins/ink-notebook").mkdirs()
            File(root, "Documents/Other/.obsidian/plugins/something-else").mkdirs()
            File(root, "Custom/.config/plugins/ink-notebook").mkdirs() // another config folder name
            File(root, "Android/data/md.obsidian/files/V/.obsidian/plugins/ink-notebook").mkdirs() // app storage: never readable
            val found = Vaults.bridgeDirs(emptyList(), root).map { it.relativeTo(root).path }.sorted()
            assertEquals(
                listOf("Custom/.config/plugins/ink-notebook/bridge", "Documents/Notes/.obsidian/plugins/ink-notebook/bridge"),
                found,
            )
        } finally {
            root.deleteRecursively()
        }
    }
}
