# Promo video

A 40-second video of Ink Notebook for Reddit and other feeds: 1080 × 1350
(4:5, the size feeds show largest on phones), 30 fps, H.264 + AAC, with
captions burnt in so it works muted. The finished video is
[`docs/ink-notebook-promo.mp4`](../../docs/ink-notebook-promo.mp4).

Everything on the tablet's screen is the real plugin in a real Obsidian, in
Obsidian's tablet layout (mobile emulation) at the size of a Boox Note Air
(702 × 936 CSS pixels at 2×), with Ink Notebook's e-ink look turned on. The
handwriting is traced from a single-stroke script font
(`../scripts/handwriting.mjs`) and sent as real pen events with pressure, the
text pages are filled in by the local stand-in for Azure
(`../scripts/mock-azure.mjs`), and arXiv is a local stand-in serving made-up
papers whose PDF is made by the recorder. The tablet, the stylus, the captions,
the feature wall and the end card are drawn around the footage. The music and
sounds are synthesised (`sound.py`) – no samples, nothing to license.

| # | Clip | Shows |
| --- | --- | --- |
| 01 | Write | the pen writes a list item on a trip page and ticks a task, taps **Text** |
| 02 | Text | an e-ink refresh to the text page: heading, list, tasks, link, the flow as a live figure |
| 03 | Pens | the pen card (pens, thickness, colours, pressure, favourites), calligraphy in purple |
| 04–05 | Smart pen | a rough loop snaps into a clean ellipse; a scribble erases a word |
| 06–07 | Lasso | lasso, the action bar, move; **To text** turns the handwriting into a typed text box |
| 08 | Flowchart | a shape from the object library, an arrow attached to two shapes, a hatched fill, a shape moved with its arrows |
| 09 | Mermaid | Mermaid code typed into the dialog, drawn as ink while it grows, placed, a shape moved (the curves follow) |
| 10 | Table | a hand-drawn table becomes a Markdown table on the text page |
| 11 | arXiv | the most popular papers, **Import** |
| 12 | PDF | the paper marked up: highlighter, a circle, a note in the margin, an underline; *More → Export* |
| 13 | Paper | the paper picker, then the same page on six papers, on the beat |
| 14 | Pages | a finger swipes to the next page, the page overview |
| 24 | Wall | 24 features as tiles: erasers, Excalidraw libraries, typed notes, daily notes, the files… |
| – | End | a highlighter stroke wipes to yellow, "Ink Notebook" written by hand, "Community plugins → Browse → Ink Notebook" |

The look: a dark studio, a slowly tilting tablet, a feature counter and
headlines whose key word gets a highlighter stroke. The clips flow into each
other: at every cut the camera glides from the last view of one clip to the
first of the next, pulling back a little on the way, while the screens
cross-fade; cuts inside a clip cross-fade too, the captions hand over with an
eased slide, the last tablet eases back into the feature wall and a felt-tip
stroke wipes to the end card.

## Making it

Linux, with what `e2e/` needs (Xvfb, the Obsidian AppImage), ffmpeg, Python 3
with numpy, and a Chromium for Playwright (`CHROMIUM=/path/to/chrome`, default
`/opt/pw-browsers/chromium`).

```bash
npm run build                                   # in the repo root
cd e2e
npm install
./scripts/download.sh
SCALE=2 W=1000 H=1300 ./scripts/fresh.sh        # a fresh vault, Obsidian at twice the pixel density + mock Azure
node promo/record.mjs                           # footage → shots/promo/<scene>/ (about 5 minutes)
node promo/render.mjs                           # → shots/promo/video/ink-notebook-promo.mp4 (about 6 minutes)
node promo/render.mjs --frames 0,120,600        # or a few frames as PNGs, to look at
node promo/render.mjs --sheet 15                # or every 15th frame
```

- `rig.mjs` is the recording rig: the connection to Obsidian, a "take" that
  captures the window frame by frame in virtual time (for every frame, 1/30 s,
  it sends the input of that moment, then captures), and the stylus, a finger
  and a keyboard. So the writing has an even pace on any machine.
- `record.mjs` stages and records the scenes (`node promo/record.mjs smart,lasso`
  records some of them). Each scene gets numbered PNGs and a `manifest.json`
  with the pen (and fingers) per frame and named marks; the `still-*` scenes are
  single frames for the feature wall.
- `timeline.mjs` is the edit: which frames play and how fast (by the marks of
  the manifests), the camera, the captions and the tiles of the wall. The video
  is 80 beats of 120 bpm music and every clip lasts a whole number of beats, so
  the cuts fall on the beat; the music starts with a two-beat pickup, so the
  page turning into Markdown, the wall and the end card land on downbeats.
- `compose.html` draws one frame of the video.
- `render.mjs` renders every frame in a headless Chromium into ffmpeg, writes
  `cues.json` (the pen, taps, cuts and events per frame) and runs `sound.py`,
  which makes the music and the sounds that follow the picture (the pen
  scratching while it writes, taps, a soft whoosh as one clip flows into the
  next, the felt-tip swipe of the end card), then puts picture and sound
  together.
