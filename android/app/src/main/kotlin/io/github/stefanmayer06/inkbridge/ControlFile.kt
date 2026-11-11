package io.github.stefanmayer06.inkbridge

import android.content.Context
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import java.io.File

/**
 * The control file: the plugin writes its state to
 * `<vault>/<config folder>/plugins/ink-notebook/bridge/state.json` and this
 * class reads it whenever it changes. It needs no network at all, only file
 * access to the vault, so it works whatever Obsidian allows its WebView.
 *
 * The file is checked with a cheap stat 10 times a second while the plugin is
 * active (twice a second otherwise): reliable on every Android version, unlike
 * file change notifications on shared storage. Vaults are found by looking for
 * the plugin's folder (vault folders picked in the app first, then a shallow
 * search of the shared storage), again every 30 seconds.
 *
 * This app writes `status.json` next to the control file, so the plugin can show
 * that the Bridge is running.
 */
class ControlFile(private val context: Context, private val onText: (String) -> Unit) {
    private val thread = HandlerThread("ink-bridge-file").apply { start() }
    private val handler = Handler(thread.looper)
    private val seen = HashMap<File, Long>()
    private val lastText = HashMap<File, String>()
    @Volatile private var dirs: List<File> = emptyList()
    @Volatile private var stopped = false
    @Volatile var active = false

    /** The bridge folders found (for the app's screen). */
    val bridgeDirs: List<File> get() = dirs

    fun start() {
        handler.post { rescan() }
        handler.post { poll() }
    }

    fun stop() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
    }

    /** Look for vaults again now (after a vault folder was added in the app). */
    fun rescanNow() {
        handler.post { scan() }
    }

    fun writeStatus(json: String) {
        handler.post {
            for (dir in dirs) {
                try {
                    // the plugin starts writing once it sees this status, so the folder may not exist yet
                    if (!dir.isDirectory && !dir.mkdirs()) continue
                    val tmp = File(dir, "status.json.tmp")
                    tmp.writeText(json)
                    if (!tmp.renameTo(File(dir, "status.json"))) tmp.delete()
                } catch (_: Exception) {
                    // no access (yet): the app's screen says so
                }
            }
        }
    }

    private fun rescan() {
        if (stopped) return
        scan()
        // looking through the storage costs: often until a vault is found, then rarely
        handler.postDelayed({ rescan() }, if (dirs.isEmpty()) RESCAN_MS else RESCAN_FOUND_MS)
    }

    private fun scan() {
        dirs = Vaults.bridgeDirs(context)
    }

    private fun poll() {
        if (stopped) return
        for (dir in dirs) {
            val f = File(dir, "state.json")
            val sig = try {
                if (f.isFile) f.lastModified() * 31 + f.length() else -1L
            } catch (_: Exception) {
                -1L
            }
            if (sig == -1L) continue
            // while the plugin is active the text is compared too: two quick writes of the same
            // length can share a modification time
            if (seen[f] == sig && !active) continue
            seen[f] = sig
            val text = try {
                f.readText()
            } catch (_: Exception) {
                null
            }
            if (text == null || text == lastText[f]) continue
            // a half-written file does not parse; the next poll reads it again
            if (BridgeState.parse(text) != null) {
                lastText[f] = text
                onText(text)
            } else {
                seen.remove(f)
            }
        }
        handler.postDelayed({ poll() }, if (active) POLL_ACTIVE_MS else POLL_IDLE_MS)
    }

    companion object {
        private const val POLL_ACTIVE_MS = 100L
        private const val POLL_IDLE_MS = 500L
        private const val RESCAN_MS = 30_000L
        private const val RESCAN_FOUND_MS = 300_000L
    }
}

/** Finding the vaults that have the Ink Notebook plugin. */
object Vaults {
    private const val PREFS = "vaults"
    private const val KEY = "folders"
    private const val PLUGIN = "plugins/ink-notebook"
    private const val MAX_DEPTH = 4
    private const val MAX_DIRS = 4000

    /** Vault folders picked in the app. */
    fun picked(context: Context): List<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY, emptySet())!!.sorted()

    fun addPicked(context: Context, path: String) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.edit().putStringSet(KEY, (p.getStringSet(KEY, emptySet())!! + path).toSet()).apply()
    }

    fun removePicked(context: Context, path: String) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        p.edit().putStringSet(KEY, (p.getStringSet(KEY, emptySet())!! - path).toSet()).apply()
    }

    /** The plugin folders (`…/plugins/ink-notebook/bridge`) of all vaults found. */
    fun bridgeDirs(context: Context): List<File> = bridgeDirs(picked(context), Environment.getExternalStorageDirectory())

    /** The plugin folders in the picked vault folders and under `root` (a few levels deep). */
    fun bridgeDirs(picked: List<String>, root: File): List<File> {
        val out = LinkedHashSet<File>()
        for (p in picked) pluginDirsIn(File(p)).forEach { out.add(File(it, "bridge")) }
        var visited = 0
        fun walk(dir: File, depth: Int) {
            if (visited++ > MAX_DIRS) return
            pluginDirsIn(dir).forEach { out.add(File(it, "bridge")) }
            if (depth >= MAX_DEPTH) return
            val children = try {
                dir.listFiles { f -> f.isDirectory && !f.name.startsWith(".") && f.name != "Android" }
            } catch (_: Exception) {
                null
            } ?: return
            for (c in children) walk(c, depth + 1)
        }
        try {
            walk(root, 0)
        } catch (_: Exception) {
            // no file access yet
        }
        return out.toList()
    }

    /** `<vault>/<config folder>/plugins/ink-notebook` for a vault folder (the config folder is usually `.obsidian`). */
    private fun pluginDirsIn(vault: File): List<File> {
        val hidden = try {
            vault.listFiles { f -> f.isDirectory && f.name.startsWith(".") }
        } catch (_: Exception) {
            null
        } ?: return emptyList()
        return hidden.map { File(it, PLUGIN) }.filter { it.isDirectory }
    }

    /**
     * A folder picked with the system's folder picker (a tree URI such as
     * `content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FVault`)
     * as a file path, for the shared storage of the device.
     */
    fun pathOfTree(treeDocumentId: String, primary: () -> String = { Environment.getExternalStorageDirectory().path }): String? {
        val parts = treeDocumentId.split(":", limit = 2)
        if (parts.size != 2) return null
        val base = if (parts[0] == "primary") primary() else "/storage/${parts[0]}"
        return if (parts[1].isEmpty()) base else "$base/${parts[1]}"
    }
}
