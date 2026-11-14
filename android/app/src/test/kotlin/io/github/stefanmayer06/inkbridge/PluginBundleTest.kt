package io.github.stefanmayer06.inkbridge

import io.github.stefanmayer06.inkbridge.PluginBundle.Bundled
import io.github.stefanmayer06.inkbridge.PluginBundle.Installed
import io.github.stefanmayer06.inkbridge.PluginBundle.Match
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** The plugin the Bridge carries: telling which build a vault has, and putting the Bridge's own there. */
class PluginBundleTest {
    private val mine = Bundled("20261114-1840-0cb277b", "2.3.2")

    @Test
    fun readsTheBuildOutOfMainJs() {
        // as esbuild leaves it in the minified file, among other mentions of the marker
        val js = """var a="ink-notebook-build:",b="ink-notebook-build:20261114-1840-0cb277b";/ink-notebook-build:(\d{8})/"""
        assertEquals("20261114-1840-0cb277b", PluginBundle.buildOf(js))
        assertEquals("20261114-1840-0cb277b+local", PluginBundle.buildOf("x='ink-notebook-build:20261114-1840-0cb277b+local'"))
        // a plugin from before builds were named
        assertNull(PluginBundle.buildOf("module.exports = class extends Plugin {}"))
        assertEquals("20261114-1840", PluginBundle.timeOf("20261114-1840-0cb277b"))
        assertNull(PluginBundle.timeOf("dev"))
    }

    @Test
    fun tellsAnOlderPluginFromANewerOne() {
        assertEquals(Match.SAME, PluginBundle.compare(Installed(true, "20261114-1840-0cb277b", "2.3.2"), mine))
        // from before builds were named: older than any that is
        assertEquals(Match.VAULT_OLDER, PluginBundle.compare(Installed(true, null, "2.3.2"), mine))
        assertEquals(Match.VAULT_OLDER, PluginBundle.compare(Installed(true, "20261114-1655-bfdf08a", "2.3.2"), mine))
        // another build of the same minute is not the same: the Bridge's replaces it
        assertEquals(Match.VAULT_OLDER, PluginBundle.compare(Installed(true, "20261114-1840-aaaaaaa", "2.3.2"), mine))
        // never put an older plugin over a newer one
        assertEquals(Match.VAULT_NEWER, PluginBundle.compare(Installed(true, "20261115-0900-1234567", "2.3.3"), mine))
        assertEquals(Match.NO_PLUGIN, PluginBundle.compare(Installed(false, null, null), mine))
        assertEquals(Match.NO_BUNDLE, PluginBundle.compare(Installed(true, null, "2.3.2"), null))
    }

    @Test
    fun readsWhatTheRunningPluginReports() {
        assertEquals(kotlin.Pair("2.3.2", "20261114-1840-0cb277b"), PluginBundle.parseReported("2.3.2+20261114-1840-0cb277b"))
        assertEquals(kotlin.Pair("2.3.2", "20261114-1840-0cb277b+local"), PluginBundle.parseReported("2.3.2+20261114-1840-0cb277b+local"))
        // the version alone (the first builds that said anything)
        assertEquals(kotlin.Pair("2.3.2", null), PluginBundle.parseReported("2.3.2"))
        assertNull(PluginBundle.parseReported(null))
        assertNull(PluginBundle.parseReported(""))
    }

    @Test
    fun putsItsPluginIntoTheVaultAndFindsItThere() {
        val root = Files.createTempDirectory("vault").toFile()
        try {
            val dir = File(root, ".obsidian/plugins/ink-notebook").apply { mkdirs() }
            // an old plugin, and settings that are the user's
            File(dir, "main.js").writeText("module.exports = 'old'")
            File(dir, "manifest.json").writeText("""{"id":"ink-notebook","version":"2.3.1"}""")
            File(dir, "data.json").writeText("""{"tools":{}}""")
            val before = PluginBundle.installed(dir)
            assertTrue(before.exists)
            assertNull(before.build)
            assertEquals("2.3.1", before.version)
            assertEquals(Match.VAULT_OLDER, PluginBundle.compare(before, mine))

            val files = mapOf(
                "main.js" to "var b=\"ink-notebook-build:${mine.build}\";",
                "manifest.json" to """{"id":"ink-notebook","version":"2.3.2"}""",
                "styles.css" to ".ink-surface{}",
            )
            assertNull(PluginBundle.install(dir) { files.getValue(it).toByteArray() })

            val after = PluginBundle.installed(dir)
            assertEquals(mine.build, after.build)
            assertEquals("2.3.2", after.version)
            assertEquals(Match.SAME, PluginBundle.compare(after, mine))
            assertEquals(".ink-surface{}", File(dir, "styles.css").readText())
            // the settings are untouched, and nothing is left lying around
            assertEquals("""{"tools":{}}""", File(dir, "data.json").readText())
            assertFalse(dir.list()!!.any { it.endsWith(".bridge-tmp") })
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun aFailedInstallSaysWhy() {
        val root = Files.createTempDirectory("vault").toFile()
        try {
            val dir = File(root, "plugin").apply { mkdirs() }
            val err = PluginBundle.install(dir) { throw java.io.IOException("no such asset: $it") }
            assertTrue(err!!.contains("no such asset"))
            assertFalse(PluginBundle.installed(dir).exists)
        } finally {
            root.deleteRecursively()
        }
    }
}
