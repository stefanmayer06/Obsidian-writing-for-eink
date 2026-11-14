package io.github.stefanmayer06.inkbridge

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * The Ink Notebook plugin this app goes with, carried inside the app.
 *
 * Instant ink is two halves: this app and the plugin in Obsidian. They are built
 * together and talk a protocol that grows with every build, so an app from one
 * build with a plugin from an earlier one misbehaves in ways that look like bugs
 * (the app waits for things the plugin does not send). The app is installed by
 * hand; the plugin comes another way (BRAT, Obsidian's plugin list) and a test
 * build keeps its version number, so nothing made it follow.
 *
 * So the app carries the plugin build it was made with (`assets/plugin`: main.js,
 * manifest.json, styles.css and the build's name) and can put it into a vault's
 * plugin folder, which it reaches anyway (the control file is there). Every plugin
 * build has a name in its main.js – the commit's date and time and its short
 * hash, `ink-notebook-build:20261114-1840-0cb277b` – by which the app tells which
 * build a vault has, whatever put it there.
 */
object PluginBundle {
    /** What a vault's plugin folder needs (what Obsidian itself installs). */
    val FILES = listOf("main.js", "manifest.json", "styles.css")
    private const val DIR = "plugin"
    private const val PREFS = "bridge"
    private const val KEY_KEEP = "keepPlugin"
    private val MARK = Regex("ink-notebook-build:([0-9]{8}-[0-9]{4}-[0-9a-f]{7,40}(?:\\+local)?)")
    private val TIME = Regex("^([0-9]{8}-[0-9]{4})-")

    /** How the plugin in a vault stands to the one this app carries. */
    enum class Match {
        /** The same build. */
        SAME,
        /** An earlier build (or one from before builds had names): this app's replaces it. */
        VAULT_OLDER,
        /** A later build: the app is the one to update. */
        VAULT_NEWER,
        /** No plugin there (no main.js). */
        NO_PLUGIN,
        /** This app was built without a plugin to carry. */
        NO_BUNDLE,
    }

    /** The plugin this app carries. */
    data class Bundled(val build: String, val version: String)

    /** The plugin in a vault: whether it is there, and its build (null: from before builds had names) and version. */
    data class Installed(val exists: Boolean, val build: String?, val version: String?)

    /** The build named in the text of a main.js, or null. */
    fun buildOf(mainJs: String): String? = MARK.find(mainJs)?.groupValues?.get(1)

    /** The date and time a build's name starts with, by which builds sort. */
    fun timeOf(build: String?): String? = build?.let { TIME.find(it)?.groupValues?.get(1) }

    /** The version in the text of a manifest.json, or null. */
    fun versionOf(manifest: String): String? = try {
        JSONObject(manifest).optString("version", "").takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }

    fun compare(installed: Installed, bundled: Bundled?): Match {
        if (bundled == null) return Match.NO_BUNDLE
        if (!installed.exists) return Match.NO_PLUGIN
        if (installed.build == bundled.build) return Match.SAME
        val a = timeOf(installed.build)
        val b = timeOf(bundled.build)
        return if (a != null && b != null && a > b) Match.VAULT_NEWER else Match.VAULT_OLDER
    }

    /**
     * The build and version a running plugin reports ("2.3.2+20261114-1840-0cb277b"): the version,
     * and the build (null when it names none).
     */
    fun parseReported(app: String?): kotlin.Pair<String, String?>? {
        if (app.isNullOrBlank()) return null
        val i = app.indexOf('+')
        return if (i < 0) kotlin.Pair(app, null) else kotlin.Pair(app.substring(0, i), app.substring(i + 1).takeIf { it.isNotBlank() })
    }

    // ------------------------------------------------------------------ this app's plugin

    @Volatile private var cached: Bundled? = null
    @Volatile private var looked = false

    /** The plugin this app carries (null: built without one). */
    fun bundled(context: Context): Bundled? {
        if (looked) return cached
        cached = try {
            val assets = context.assets
            val build = assets.open("$DIR/build-id.txt").use { it.readBytes().toString(Charsets.UTF_8) }.trim()
            val version = assets.open("$DIR/manifest.json").use { versionOf(it.readBytes().toString(Charsets.UTF_8)) } ?: "?"
            // all of it, or nothing
            for (f in FILES) assets.open("$DIR/$f").close()
            if (build.isNotBlank() && build != "dev") Bundled(build, version) else null
        } catch (_: Exception) {
            null
        }
        looked = true
        return cached
    }

    // ------------------------------------------------------------------ a vault's plugin

    private val installedCache = HashMap<String, kotlin.Pair<Long, Installed>>()

    /** The plugin in a vault's plugin folder (`…/plugins/ink-notebook`). Reads main.js: not for the main thread. */
    fun installed(pluginDir: File): Installed {
        val main = File(pluginDir, "main.js")
        val sig = try {
            if (main.isFile) main.lastModified() * 31 + main.length() else -1L
        } catch (_: Exception) {
            -1L
        }
        if (sig == -1L) return Installed(false, null, null)
        synchronized(installedCache) { installedCache[main.path]?.let { if (it.first == sig) return it.second } }
        val result = try {
            // bytes as they are: the name is plain ASCII, the rest does not matter
            val build = buildOf(main.readBytes().toString(Charsets.ISO_8859_1))
            val version = runCatching { versionOf(File(pluginDir, "manifest.json").readText()) }.getOrNull()
            Installed(true, build, version)
        } catch (_: Exception) {
            return Installed(false, null, null)
        }
        synchronized(installedCache) { installedCache[main.path] = kotlin.Pair(sig, result) }
        return result
    }

    /**
     * Put this app's plugin into a vault's plugin folder. Each file is written beside the old one
     * and moved over it, so Obsidian never finds half a file. Returns null when done, else what went
     * wrong. Obsidian loads it when it next starts. Not for the main thread.
     */
    fun install(context: Context, pluginDir: File): String? {
        if (bundled(context) == null) return "this Bridge carries no Ink Notebook"
        return install(pluginDir) { name -> context.assets.open("$DIR/$name").use { it.readBytes() } }
    }

    /** [install] with the files from anywhere (the unit tests). */
    fun install(pluginDir: File, read: (String) -> ByteArray): String? {
        val tmps = ArrayList<File>()
        return try {
            if (!pluginDir.isDirectory && !pluginDir.mkdirs()) return "cannot create ${pluginDir.path}"
            // all of it read, then all of it written beside the old files, and only then moved into
            // place: when anything is missing or the storage is full, the old plugin stays whole
            val data = FILES.associateWith { read(it) }
            for ((name, bytes) in data) {
                val tmp = File(pluginDir, "$name.bridge-tmp")
                tmps.add(tmp)
                tmp.writeBytes(bytes)
                if (tmp.length() != bytes.size.toLong()) throw java.io.IOException("could not write all of $name")
            }
            // main.js last: with the styles and manifest of the new build already in place
            for (name in FILES.reversed()) {
                val tmp = File(pluginDir, "$name.bridge-tmp")
                val target = File(pluginDir, name)
                if (!tmp.renameTo(target)) {
                    // some storage will not move over an existing file
                    target.delete()
                    if (!tmp.renameTo(target)) throw java.io.IOException("cannot write ${target.path}")
                }
            }
            synchronized(installedCache) { installedCache.remove(File(pluginDir, "main.js").path) }
            null
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        } finally {
            for (t in tmps) if (t.exists()) t.delete()
        }
    }

    // ------------------------------------------------------------------ keeping them matched

    /**
     * The user asked once for the plugin to be updated from this app: from then on the app keeps a
     * vault's plugin matched to itself whenever it starts (after an update of the app, say), unless
     * turned off.
     */
    fun keepsMatched(context: Context): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_KEEP, false)

    fun setKeepMatched(context: Context, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_KEEP, on).apply()
    }

    /**
     * Update every vault whose plugin is older than this app's. Returns the vaults' plugin folders it
     * updated, and what went wrong where it could not. Not for the main thread.
     */
    fun updateOlder(context: Context, bridgeDirs: List<File>): kotlin.Pair<List<File>, List<String>> {
        val b = bundled(context) ?: return kotlin.Pair(emptyList(), emptyList())
        val done = ArrayList<File>()
        val errors = ArrayList<String>()
        for (dir in bridgeDirs) {
            val pluginDir = dir.parentFile ?: continue
            if (compare(installed(pluginDir), b) != Match.VAULT_OLDER) continue
            val err = install(context, pluginDir)
            if (err == null) done.add(pluginDir) else errors.add("${pluginDir.path}: $err")
        }
        return kotlin.Pair(done, errors)
    }
}
