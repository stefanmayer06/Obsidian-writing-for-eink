# Ink Notebook Bridge

The Android app that gives Ink Notebook **instant ink on Onyx Boox tablets**: while you write on an ink page in Obsidian, the Boox firmware draws the stroke straight onto the e‑ink screen, the same way the Boox Notes app does, so there is no lag. Ink Notebook still receives the pen as always, records the stroke and draws it itself once you pause.

A plugin can't do this on its own, because the firmware's pen drawing is only reachable from Android code. Why, and how it fits together: [docs/boox-fast-ink-plan.md](../docs/boox-fast-ink-plan.md).

## How it works

- **The overlay.** A foreground service puts a transparent window over the screen that takes **no touches** (`FLAG_NOT_TOUCHABLE`, opacity 0.2 so Android 12+ passes touches through). Obsidian gets the pen and fingers exactly as before.
- **The firmware drawing.** The window hosts Onyx's `TouchHelper` (public SDK `com.onyx.android.sdk:onyxsdk-pen`, SurfaceFlinger mode `FEATURE_SF_TOUCH_RENDER`). It reads the pen directly and has the firmware draw the stroke, limited to the ink page (`setLimitRect`) minus the plugin's toolbars and cards (exclude rects), with the selected pen's style, width and colour.
- **Only on request.** The firmware draws only while the plugin holds a lease (it renews it every few seconds while an ink page is on screen) and the pen tool is selected. Otherwise it is paused and the tablet behaves as if the app weren't there.
- **Only with the pen over the page.** While the firmware draws, the panel is in its handwriting mode and does not keep up with Obsidian's own screen: a tool change, a pen card or a new page would show late. So the firmware pauses (`setRawDrawingRenderEnabled(false)`, which leaves that mode) the moment the pen hovers over a toolbar or card, anything else is pressed (the plugin reports a press the moment it starts), the toolbars or pen change, or the page changes; it draws again on the pen's next hover over the page, which always comes before the pen touches it. After a visit to a toolbar it waits a moment for the plugin's word on what was picked. The rules are in `InkGate.kt`.
- **Control channels.**
  - The plugin connects to a WebSocket on `127.0.0.1:47613`, which only accepts Obsidian's origins.
  - If Obsidian's WebView doesn't allow that, the plugin writes `<vault>/.obsidian/plugins/ink-notebook/bridge/state.json` and the app reads it as soon as the system reports it written, and in any case checks it 40× a second while an ink page is open.
  - Either way the app reports back in `bridge/status.json`.
- **Position.** Rectangles arrive in CSS pixels. The app converts them with the device pixel ratio and an offset (where Obsidian's window starts). The offset is measured from the first pen‑downs, which the firmware reports in screen pixels and the plugin in CSS pixels.
- **Not ink after all.** When a stroke turns out not to be ink (a tap on a link, hold‑to‑snap, scribble‑erase), or the page changes (undo, erasing, a page turn), the plugin bumps a counter and the firmware pauses, so the panel shows Obsidian's page.

The approach of an overlay plus `TouchHelper` in SurfaceFlinger mode was shown to work over other apps (including Obsidian plugins) by [Boox Rapid Draw](https://github.com/sergeylappo/boox-rapid-draw) by Sergey Lappo (MIT). This app follows it, adding the control channel, regions, pens and lease.

## Install and set up

1. Download `ink-notebook-bridge.apk` from the [releases](https://github.com/stefanmayer06/Obsidian-writing-for-eink/releases) on the Boox and install it. Unfreeze it if the launcher shows a snowflake on it.
2. Open it and allow:
   - **Display over other apps**
   - **Access to files**, which it uses to find the vault's control file. The vault must be in the device storage, not in Obsidian's app storage.
   - Optionally, the notification.
3. Tap **Start the Bridge**. It starts again by itself after a restart.
   - **Test instant ink (30 s)** turns the firmware drawing on over the whole screen without Obsidian. If the ink follows the pen with no lag there, the firmware path works on your tablet. The status shows how many pen hovers and strokes the firmware's pen reader reported.
4. In Obsidian, open an ink page. *Settings → Ink Notebook → Instant ink on Boox* shows *Connected*. The first strokes measure the position on screen.

## Build

```bash
cd android && ./gradlew testDebugUnitTest assembleRelease
```

Release builds are signed with the key in `BRIDGE_KEYSTORE` / `BRIDGE_KEYSTORE_PASSWORD` / `BRIDGE_KEY_ALIAS` / `BRIDGE_KEY_PASSWORD` when set. Otherwise they use the fixed test key `app/test-signing.jks`. It is public on purpose, so every test build installs over the previous one; set the secrets for real releases. CI builds the APK and attaches it to every release (`.github/workflows/release.yml`).

### Tests without a Boox

- `./gradlew testDebugUnitTest` covers the protocol, calibration, when the firmware may draw (`InkGateTest`), vault discovery and the real WebSocket server (origins). It also checks the plugin's actual message (`app/src/test/resources/plugin-message.json`, which `tests/fastInk.test.ts` checks from the plugin side).
- `dev/fastink-e2e.cjs` (run from the repository root) runs the real plugin code in Chromium against this app's real control code on the JVM, with the firmware replaced by a report of what it would be asked. It covers placement and calibration, cards left out, toolbar presses reported before the tool changes, tools, pens, zoom, Obsidian modals and sidebars, clearing on hold‑to‑snap, and stopping when the plugin goes away.

What only a Boox can show is the firmware actually drawing.

## Licence

MIT (see `LICENSE`). It is a separate program from the plugin, which talks to it over a socket or a file. The Onyx SDK it bundles is Onyx's, published for third‑party apps on `repo.boox.com`.
