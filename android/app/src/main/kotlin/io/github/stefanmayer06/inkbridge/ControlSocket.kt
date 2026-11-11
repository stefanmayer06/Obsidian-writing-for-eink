package io.github.stefanmayer06.inkbridge

import org.java_websocket.WebSocket
import org.java_websocket.drafts.Draft
import org.java_websocket.exceptions.InvalidDataException
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshakeBuilder
import org.java_websocket.server.WebSocketServer
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * The fast control channel: a WebSocket on 127.0.0.1 (never on the network).
 * Only pages from Obsidian may connect (their Origin header), so a website open
 * in a browser cannot. Whether Obsidian's Android WebView may open a plain
 * ws:// connection depends on Obsidian; when it may not, the plugin uses the
 * control file instead.
 */
class ControlSocket(
    port: Int,
    private val onText: (String) -> Unit,
    private val onClientsChanged: (Int) -> Unit,
) : WebSocketServer(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port)) {

    init {
        isReuseAddr = true
        connectionLostTimeout = 15
    }

    override fun onWebsocketHandshakeReceivedAsServer(
        conn: WebSocket,
        draft: Draft,
        request: ClientHandshake,
    ): ServerHandshakeBuilder {
        val origin = request.getFieldValue("Origin") ?: ""
        if (origin !in ALLOWED_ORIGINS) throw InvalidDataException(CloseFrame.POLICY_VALIDATION, "Not Obsidian")
        return super.onWebsocketHandshakeReceivedAsServer(conn, draft, request)
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        onClientsChanged(connections.size)
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
        onClientsChanged(connections.size)
    }

    override fun onMessage(conn: WebSocket, message: String) {
        if (message.length <= MAX_MESSAGE) onText(message)
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        // a failed bind (port taken) leaves the control file
    }

    override fun onStart() {}

    fun send(json: String) {
        try {
            broadcast(json)
        } catch (_: Exception) {
        }
    }

    companion object {
        const val PORT = 47613
        private const val MAX_MESSAGE = 64 * 1024

        /** Obsidian's app origins: Android, iOS, desktop. */
        val ALLOWED_ORIGINS = setOf("http://localhost", "https://localhost", "capacitor://localhost", "app://obsidian.md")
    }
}
