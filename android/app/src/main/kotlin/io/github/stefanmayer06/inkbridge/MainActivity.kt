package io.github.stefanmayer06.inkbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

/**
 * The setup screen: the permissions the Bridge needs, the vaults it found,
 * start/stop, and whether Ink Notebook is talking to it. Plain black on white
 * with large buttons, for e-ink.
 *
 * Opened as `inknotebook-bridge://start` (the plugin's "Start the Bridge"
 * button) it starts the Bridge and closes again when everything is set up.
 */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var steps: LinearLayout
    /** Whether the Ink Notebook in the vault is the one this app goes with, and the button to make it so. */
    private lateinit var pluginBox: LinearLayout
    /** What the last update of the vault's plugin did (shown until the screen is left). */
    private var pluginMessage: String? = null
    private var pluginBusy = false
    private var ticks = 0
    /** The vaults' bridge folders found when the screen last looked (looking walks the storage: not every second). */
    @Volatile private var foundDirs: List<File> = emptyList()
    private lateinit var status: TextView
    private lateinit var vaults: TextView
    private lateinit var startStop: Button
    private lateinit var testButton: Button

    private val tick = object : Runnable {
        override fun run() {
            refresh()
            // the vault's plugin: looked at now and then (it changes when Obsidian or this app updates it)
            if (ticks++ % 3 == 0) refreshPlugin()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(20)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        col.addView(text("Ink Notebook Bridge", 26f, bold = true))
        col.addView(
            text(
                "Shows your writing on Ink Notebook pages in Obsidian as fast as the Boox Notes app: " +
                    "the Boox firmware draws the ink straight onto the screen while Ink Notebook records the stroke as usual. " +
                    "It only works over an open ink page, never over toolbars, menus or other apps.",
                16f,
            ),
        )
        if (!Build.MANUFACTURER.contains("onyx", ignoreCase = true)) {
            col.addView(text("This does not look like an Onyx Boox tablet (${Build.MANUFACTURER} ${Build.MODEL}). The Bridge needs the Boox firmware.", 16f, bold = true))
        }
        pluginBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(pluginBox)
        steps = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(steps)
        col.addView(text("Vaults", 20f, bold = true))
        vaults = text("Looking for vaults with Ink Notebook…", 15f)
        col.addView(vaults)
        col.addView(button("Add a vault folder…") { pickVault() })
        startStop = button("Start") { toggle() }
        col.addView(startStop)
        col.addView(
            button("Measure the page position again") {
                startService(Intent(this, BridgeService::class.java).setAction(BridgeService.ACTION_RECALIBRATE))
            },
        )
        col.addView(text("Tests", 20f, bold = true))
        col.addView(
            text(
                "Each test turns the firmware drawing on over the whole screen for 30 seconds, without Obsidian. " +
                    "Write anywhere (on this screen too): the ink should follow the pen with no lag. " +
                    "While a test runs the screen shows only the ink: the status below is from before it, and shows the test's counts when it ends. " +
                    "Test 1 is how instant ink works. Tests 2 and 3 try other ways for tablets where test 1 shows only hovers " +
                    "(during them, this window takes all touches for 30 seconds).",
                15f,
            ),
        )
        testButton = button("Test 1: the firmware reads the pen (30 s)") { test(com.onyx.android.sdk.pen.TouchHelper.FEATURE_SF_TOUCH_RENDER) }
        col.addView(testButton)
        col.addView(button("Test 2: the Bridge hands on the pen, pen mode (30 s)") { test(BridgeService.FEATURE_APP_PEN) })
        col.addView(button("Test 3: the Bridge hands on the pen, touch mode (30 s)") { test(com.onyx.android.sdk.pen.TouchHelper.FEATURE_APP_TOUCH_RENDER) })
        col.addView(text("Status", 20f, bold = true))
        status = text("", 15f)
        col.addView(status)
        setContentView(ScrollView(this).apply { addView(col) })
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshSteps()
        refreshVaults()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun handleIntent(i: Intent?) {
        when (i?.data?.host) {
            "start" -> if (ready()) {
                start()
                finish()
            }
            "stop" -> {
                stop()
                finish()
            }
        }
    }

    // ------------------------------------------------------------------ permissions

    private fun canOverlay() = Settings.canDrawOverlays(this)

    private fun canFiles() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Environment.isExternalStorageManager()
    } else {
        checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    private fun canNotify() = Build.VERSION.SDK_INT < 33 ||
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun ready() = canOverlay() && canFiles()

    private fun refreshSteps() {
        steps.removeAllViews()
        steps.addView(text("Setup", 20f, bold = true))
        step(
            "1. Display over other apps",
            "Lets the Bridge put its invisible drawing layer over Obsidian. It takes no touches.",
            canOverlay(),
        ) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        step(
            "2. Access to files",
            "Ink Notebook tells the Bridge where the page is through a small file in your vault " +
                "(.obsidian/plugins/ink-notebook/bridge). The vault must be in the device storage, not in Obsidian's app storage.",
            canFiles(),
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
            } else {
                requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            step("3. Notification (optional)", "Shows that the Bridge is running, with a Stop button.", canNotify()) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshSteps()
    }

    private fun step(title: String, desc: String, done: Boolean, action: () -> Unit) {
        steps.addView(text(if (done) "✓ $title" else "✗ $title", 17f, bold = true))
        steps.addView(text(desc, 15f))
        if (!done) steps.addView(button("Allow") { action() })
    }

    // ------------------------------------------------------------------ the plugin in the vault

    /** What the top of the screen says about one vault's plugin. */
    private class PluginLine(val vault: String, val pluginDir: File, val installed: PluginBundle.Installed, val match: PluginBundle.Match)

    /**
     * Whether the Ink Notebook in each vault is the build this app goes with. The two halves are built
     * together; an older plugin with a newer Bridge misbehaves in ways that look like bugs, and nothing
     * else makes the plugin follow (a test build keeps its version number). So the app says it at the
     * top of its screen, and can put its own copy of the plugin into the vault.
     */
    private fun refreshPlugin() {
        if (pluginBusy) return
        val bundled = PluginBundle.bundled(this)
        if (bundled == null || !canFiles()) {
            pluginBox.removeAllViews()
            pluginShown = null
            return
        }
        // the vaults the running Bridge knows, else those this screen found: no walk through the storage here
        val dirs = BridgeService.instance?.bridgeDirs?.takeIf { it.isNotEmpty() } ?: foundDirs
        Thread {
            val lines = dirs.mapNotNull { bridge ->
                val dir = bridge.parentFile ?: return@mapNotNull null
                val inst = PluginBundle.installed(dir)
                PluginLine(vaultOf(bridge), dir, inst, PluginBundle.compare(inst, bundled))
            }
            runOnUiThread { showPlugin(bundled, lines) }
        }.start()
    }

    /** What the plugin block last showed: it is built again only when that changes (no flashing, no lost taps). */
    private var pluginShown: String? = null

    private fun showPlugin(bundled: PluginBundle.Bundled, lines: List<PluginLine>) {
        if (pluginBusy) return
        val svc = BridgeService.instance
        val running = svc?.pluginReported
        val shows = listOf(
            bundled, lines.map { "${it.vault}|${it.match}|${it.installed}" }, running, svc != null && svc.lastMessageAt > 0,
            pluginMessage, svc?.pluginsUpdated, PluginBundle.keepsMatched(this),
        ).toString()
        if (shows == pluginShown && pluginBox.childCount > 0) return
        pluginShown = shows
        pluginBox.removeAllViews()
        pluginBox.addView(text("Ink Notebook in Obsidian", 20f, bold = true))
        val mine = "${bundled.version}, build ${bundled.build}"
        var older = false
        for (l in lines) {
            val there = "${l.installed.version ?: "?"}, ${l.installed.build?.let { "build $it" } ?: "a build from before builds were named"}"
            when (l.match) {
                PluginBundle.Match.VAULT_OLDER -> {
                    older = true
                    pluginBox.addView(text("✗ Ink Notebook in ${l.vault} is older than this Bridge.", 17f, bold = true))
                    pluginBox.addView(
                        text(
                            "In the vault: $there. This Bridge goes with: $mine. The two are made together and have to match: " +
                                "with an older Ink Notebook, parts of the page get no instant ink.",
                            15f,
                        ),
                    )
                }
                PluginBundle.Match.SAME -> {
                    // what Obsidian last said it runs (an Ink Notebook from before builds were named says nothing)
                    val heard = svc != null && svc.lastMessageAt > 0
                    val runs = running?.second
                    when {
                        heard && runs != bundled.build -> {
                            pluginBox.addView(text("✗ Ink Notebook in ${l.vault} is up to date, but Obsidian is still running the older one.", 17f, bold = true))
                            pluginBox.addView(
                                text(
                                    "Restart Obsidian: close it in the app switcher (swipe it away) and open it again, then open an ink page. " +
                                        "Running: ${running?.first ?: "Ink Notebook"}, ${runs?.let { "build $it" } ?: "a build from before builds were named"}. In the vault: $mine.",
                                    15f,
                                ),
                            )
                        }
                        heard -> pluginBox.addView(text("✓ Ink Notebook in ${l.vault} matches this Bridge and is the one running ($mine).", 15f))
                        else -> pluginBox.addView(text("✓ Ink Notebook in ${l.vault} matches this Bridge ($mine). Open an ink page in Obsidian to see here that it is the one running.", 15f))
                    }
                }
                PluginBundle.Match.VAULT_NEWER ->
                    pluginBox.addView(text("Ink Notebook in ${l.vault} ($there) is newer than this Bridge goes with ($mine): install the newer Bridge app.", 15f, bold = true))
                else -> {}
            }
        }
        if (lines.isEmpty()) pluginBox.addView(text("No vault with Ink Notebook found yet. This Bridge goes with Ink Notebook $mine.", 15f))
        pluginMessage?.let { pluginBox.addView(text(it, 16f, bold = true)) }
        svc?.pluginsUpdated?.takeIf { it.isNotEmpty() && pluginMessage == null }?.let { done ->
            pluginBox.addView(text("Ink Notebook was updated in ${done.joinToString { v -> vaultOfPlugin(v) }} when the Bridge started. If Obsidian was open, restart it.", 15f))
        }
        if (older) {
            pluginBox.addView(button("Update Ink Notebook in the vault") { updatePlugin(lines.filter { it.match == PluginBundle.Match.VAULT_OLDER }) })
        }
        if (PluginBundle.keepsMatched(this) || older) {
            val on = PluginBundle.keepsMatched(this)
            pluginBox.addView(
                button(if (on) "Keeping Ink Notebook matched to the Bridge: on (tap to turn off)" else "Keeping Ink Notebook matched to the Bridge: off (tap to turn on)") {
                    PluginBundle.setKeepMatched(this, !on)
                    refreshPlugin()
                },
            )
        }
    }

    /** Put this app's Ink Notebook into the vaults that have an older one; from then on the app keeps them matched. */
    private fun updatePlugin(lines: List<PluginLine>) {
        if (pluginBusy) return
        pluginBusy = true
        pluginMessage = "Updating Ink Notebook…"
        pluginBox.addView(text("Updating Ink Notebook…", 16f, bold = true))
        Thread {
            val errors = lines.mapNotNull { l -> PluginBundle.install(this, l.pluginDir)?.let { "${l.vault}: $it" } }
            runOnUiThread {
                pluginBusy = false
                pluginMessage = if (errors.isEmpty()) {
                    PluginBundle.setKeepMatched(this, true)
                    "Ink Notebook is updated in the vault. Now restart Obsidian: close it in the app switcher (swipe it away) and open it again."
                } else {
                    "Could not update Ink Notebook: ${errors.joinToString("; ")}. Is access to files allowed?"
                }
                refreshPlugin()
            }
        }.start()
    }

    /** `<vault>/.obsidian/plugins/ink-notebook` → `<vault>`. */
    private fun vaultOfPlugin(pluginDir: File): String = pluginDir.parentFile?.parentFile?.parentFile?.path ?: pluginDir.path

    // ------------------------------------------------------------------ vaults

    private fun pickVault() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK_VAULT)
    }

    @Deprecated("Activity result API without androidx")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (requestCode != PICK_VAULT || resultCode != RESULT_OK || uri == null) return
        val path = Vaults.pathOfTree(DocumentsContract.getTreeDocumentId(uri)) ?: return
        Vaults.addPicked(this, path)
        BridgeService.instance?.let { startService(Intent(this, BridgeService::class.java).setAction(BridgeService.ACTION_RESCAN)) }
        refreshVaults()
    }

    private fun refreshVaults() {
        Thread {
            val found = if (canFiles()) Vaults.bridgeDirs(this) else emptyList()
            foundDirs = found
            runOnUiThread {
                refreshPlugin()
                vaults.text = when {
                    !canFiles() -> "Allow access to files first."
                    found.isEmpty() -> "No vault with Ink Notebook found. Open an ink page in Obsidian once (it creates the folder), or add the vault folder."
                    else -> found.joinToString("\n") { vaultOf(it) }
                }
            }
        }.start()
    }

    /** `<vault>/.obsidian/plugins/ink-notebook/bridge` → `<vault>`. */
    private fun vaultOf(bridge: File): String = bridge.parentFile?.parentFile?.parentFile?.parentFile?.path ?: bridge.path

    // ------------------------------------------------------------------ start / stop

    private fun toggle() {
        if (BridgeService.instance != null) stop() else if (ready()) start() else refreshSteps()
        handler.postDelayed({ refresh() }, 300)
    }

    private fun start() {
        BootReceiver.setWanted(this, true)
        startForegroundService(Intent(this, BridgeService::class.java))
    }

    private fun test(feature: Int) {
        if (!ready()) {
            refreshSteps()
            return
        }
        if (BridgeService.instance == null) start()
        // the service may still be starting: ask shortly after
        handler.postDelayed({
            startService(Intent(this, BridgeService::class.java).setAction(BridgeService.ACTION_TEST).putExtra(BridgeService.EXTRA_FEATURE, feature))
        }, 600)
    }

    private fun stop() {
        BootReceiver.setWanted(this, false)
        startService(Intent(this, BridgeService::class.java).setAction(BridgeService.ACTION_STOP))
    }

    private fun refresh() {
        val svc = BridgeService.instance
        startStop.text = if (svc != null) "Stop the Bridge" else "Start the Bridge"
        startStop.isEnabled = svc != null || ready()
        testButton.text = "Test 1: the firmware reads the pen (30 s)"
        status.text = if (svc == null) {
            "Not running."
        } else {
            val ago = if (svc.lastMessageAt == 0L) null else (System.currentTimeMillis() - svc.lastMessageAt) / 1000
            buildString {
                append("Running.\n")
                append(
                    when {
                        ago == null -> "Ink Notebook has not connected yet: open an ink page in Obsidian."
                        ago < 10 -> "Ink Notebook connected (${if (svc.transportName == "socket") "direct connection" else "control file"})."
                        else -> "Last message from Ink Notebook ${ago}s ago."
                    },
                )
                svc.pluginReported?.let { (version, build) ->
                    append(" Ink Notebook $version, ${build?.let { "build $it" } ?: "a build from before builds were named"}.")
                }
                append("\n")
                append(
                    when {
                        svc.isTesting -> "TEST ${svc.testName} running – write anywhere."
                        svc.isArmed -> "Instant ink: on – ${svc.inkState}."
                        else -> "Instant ink: waiting (no ink page with the pen tool open)."
                    },
                )
                append("\n")
                append("Firmware pen reader: ${svc.penHovers} hover(s), ${svc.penStrokes} stroke(s) since the Bridge started.")
                svc.testCounts?.let { (h, n) -> append(" In the last test: $h hover(s), $n stroke(s).") }
                if (svc.touchEvents > 0) append(" Pen events to the Bridge: ${svc.touchEvents}.")
                append("\n\nIn Obsidian (the last ink page)\n")
                append("Position: ${svc.placement}.\n")
                append("Page: ${svc.pageArea}.\n")
                append("Strokes: ${svc.strokeCounts}.")
                if (svc.missedStrokes > 0) append(" Ink Notebook's own drawing showed those the firmware did not draw.")
                if (svc.lateSwitchOns > 0) {
                    append("\nBegun just before the firmware was to draw again: ${svc.lateSwitchOns} (it waited for the pen-up; Ink Notebook's own drawing showed them).")
                }
                val log = svc.notDrawnLog
                if (log.isNotEmpty()) {
                    append("\nNot drawn by the firmware, newest first:")
                    for (line in log) append("\n • $line")
                }
                append("\n\nThe firmware's area now: ${svc.drawingArea}")
                svc.lastError?.let { append("\nProblem: $it") }
            }
        }
    }

    // ------------------------------------------------------------------ views

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, size: Float, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(0xFF000000.toInt())
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(8), 0, dp(4))
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        textSize = 17f
        gravity = Gravity.CENTER
        isAllCaps = false
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(6)
        }
        textAlignment = View.TEXT_ALIGNMENT_CENTER
    }

    companion object {
        private const val PICK_VAULT = 10
    }
}
