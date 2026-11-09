# End-to-end tests

These tests run Ink Notebook inside a **real Obsidian desktop app**, driven
through the Chrome DevTools protocol. Writing uses real pointer events with
`pointerType: "pen"` and pressure (and touch events for gestures), like a
stylus on a tablet. A fake Azure server genuinely looks at the uploaded
handwriting images (it finds ink, groups it into lines and words and labels
the lines with texts chosen by the test).

They cover: creating an ink page (files, links, paper), writing with the pen,
hold-to-snap shapes, the shape and text tools, saving, the speed of the pen on
a full page and of turning pages, flipping to the text page (transcript,
lists, links, live figures, one request per writing area) and back, the
side-button eraser, the lasso and its action bar, undo, the pen options card,
adding pages, changing the paper, the page overview, swiping with a finger,
typed notes, PDF annotation (incl. a rotated page) and export (annotated PDF
and the notebook as PDF), plugin reload, "Open as Markdown", embedded ink
pages, ink pages for notes that exist (and notes opened in a tab that shows an
ink page), daily notes with an ink page, matching up the names of ink and text
pages, choosing the folder of a new page, converting pages made with the
earlier Excalidraw-based versions, fills, flowcharts and object libraries
(placing library shapes, arrows attached to shapes, labels, an Excalidraw
library in the vault, "To library"), Mermaid diagrams (from the code block of
a note and pasted on an ink page, placed as attached shapes and arrows,
saved, removed), and
the e-ink look on a Boox-sized window (toolbar fits).

Linux only (uses Xvfb). Requirements: Node 20+, `xvfb`, the GTK/NSS libraries Electron needs.

```bash
npm run build                  # in the repo root
cd e2e
npm install                    # playwright-core, pngjs, pdf-lib
./scripts/download.sh          # Obsidian AppImage into e2e/bin
./scripts/fresh.sh             # fresh vault, start Obsidian + mock Azure
node scripts/e2e.mjs           # run everything (screenshots in e2e/shots)
node scripts/e2e.mjs pdf       # or a single step (after "setup")
```

## Screenshots for the README

`scripts/screenshots.mjs` stages the screenshots of the README (which is also
the plugin's page in Obsidian's community plugins) in the same setup:
handwriting traced from a single-stroke script font (`scripts/handwriting.mjs`,
Hershey "cursive", public domain), recognised by the mock Azure server, and
real arXiv results fetched with `curl` and served to Obsidian locally.

```bash
SCALE=2 W=1200 H=1400 ./scripts/fresh.sh   # twice the pixel density
node scripts/screenshots.mjs                # all scenes → e2e/shots/listing
node scripts/screenshots.mjs pdf            # or one scene (after "setup")
```

The images in `docs/` are these, scaled to 1440 × 1920 and reduced to 256
colours (libimagequant / pngquant).

The pen engine can also be tested without Obsidian, in a plain Chromium page:
`npm run harness` in the repo root (see `dev/`).

## Promo video

`promo/` records the footage of the 40-second promo video in the same setup
(the real plugin in Obsidian's tablet layout, written on with pen events) and
edits it into `docs/ink-notebook-promo.mp4` – see `promo/README.md`.
