package io.github.stefanmayer06.inkbridge

import android.content.Context
import android.os.Environment
import android.os.Handler
import android.os.FileObserver
import android.os.HandlerThread
import java.io.File

/**
 * The control file: the plugin writes its state to
 * `<vault>/<config folder>/plugins/ink-notebook/bridge/state.json` and this
 * class reads it whenever it changes. It needs no network at all, only file
 * access to the vault, so it works whatever Obsidian allows its WebView.
 *
 * The file is read as soon as the system reports it written (a file observer,
 * where shared storage reports changes), and in any case checked with a cheap
 * stat 40 times a second while an ink page is open (4 times a second otherwise),
 * which is reliable on every Android version. A tool change thus reaches the
 * firmware within a few tens of milliseconds. Vaults are found by looking for the
 * plugin's folder (vault folders picked in the app first, then a shallow search
 * of the shared storage), again every 30 seconds.
 *
 * This app writes `status.json` next to the control file, so the plugin can show
 * that the Bridge is running.
 */
class ControlFile(private val context: Context, private val onText: (String) -> Unit) {
    private val thread = HandlerThread("ink-bridge-file").apply { start() }
    private val handler = Handler(thread.looper)
    private val seen = HashMap<File, Long>()
    private val lastText = HashMap<File, String>()
    private var lastFullRead = 0L
    /** One per bridge folder (kept here: an observer that is collected stops reporting). */
    private val observers = HashMap<File, FileObserver>()
    @Volatile private var dirs: List<File> = emptyList()
    @Volatile private var stopped = false
    /** An ink page is open (the plugin holds its lease): check often. */
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
        handler.post { watch(emptyList()) }
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
        watch(dirs)
    }

    /** Be told when the plugin writes (where the storage reports it; the regular check stays). */
    @Suppress("DEPRECATION")
    private fun watch(list: List<File>) {
        val keep = list.toSet()
        observers.keys.filter { it !in keep }.forEach { observers.remove(it)?.stopWatching() }
        for (dir in list) {
            if (dir in observers || !dir.isDirectory) continue
            val o = object : FileObserver(dir.path, CLOSE_WRITE or MOVED_TO) {
                override fun onEvent(event: Int, path: String?) {
                    if (path == "state.json" && !stopped) handler.post { check(force = true) }
                }
            }
            // kept even when it cannot watch, so it is not tried again on every check
            observers[dir] = o
            try {
                o.startWatching()
            } catch (_: Exception) {
            }
        }
    }

    private fun poll() {
        if (stopped) return
        check(force = false)
        handler.postDelayed({ poll() }, if (active) POLL_ACTIVE_MS else POLL_IDLE_MS)
    }

    /** Read the control file if it changed (`force`: it was just reported written). */
    private fun check(force: Boolean) {
        if (stopped) return
        val now = System.currentTimeMillis()
        // now and then the text is compared too: two quick writes of the same length can share a
        // modification time
        val full = force || (active && now - lastFullRead >= FULL_READ_MS)
        if (full) lastFullRead = now
        for (dir in dirs) {
            val f = File(dir, "state.json")
            val sig = try {
                val m = f.lastModified()
                if (m > 0L) m * 31 + f.length() else -1L
            } catch (_: Exception) {
                -1L
            }
            if (sig == -1L) {
                // the folder appeared after the last scan (the plugin made it): watch it
                if (dir !in observers && dir.isDirectory) watch(dirs)
                continue
            }
            if (seen[f] == sig && !full) continue
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
    }

    companion object {
        private const val POLL_ACTIVE_MS = 25L
        private const val POLL_IDLE_MS = 250L
        private const val FULL_READ_MS = 400L
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
