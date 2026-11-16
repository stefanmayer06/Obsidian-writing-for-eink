# Developing Ink Notebook

This page is for people who build, test or release Ink Notebook. How to use the plugin is in the [README](../README.md).

- Diagrams of every flow – writing, transcription, the text page, files, PDFs, arXiv, libraries: [`architecture.md`](architecture.md)
- Instant ink on Boox, the plan and its status: [`boox-fast-ink-plan.md`](boox-fast-ink-plan.md)
- The Ink Notebook Bridge app (Android): [`../android/README.md`](../android/README.md)
- End-to-end tests in the real Obsidian app, the README screenshots and the promo video: [`../e2e/README.md`](../e2e/README.md)

## Build and test

```bash
npm install
npm test          # unit tests (vitest)
npm run build     # type-check + bundle main.js
npm run harness   # the pen engine in a plain browser page, driven with real pen input (Playwright)
```

The pure logic (the ink model, file format, pens, erasers, shapes, OCR parsing, classification, layout, transcript merging, PDF maths, the instant ink messages) lives in `src/core` and is covered by unit tests; the pen engine and its toolbar (DOM only) are in `src/ink`; the Obsidian integration is in `src/obsidian`.

`e2e/` contains end-to-end tests that run the plugin inside the real Obsidian desktop app, write on ink pages with real pen events and use a fake Azure server (see `e2e/README.md`). `dev/fastink-e2e.cjs` runs the plugin's instant ink code in Chromium against the Bridge app's real control code on the JVM (see `android/README.md`).

The Bridge app is built with Gradle:

```bash
npm run build                                   # the plugin the app carries
cd android && ./gradlew testDebugUnitTest assembleRelease
```

### Screenshots and the promo video

The screenshots in `docs/` are taken in real Obsidian with the plugin (`e2e/scripts/screenshots.mjs`). The handwriting is generated from a single-stroke script font, and a local stand-in for Azure supplies the recognised words; everything else – the text page's headings, lists, tasks and links, the live figure, the pages, the PDF, the shapes – is the plugin at work. The arXiv list shows real results.

`docs/ink-notebook-promo.mp4` is recorded the same way, in Obsidian's tablet layout at the size of a Boox Note Air (`e2e/promo/`).

### Debugging

In the developer console, `app.plugins.plugins["ink-notebook"].internals` exposes the recognition pipeline and the file reader.

## How it works

- **The pen engine** (`src/ink`) draws on one opaque canvas that always shows the page as it looks now. Each pen movement adds one curve piece, drawn straight onto it (with every coalesced/raw pointer event, and the low-latency `desynchronized` canvas except on e-ink screens, where Boox shows that canvas with the dither pattern of its fast refresh), so the cost per movement does not grow with the page. Erasing and moving redraw only the area that changed; neighbouring pages are rendered in the background so that turning pages is instant. A second canvas shows previews (highlighter, lasso, shapes, moved selections). Strokes keep their pressure and are drawn with the same code live, on redraw, in figures and in exports (as SVG paths – the PDF export uses them too), so they look the same everywhere.
- **The file** (`core/ink/codec.ts`): a Markdown file whose ink data sits in a hidden `%% ```ink-data … ``` %%` block, one line per page and per stroke; points are delta-encoded integers (0.1 units, pressure in 1/255) in base64. Fills, connectors and the like follow a stroke's points as `key:value` words, which earlier versions skip (they show the stroke without its fill). Edits are immutable updates (undo keeps old versions; they share everything that did not change).
- **Fills** (`core/ink/fill.ts`) are drawn in a pass of their own underneath the highlighter and the ink. The fill tool fills the smallest shape around the tap; when other lines divide it, or several strokes enclose the spot, the strokes are drawn into a grid, flood-filled from the tap and the outline is traced – that becomes an *area*, a stroke that is only a fill. Hatching is cut to the shape as plain lines, so it looks the same on the page, in figures and in the PDF.
- **Flowcharts** (`core/ink/connectors.ts`): an arrow remembers the shapes it was drawn between and is routed again, outline to outline, when they move; a curved arrow (from a Mermaid diagram) is routed like an elbow arrow and rounded again. **Object libraries** (`core/ink/excalidrawLib.ts`) are read and written in Excalidraw's `.excalidrawlib` format. **Mermaid diagrams** (`core/ink/mermaid.ts`, `core/ink/fromMermaid.ts`) are parsed, laid out and turned into shapes, labels and connectors.
- **Recognition**: strokes are grouped into writing areas, rendered black on white (without long straight lines such as table lines and underlines, which only confuse OCR) and sent to Azure; the returned word boxes are mapped back onto the strokes to separate handwriting from drawings. Drawings are clustered into diagrams, each with a diagram area stored in the ink page; the text page shows that area with an `ink-figure` block.
- The transcript region stores a compact fingerprint of what was generated, which is how your corrections, deletions and additions are recognised and kept.
- **Instant ink** (`core/fastInk.ts`, `obsidian/fastInkBridge.ts`): while an ink page with the pen is on screen, the plugin tells the Bridge app where the page is, what covers it, which pen is selected and when a stroke starts or turns out not to be ink – over a WebSocket on `127.0.0.1:47613` or, if Obsidian does not allow that, a control file in the plugin folder (`bridge/state.json`). The Bridge has the Boox firmware draw the pen over that area. Details: [`../android/README.md`](../android/README.md).

## Releasing

Run `npm run set-version -- 2.4.0` (it updates `manifest.json`, `package.json`, `package-lock.json` and `versions.json`) and merge it into `main`, then on GitHub create a release with the tag `2.4.0` – just the version, without a "v" – on `main`, or open *Actions → Build & release → Run workflow* on `main`. Releases are made from `main` only: the release job stops if the tagged commit (or the branch it was run on) is not on `main`.

The workflow runs the tests, builds and publishes the release with `main.js`, `manifest.json` and `styles.css` – which is what Obsidian, BRAT and manual installs download – and the Bridge app (`ink-notebook-bridge.apk`, also under a name with its version), each with a build provenance attestation (check one with `gh attestation verify main.js --repo stefanmayer06/Obsidian-writing-for-eink`). It publishes the `manifest.json` of the repository and stops if the tag is not its version, so a release always matches both its tag and the repository. The APK always carries the plugin of the same run.

Release builds of the Bridge are signed with the key in the `BRIDGE_KEYSTORE`, `BRIDGE_KEYSTORE_PASSWORD`, `BRIDGE_KEY_ALIAS` and `BRIDGE_KEY_PASSWORD` secrets when they are set, otherwise with the public test key in `android/app/test-signing.jks`.

## Test builds

To try a branch before it is released, open *Actions → Build & release → Run workflow*, choose the branch and tick *test build*. That publishes the branch as a pre-release tagged `test-build` (each run replaces the previous one), with the Bridge app's version in its title, and changes nothing on `main`.

- **On a Boox:** install the test build's `ink-notebook-bridge.apk`, open the Bridge app, tap **Update Ink Notebook in the vault** and restart Obsidian. The app carries the plugin of the same build.
- **Elsewhere:** open *Settings → BRAT → Add beta plugin*, enter `stefanmayer06/Obsidian-writing-for-eink` and choose the version `test-build`. BRAT does not fetch a newer test build by itself (the tag and the version number stay the same): remove the plugin in BRAT and add it again. To go back, choose the latest release's version the same way (BRAT only replaces `main.js`, `manifest.json` and `styles.css`, so the settings stay).

Users of the released plugin do not get test builds: Obsidian goes by the `manifest.json` on `main`, and BRAT's latest version is ranked by the version in a release's tag – `test-build` has none, so it never counts as newer.
