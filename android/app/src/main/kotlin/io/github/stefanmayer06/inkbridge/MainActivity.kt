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
    private lateinit var status: TextView
    private lateinit var vaults: TextView
    private lateinit var startStop: Button
    private lateinit var testButton: Button

    private val tick = object : Runnable {
        override fun run() {
            refresh()
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
        steps = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(steps)
        col.addView(text("Vaults", 20f, bold = true))
        vaults = text("Looking for vaults with Ink Notebook…", 15f)
        col.addView(vaults)
        col.addView(button("Add a vault folder…") { pickVault() })
        startStop = button("Start") { toggle() }
        col.addView(startStop)
        col.addView(text("Tests", 20f, bold = true))
        col.addView(
            text(
                "Each test turns the firmware drawing on over the whole screen for 30 seconds, without Obsidian. " +
                    "Write anywhere (on this screen too): the ink should follow the pen with no lag. " +
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
            runOnUiThread {
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
                append("\n")
                append(
                    when {
                        svc.isTesting -> "TEST ${svc.testName} running – write anywhere."
                        svc.isArmed -> "Instant ink: on (pen over the ink page)."
                        else -> "Instant ink: waiting (no ink page with the pen tool open)."
                    },
                )
                append("\n")
                append("Firmware pen reader: ${svc.penHovers} hover(s), ${svc.penStrokes} stroke(s) seen.")
                if (svc.touchEvents > 0) append(" Pen events to the Bridge: ${svc.touchEvents}.")
                append("\n")
                append(if (svc.isCalibrated) "Position: measured." else "Position: estimated. It is measured from your first strokes.")
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
