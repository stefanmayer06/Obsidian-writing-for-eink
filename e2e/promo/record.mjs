// Footage for the promo video, recorded in a real Obsidian with Ink Notebook.
//
//   SCALE=2 W=1000 H=1300 ./scripts/fresh.sh   # Obsidian at twice the pixel density + mock Azure
//   node promo/record.mjs                       # every scene → e2e/shots/promo/<scene>/
//   node promo/record.mjs smart,lasso           # or some scenes (after "setup", which always runs)
//
// Obsidian runs in its tablet layout (mobile emulation) in a window the size of
// a Boox Note Air (702 × 936 CSS pixels at 2×), with Ink Notebook's e-ink look
// on. Scenes are recorded frame by frame in virtual time (see rig.mjs): real
// pen events with pressure, touch events for fingers, keystrokes for typing.
// Each scene folder gets numbered PNGs and a manifest.json with the pen (and
// fingers) per frame and named marks the edit (timeline.mjs) refers to.
//
// The handwriting is traced from a single-stroke script font
// (../scripts/handwriting.mjs), the text page is filled in by the local stand-in
// for Azure (../scripts/mock-azure.mjs), and arXiv is a local stand-in serving
// made-up papers whose PDF is made here – everything else is the plugin.
import fs from "fs";
import http from "http";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { handwriting, handLine } from "../scripts/handwriting.mjs";
import * as R from "./rig.mjs";
import { Take, ev, sleep, mapping, write, travel, tapAt, tapEl, centre, swipe, typeText, setSettings, closeModals, closePopovers, waitView, openFile, tidyWorkspace, tool, recognise, remove, newInkPage, addInk, paper, flat, along, ellipse, rect, oval, sid, FPS, VAULT, OUT, MOCK, WIN } from "./rig.mjs";

const only = process.argv[2];
await R.connect();
const page = () => R.rig.page;
const ACTIVE = ".workspace-leaf.mod-active";

/** Handwriting as ink items. */
const hw = (text, x, y, seed, opts = {}) => handwriting(text, { x, y, size: opts.size ?? 2.0, seed, ...opts }).strokes.map((pts) => ({ pts, ...(opts.color ? { color: opts.color } : {}), ...(opts.pen ? { pen: opts.pen } : {}), ...(opts.width ? { width: opts.width } : {}) }));
/** Handwriting as strokes for the pen to write. */
const hs = (text, x, y, seed, opts = {}) => handwriting(text, { x, y, size: opts.size ?? 2.0, seed, ...opts }).strokes;
const hwidth = (text, size, seed) => handwriting(text, { size, seed }).width;
const handBox = (x, y, s, seed) => ({ pts: handLine([[x, y], [x + s, y + 0.5], [x + s - 0.5, y + s], [x + 0.5, y + s - 0.5], [x, y + 1.5]], { seed, step: 1.5, rounds: 0, wobble: 0.5 }) });
const tick = (x, y, seed, k = 1) => handLine([[x + 3 * k, y + 11 * k], [x + 13 * k, y + 25 * k], [x + 40 * k, y - 14 * k]], { seed, step: 1.2, rounds: 0 });

const scenes = {};

/** After a tap on "Text": wait for the text page (and its live figures), print it. */
async function textPage(file) {
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const v = await ev(() => ({ type: __t.view()?.getViewType(), file: __t.view()?.file?.path }));
    if (v.type === "markdown" && v.file === file) break;
    await sleep(250);
  }
  const v = await ev(() => ({ type: __t.view()?.getViewType(), file: __t.view()?.file?.path }));
  if (v.type !== "markdown") {
    console.log("    (the tap did not flip the page; flipping with the command)", JSON.stringify(v), JSON.stringify(await (await fetch(`${MOCK}/__stats`)).json()).slice(0, 300));
    await ev(() => app.commands.executeCommandById("ink-notebook:flip-page"));
  }
  await waitView("markdown", file);
  await ev(async () => __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-figure canvas"), 8000, "figure").catch(() => null));
  await sleep(1500);
  console.log((await ev((p) => __t.read(p), file)).replace(/^/gm, "    | "));
  const stats = await (await fetch(`${MOCK}/__stats`)).json();
  console.log("    mock saw:", JSON.stringify(stats.lastImages.map((i) => ({ size: [i.width, i.height], lines: i.lines, texts: i.texts, boxes: i.boxes }))));
}

// ---------------------------------------------------------------- setup

scenes.setup = async () => {
  console.log("▶ setup");
  if (!(await ev(() => app.isMobile))) {
    // the tablet layout of Obsidian (as on a Boox); Obsidian reloads its window
    await ev(() => setTimeout(() => app.emulateMobile(true), 50));
    await sleep(9000);
    await R.attach();
  }
  await R.installHelpers();
  await R.setWindow(WIN.w, WIN.h);
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "on", lowLatency: "off", fit: "width", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "Attachments", askForPaper: false, askForPageName: false, holdToShape: true, scribbleErase: true, textViewMode: "reading", papersFolder: "Papers" });
  await ev(() => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    // the text page starts with what was written (the name of the note is in the tab and the path)
    app.vault.setConfig("showInlineTitle", false);
    document.getElementById("ink-promo-css")?.remove();
    const style = document.head.createEl("style", { attr: { id: "ink-promo-css" } });
    // no notices or status bar in the footage, no blinking text cursor, no band for the Android status bar
    style.textContent = "body { --safe-area-inset-top: 0px !important; --safe-area-inset-bottom: 0px !important; } .notice-container, .status-bar { display: none !important; } * { caret-color: transparent !important; }";
  });
  await closeModals();
  await tidyWorkspace();
  await R.mock({ reset: true, mode: "ok", responses: [], fallback: null });
  console.log("  ", await ev(() => ({ mobile: app.isMobile, tablet: document.body.classList.contains("is-tablet"), w: innerWidth, h: innerHeight, dpr: devicePixelRatio })));
};

// ---------------------------------------------------------------- write + text: the hook

/** Wide ruled paper: lines at y = 140 + 56k, the margin at x = 112. */
const S = 56;
const L = (k) => S * 2.5 + S * k;
const X0 = 138;
const TRIP = { name: "Lisbon weekend", ink: "Ink/Attachments/Lisbon weekend.ink.md", text: "Ink/Lisbon weekend.md" };

/** The ink page of the trip, as it is before the pen writes the last line. */
async function tripPage() {
  fs.mkdirSync(path.join(VAULT, "People"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "People", "Mia.md"), "# Mia\n\nTravels light, plans everything.\n");
  await sleep(500);
  await newInkPage(TRIP.name);
  await ev((bg) => __t.surface().setBackground(bg), paper("lined", "white", "wide"));
  const ink = [
    ...hw("Lisbon trip", X0, L(2) + 4, 101, { size: 4.9 }),
    ...hw("Trip with [[Mia]] and Leo.", X0, L(4) - 4, 102),
    ...hw("- Fri: fly out at 8:40", X0, L(6) - 4, 103),
    ...hw("- Sat: tram 28 to Belem", X0, L(7) - 4, 104),
  ];
  // two tasks: a box drawn in front of the line
  [L(10), L(11)].forEach((y, i) => ink.push(handBox(X0 + 2, y - 30, 28, 110 + i)));
  ink.push(...hw("book the hotel", X0 + 52, L(10) - 4, 112), ...hw("pack the camera", X0 + 52, L(11) - 4, 113));
  // a small flow of places: shapes with handwritten names, arrows attached to them
  const y0 = L(13) - 4;
  const places = [
    { x: X0, w: 220, label: "Airport", kind: "oval" },
    { x: X0 + 300, w: 200, label: "Hotel", kind: "rect" },
    { x: X0 + 580, w: 210, label: "Belem", kind: "rect", fill: "#ffd8a8" },
  ].map((b) => ({ ...b, id: sid("place") }));
  const shapes = places.map((b) => (b.kind === "oval" ? oval(b.x + b.w / 2, y0 + 50, b.w / 2, 50, { id: b.id }) : rect(b.x, y0, b.w, 100, { id: b.id, ...(b.fill ? { fill: b.fill } : {}) })));
  for (const b of places) {
    const lw = hwidth(b.label, 2.2, b.x);
    shapes.push(...hw(b.label, b.x + (b.w - lw) / 2, y0 + 64, b.x, { size: 2.2 }));
  }
  for (const i of [0, 1]) shapes.push({ pts: flat([[places[i].x + places[i].w, y0 + 50], [places[i + 1].x, y0 + 50]]), poly: true, arrow: true, from: places[i].id, to: places[i + 1].id });
  await addInk([...ink, ...shapes]);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(1200);
}

scenes.write = async () => {
  console.log("▶ write: handwriting on the ink page, then Text");
  await tripPage();
  const take = new Take("write");
  const m = await mapping();
  take.pen = { ...m.at(X0 + 30, L(8) - 60), down: false };
  await take.frame();
  take.hold(4);
  take.mark("writeStart");
  await write(take, hs("- Sun: pastries at 9", X0, L(8) - 4, 105), { speed: 820, m });
  take.mark("writeEnd");
  // tick the second task, the way a hand ticks a box
  await write(take, [tick(X0 + 2, L(11) - 30, 9)], { speed: 420, m });
  take.mark("tickEnd");
  take.hold(4);
  await sleep(2500); // the page is saved (a save while the pen taps would swallow the tap)
  await recognise(
    ["Lisbon trip", "Trip with [[Mia]] and Leo.", "- Fri: fly out at 8:40", "- Sat: tram 28 to Belem", "- Sun: pastries at 9", "D book the hotel", "D pack the camera", "Airport Hotel Belem"],
    ["Belem"],
    ["Airport", "Hotel", "Belem"],
  );
  const btn = await centre(`${ACTIVE} .ink-tb-text`);
  take.mark("tapText");
  await tapAt(take, btn.x, btn.y, { sec: 0.45 });
  take.hold(2);
  take.save({ button: btn });

  // the text page
  await textPage(TRIP.text);
  const text = new Take("text");
  text.pen = { x: btn.x, y: btn.y, down: false };
  await text.frame();
  text.hold(FPS * 3);
  text.save();
};

// ---------------------------------------------------------------- smart pen: hold to snap, scribble to erase

scenes.smart = async () => {
  console.log("▶ smart: hold to snap, scribble to erase");
  await newInkPage("App names");
  await ev((bg) => __t.surface().setBackground(bg), paper("dots"));
  const words = [
    { t: "Inkwell", x: 200, y: 470, seed: 201 },
    { t: "Quill", x: 600, y: 430, seed: 202 },
    { t: "Papertrail", x: 150, y: 680, seed: 203 },
    { t: "Notely", x: 610, y: 650, seed: 204 },
    { t: "Scribe", x: 420, y: 860, seed: 205 },
  ];
  await addInk([...hw("App names?", X0, 250, 200, { size: 3.2 }), ...words.flatMap((w) => hw(w.t, w.x, w.y, w.seed, { size: 2.5 }))]);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(800);
  const take = new Take("smart");
  const m = await mapping();
  // a rough loop around "Inkwell": the pen rests at its end and it snaps into a clean ellipse
  const iw = hwidth("Inkwell", 2.5, 201);
  const cx = 200 + iw / 2;
  const cy = 470 - 18;
  take.pen = { ...m.at(cx - 40, cy + 140), down: false };
  await take.frame();
  take.hold(4);
  take.mark("loop");
  // lopsided and overshooting, the way a quick hand circles a word
  const rough = [];
  for (let i = 0; i <= 52; i++) {
    const a = Math.PI * 0.9 + (i / 48) * Math.PI * 2;
    const k = 1 + 0.08 * Math.sin(2 * a + 0.7) + 0.05 * Math.sin(3 * a + 2) + (i > 45 ? 0.016 * (i - 45) : 0);
    rough.push([cx + (iw / 2 + 46) * k * Math.cos(a), cy + 64 * k * Math.sin(a)]);
  }
  const loop = handLine(rough, { seed: 211, step: 2, wobble: 2.2 });
  await write(take, [loop], { speed: 1100, m, hold: 700, holdFrames: 1 });
  take.mark("snapped");
  take.hold(10);
  // "Notely": scratched out
  const nw = hwidth("Notely", 2.5, 204);
  const x0 = 600, x1 = 610 + nw + 10, yT = 650 - 52, yB = 650 + 14;
  const zig = [];
  for (let i = 0; i <= 9; i++) {
    const y = yT + ((yB - yT) * i) / 9;
    zig.push(i % 2 ? [x0 + 6 * Math.sin(i), y] : [x1 - 6 * Math.cos(i), y]);
  }
  take.mark("scribble");
  await write(take, [flat(along(zig, 5), 0.6)], { speed: 2600, m });
  take.mark("erased");
  take.hold(14);
  take.save();
};

// ---------------------------------------------------------------- lasso: select, move, to text

scenes.lasso = async () => {
  console.log("▶ lasso: select, move, To text");
  await newInkPage("Launch plan");
  await ev((bg) => __t.surface().setBackground(bg), paper("grid", "white"));
  await addInk([
    ...hw("Launch plan", X0, 230, 301, { size: 3.0 }),
    ...hw("- polish the onboarding", X0, 340, 302),
    ...hw("- record the demo video", X0, 400, 303),
    ...hw("- write the release notes", X0, 460, 304),
    ...hw("Ship it on Friday!", 190, 700, 305, { size: 2.9, color: "#1565c0" }),
  ]);
  await sleep(800);
  await tool({ tool: "lasso" });
  await sleep(300);
  const take = new Take("lasso");
  const m = await mapping();
  const sw = hwidth("Ship it on Friday!", 2.9, 305);
  const cx = 190 + sw / 2;
  const cy = 700 - 24;
  take.pen = { ...m.at(cx + 60, cy + 200), down: false };
  await take.frame();
  take.hold(4);
  take.mark("loop");
  await write(take, [flat(ellipse(cx, cy, sw / 2 + 50, 70, 1.1, Math.PI * 0.85), 0.5)], { speed: 1500, m });
  await sleep(300);
  await take.frame();
  take.mark("selected");
  take.hold(6);
  // drag it up, next to the list
  const dx = 60, dy = -95;
  take.mark("drag");
  await write(take, [flat(along([[cx, cy], [cx + dx * 0.5, cy + dy * 0.62], [cx + dx, cy + dy]], 4), 0.5)], { speed: 600, m });
  await sleep(300);
  await take.frame();
  take.mark("moved");
  take.hold(5);
  // To text: the mock Azure reads it
  await recognise(["Ship it on Friday!"]);
  const btn = await ev(() => {
    const b = [...document.querySelectorAll(".ink-sel-bar button, .ink-selection-bar button, [class*='ink-sel'] button")].find((x) => /To text/.test(x.getAttribute("aria-label") ?? x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!btn) throw new Error("no To text button");
  take.mark("tapToText");
  await tapAt(take, btn.x, btn.y, { sec: 0.35 });
  await ev(async () => __t.waitFor(() => __t.surface().page.texts.some((t) => /Friday/.test(t.text)), 10000, "typed text"));
  await sleep(400);
  await take.frame();
  take.mark("typed");
  take.hold(14);
  take.save();
  await tool({ tool: "pen" });
};

// ---------------------------------------------------------------- flowchart: library shapes, attached arrows, fill

const PANEL = `${ACTIVE} .ink-library-panel`;

/** Open the object library on one of its sources. */
async function openLibrary(source) {
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  await page().waitForSelector(PANEL, { timeout: 5000 });
  await page().click(`${PANEL} .ink-library-source[aria-label='${source}']`);
  await sleep(500);
  await unfoldLibrary();
}

async function unfoldLibrary() {
  await ev(() => {
    const p = document.querySelector(".workspace-leaf.mod-active .ink-library-panel");
    if (p?.classList.contains("is-folded")) p.querySelector(".ink-library-fold").click();
  });
  await sleep(300);
}

/** A tap at a page point without recording it (staging). */
async function quietTap(x, y) {
  const m = await mapping();
  const s = m.at(x, y);
  const base = { pointerType: "pen", button: "left", buttons: 1 };
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, pointerType: "pen", buttons: 0, force: 0 });
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s.x, y: s.y, clickCount: 1, force: 0.5, ...base });
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: s.x, y: s.y, clickCount: 1, force: 0, ...base, buttons: 0 });
  await sleep(150);
}

/** A drag at page points without recording it (staging: arrows). */
async function quietDrag(pts) {
  const m = await mapping();
  const base = { pointerType: "pen", button: "left", buttons: 1 };
  const s0 = m.at(...pts[0]);
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: 0, force: 0 });
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: 0.5, ...base });
  for (const p of pts.slice(1)) await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...m.at(...p), force: 0.5, ...base });
  const e = m.at(...pts[pts.length - 1]);
  await R.rig.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: e.x, y: e.y, clickCount: 1, force: 0, ...base, buttons: 0 });
  await sleep(150);
}

/** A label typed into a shape with the Text tool (staging). */
async function label(x, y, text) {
  await tool({ tool: "text" });
  await quietTap(x, y);
  await sleep(200);
  await page().keyboard.type(text);
  await page().keyboard.press("Escape");
  await sleep(150);
}

scenes.flow = async () => {
  console.log("▶ flow: flowchart shapes from the library, attached arrows, fill, move");
  await newInkPage("Release flow");
  await ev((bg) => __t.surface().setBackground(bg), paper("dots"));
  await openLibrary("Flowchart");
  const place = async (tile, x, y) => {
    await page().click(`${PANEL} .ink-library-tile[aria-label='${tile}']`);
    await quietTap(x, y);
    await unfoldLibrary();
  };
  const cx = 250;
  await place("Start / end", cx, 200);
  await place("Process", cx, 400);
  await place("Decision", cx, 630);
  await place("Start / end", cx, 880);
  await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-library-panel .ink-library-close")?.click());
  await tool({ tool: "shape", shape: "arrow" });
  for (const [a, b] of [[200, 400], [400, 630], [630, 880]]) await quietDrag(along([[cx, a], [cx, b]], 8));
  await label(cx, 200, "Idea");
  await label(cx, 400, "Build it");
  await label(cx, 630, "Tests pass?");
  await label(cx, 880, "Ship it");
  await label(cx + 16, 755, "yes");
  await tool({ tool: "pen" });
  await sleep(500);
  // the library is open next to the page when the take starts
  await openLibrary("Flowchart");
  await sleep(600);

  await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-library-panel .ink-library-tile[aria-label='Database']")?.scrollIntoView({ block: "center" }));
  await sleep(400);
  const take = new Take("flow");
  const m = await mapping();
  const tile = await centre(`${PANEL} .ink-library-tile[aria-label='Database']`);
  take.pen = { x: tile.x - 70, y: tile.y + 150, down: false };
  await take.frame();
  take.hold(4);
  take.mark("tapTile");
  await tapAt(take, tile.x, tile.y, { sec: 0.35 });
  await sleep(300);
  await take.frame();
  // the library folds away while placing: tap the page
  const db = { x: 640, y: 880 };
  take.mark("place");
  const sp = m.at(db.x, db.y);
  await tapAt(take, sp.x, sp.y, { sec: 0.4 });
  await sleep(400);
  await take.frame();
  take.mark("placed");
  take.hold(4);
  // an arrow from "Ship it" to the database: it attaches to both
  await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-library-panel .ink-library-close")?.click());
  await tool({ tool: "shape", shape: "arrow" });
  await sleep(200);
  await take.frame();
  take.mark("arrow");
  await write(take, [flat(along([[cx + 60, 880], [db.x - 40, 880]], 6), 0.5)], { speed: 900, m });
  await sleep(300);
  await take.frame();
  take.mark("arrowEnd");
  take.hold(3);
  // fill the decision: blue, hatched
  await tool({ tool: "fill", fillColor: "#1565c0", fillStyle: "hatch" });
  await sleep(200);
  take.mark("fill");
  const dp = m.at(cx - 40, 655);
  await tapAt(take, dp.x, dp.y, { sec: 0.35 });
  await sleep(300);
  await take.frame();
  take.mark("filled");
  take.hold(3);
  // the lasso moves "Build it": its arrows follow
  await tool({ tool: "lasso" });
  await sleep(200);
  take.mark("lasso");
  await write(take, [flat(ellipse(cx, 400, 150, 72, 1.1, Math.PI * 0.9), 0.5)], { speed: 1800, m });
  await sleep(300);
  await take.frame();
  take.mark("drag");
  await write(take, [flat(along([[cx, 400], [cx + 120, 410], [cx + 250, 420]], 4), 0.5)], { speed: 700, m });
  await sleep(300);
  await take.frame();
  take.mark("moved");
  take.hold(4);
  await quietTap(900, 1100);
  await sleep(200);
  await take.frame();
  take.hold(10);
  take.save();
  await tool({ tool: "pen" });
};

// ---------------------------------------------------------------- Mermaid → ink

const COFFEE = `flowchart TD
  A([Alarm rings]) --> B{Snooze?}
  B -- yes --> A
  B -- no --> C[Make coffee]
  C --> D{Beans left?}
  D -- no --> E[Buy beans]
  D -- yes --> F[Brew a cup]
  E --> F
  F --> G([Start the day])
  classDef warm fill:#FFE8CC,stroke:#C2410C,color:#7C2D12
  class C,F warm`;

scenes.mermaid = async () => {
  console.log("▶ mermaid: type Mermaid, get ink");
  fs.rmSync(path.join(VAULT, "Ink libraries", "Mermaid"), { recursive: true, force: true });
  await sleep(500);
  await newInkPage("Mornings");
  await ev((bg) => __t.surface().setBackground(bg), paper("blank"));
  await ev(() => app.commands.executeCommandById("ink-notebook:add-mermaid"));
  await page().waitForSelector(".ink-mermaid-modal .ink-mermaid-code", { timeout: 5000 });
  await ev(() => {
    const ta = document.querySelector(".ink-mermaid-modal .ink-mermaid-code");
    ta.value = "";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  });
  await sleep(500);
  const take = new Take("mermaid");
  take.pen = { x: 560, y: 760, down: false };
  await take.frame();
  take.hold(3);
  take.mark("type");
  // typed (or pasted): the preview draws the diagram as ink while it grows
  const lines = COFFEE.split("\n");
  for (let i = 0; i < lines.length; i++) {
    await typeText(take, lines[i] + (i < lines.length - 1 ? "\n" : ""), { perFrame: 7 });
    await sleep(120);
    await take.frame();
  }
  await page().waitForFunction(() => /shapes/.test(document.querySelector(".ink-mermaid-status")?.textContent ?? ""), null, { timeout: 5000 });
  await sleep(500);
  await take.frame();
  take.mark("typed");
  take.hold(8);
  console.log("   ", await ev(() => document.querySelector(".ink-mermaid-status").textContent));
  // the dialog has grown with the preview: bring its buttons into view
  await ev(() => document.querySelector(".ink-mermaid-modal button.mod-cta").scrollIntoView({ block: "end" }));
  await sleep(300);
  await take.frame();
  take.hold(2);
  take.mark("add");
  await tapEl(take, ".ink-mermaid-modal button.mod-cta", { sec: 0.4 });
  await ev(async () => __t.waitFor(() => !document.querySelector(".ink-mermaid-modal") && __t.surface()?.tools.tool === "stamp", 8000, "placing the diagram").catch(() => null));
  console.log("    placing:", JSON.stringify(await ev(() => ({ tool: __t.surface()?.tools.tool, modal: !!document.querySelector(".ink-mermaid-modal"), panel: !!document.querySelector(".workspace-leaf.mod-active .ink-library-panel") }))));
  await sleep(400);
  await take.frame();
  take.hold(2);
  // ready to be placed: a tap on the page
  const m = await mapping();
  const at = m.at(470, 560);
  take.mark("place");
  await tapAt(take, at.x, at.y, { sec: 0.4 });
  await sleep(700);
  await take.frame();
  take.mark("placed");
  take.hold(6);
  // the lasso moves one of its shapes: the curved arrows follow
  await tool({ tool: "lasso" });
  const box = await ev(() => {
    const p = __t.surface().page;
    const t = p.texts.find((t) => /Buy beans/.test(t.text));
    const st = p.strokes.find((s) => s.id === t.container);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < st.pts.length; i += 3) {
      x0 = Math.min(x0, st.pts[i]); x1 = Math.max(x1, st.pts[i]);
      y0 = Math.min(y0, st.pts[i + 1]); y1 = Math.max(y1, st.pts[i + 1]);
    }
    return { x0, y0, x1, y1 };
  });
  const bx = (box.x0 + box.x1) / 2;
  const by = (box.y0 + box.y1) / 2;
  take.mark("lasso");
  await write(take, [flat(ellipse(bx, by, (box.x1 - box.x0) / 2 + 24, (box.y1 - box.y0) / 2 + 22, 1.12, Math.PI * 0.95), 0.5)], { speed: 1500, m });
  await sleep(300);
  await take.frame();
  take.mark("drag");
  await write(take, [flat(along([[bx, by], [bx - 90, by + 10], [bx - 170, by + 30]], 4), 0.5)], { speed: 600, m });
  await sleep(300);
  await take.frame();
  take.mark("moved");
  take.hold(8);
  await quietTap(80, 1100);
  await sleep(200);
  await take.frame();
  take.hold(8);
  take.save();
  await tool({ tool: "pen" });
};

// ---------------------------------------------------------------- a hand-drawn table → a Markdown table

const COFFEE_LOG = { name: "Coffee log", ink: "Ink/Attachments/Coffee log.ink.md", text: "Ink/Coffee log.md" };

scenes.table = async () => {
  console.log("▶ table: a hand-drawn table becomes a Markdown table");
  await newInkPage(COFFEE_LOG.name);
  await ev((bg) => __t.surface().setBackground(bg), paper("dots"));
  const cols = [X0, 410, 720];
  const rows = [400, 500, 590, 680];
  const cells = [
    ["Bean", "Origin", "Score"],
    ["Gesha", "Panama", "9"],
    ["Huila", "Colombia", "8"],
    ["Sidamo", "Ethiopia", "10"],
  ];
  const ink = [...hw("Coffee log", X0, 270, 401, { size: 4.3 })];
  cells.forEach((r, i) => r.forEach((c, j) => {
    if (i === 3 && j === 2) return; // written by the pen in the take
    ink.push(...hw(c, cols[j] + 14, rows[i], 410 + i * 3 + j, { size: 2.2 }));
  }));
  // the rule under the header and the lines between the columns, drawn by hand
  ink.push({ pts: handLine([[X0 - 10, 432], [880, 434]], { seed: 430, step: 3, wobble: 0.8 }), width: 2 });
  ink.push({ pts: handLine([[cols[1] - 14, 340], [cols[1] - 13, 712]], { seed: 431, step: 3, wobble: 0.8 }), width: 2 });
  ink.push({ pts: handLine([[cols[2] - 14, 340], [cols[2] - 15, 712]], { seed: 432, step: 3, wobble: 0.8 }), width: 2 });
  ink.push(...hw("- V60, 15 g to 250 ml", X0, 830, 440, { size: 2.2 }), ...hw("- next: try a Kenya!", X0, 900, 441, { size: 2.2, color: "#1565c0" }));
  await addInk(ink);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(800);
  const take = new Take("table");
  const m = await mapping();
  take.pen = { ...m.at(cols[2] + 60, rows[3] - 80), down: false };
  await take.frame();
  take.hold(3);
  take.mark("write");
  // "1" and "0" close together, so that they read as one word
  await write(take, [...hs("1", cols[2] + 14, rows[3], 419, { size: 2.2 }), ...hs("0", cols[2] + 36, rows[3], 420, { size: 2.2 })], { speed: 700, m });
  take.mark("written");
  take.hold(3);
  await sleep(2500);
  await recognise(["Coffee log", "Bean Origin Score", "Gesha Panama 9", "Huila Colombia 8", "Sidamo Ethiopia 10", "- V60, 15 g to 250 ml", "- next: try a Kenya!"]);
  const btn = await centre(`${ACTIVE} .ink-tb-text`);
  take.mark("tapText");
  await tapAt(take, btn.x, btn.y, { sec: 0.45 });
  take.hold(2);
  take.save({ button: btn });
  await textPage(COFFEE_LOG.text);
  const text = new Take("tabletext");
  text.pen = { x: btn.x, y: btn.y, down: false };
  await text.frame();
  text.hold(FPS * 2);
  text.save();
};

// ---------------------------------------------------------------- arXiv, then marking up the paper

const PAPERS_URL = "http://127.0.0.1:8769";
const PAPER = {
  id: "2610.04127",
  title: "Pens Beat Keyboards: Handwriting and Long-Term Recall",
  authors: ["Maya Okafor", "Lukas Brandt", "Sora Ito"],
  summary:
    "Students who take notes by hand remember more than those who type – but why? We followed 412 students through a semester and found that handwritten notes were shorter, more selective and better organised. One week after a lecture, students who wrote by hand recalled 34% more key ideas. The advantage held when notes were written on a tablet, which suggests that the act of writing, not the paper, drives the effect.",
};
const OTHER_PAPERS = [
  { id: "2610.03311", title: "Sketch2Flow: Turning Whiteboard Photos into Editable Flowcharts", authors: ["Priya Raman", "Tomás Vidal", "Ines Moreau"], summary: "We present a model that reads photos of hand-drawn diagrams and returns editable shapes, labels and connectors. On a new benchmark of 9,000 whiteboard photos it recovers 91% of the connections, enough to edit most diagrams without redrawing them." },
  { id: "2610.02958", title: "Paper-Like Displays at 60 Hz: Fast Refresh for Colour E-Ink", authors: ["Hannah Weiss", "Kenji Mori"], summary: "Colour e-paper is pleasant to read but slow to update. A new driving scheme cuts the latency of partial updates to 16 ms while keeping ghosting below the threshold of perception, making writing with a stylus feel immediate." },
  { id: "2610.01874", title: "Tiny Experts: Sparse Language Models That Run on a Tablet", authors: ["Omar Haddad", "Julia Novak", "Chen Wei"], summary: "Mixtures of very small experts reach the quality of dense models eight times their size while using a fraction of the memory, so that a capable assistant fits on an e-reader." },
  { id: "2610.00592", title: "Forgetting Curves in the Age of Search", authors: ["Elif Sahin", "Marco Rossi"], summary: "Why remember what you can look up? A year-long diary study of how people decide what to keep in their heads, in their notes and in a search box." },
];

/** The paper's PDF: a first page as a preprint looks (made up, made here). */
async function paperPdf() {
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const lines = [];
  const W = 595, H = 842, X = 72, COL = 451;
  const pg = doc.addPage([W, H]);
  let y = 760;
  const centred = (t, font, size, color = rgb(0.08, 0.08, 0.08)) => {
    const w = font.widthOfTextAtSize(t, size);
    pg.drawText(t, { x: (W - w) / 2, y, size, font, color });
    lines.push({ t, x: (W - w) / 2, y, size, font });
  };
  const para = (t, { size = 10.5, lead = 14.2, font = serif, x = X, width = COL } = {}) => {
    let cur = "";
    const flush = () => {
      pg.drawText(cur, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      lines.push({ t: cur, x, y, size, font });
      y -= lead;
    };
    for (const w of t.split(" ")) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width) {
        flush();
        cur = w;
      } else cur = next;
    }
    if (cur) flush();
    y -= 6;
  };
  const heading = (t) => {
    pg.drawText(t, { x: X, y, size: 12, font: serifBold, color: rgb(0.06, 0.06, 0.06) });
    lines.push({ t, x: X, y, size: 12, font: serifBold });
    y -= 19;
  };
  pg.drawText("arXiv:2610.04127v1  [cs.HC]  29 Oct 2026", { x: 22, y: 300, size: 11, font: serif, color: rgb(0.55, 0.55, 0.55), rotate: { type: "degrees", angle: 90 } });
  centred("Pens Beat Keyboards:", serifBold, 19);
  y -= 24;
  centred("Handwriting and Long-Term Recall", serifBold, 19);
  y -= 30;
  centred("Maya Okafor     Lukas Brandt     Sora Ito", serif, 12);
  y -= 16;
  centred("Northfield University, Department of Learning Sciences", serifItalic, 10.5, rgb(0.3, 0.3, 0.3));
  y -= 36;
  centred("Abstract", serifBold, 11.5);
  y -= 18;
  para(PAPER.summary, { size: 10, lead: 13.6, x: X + 30, width: COL - 60 });
  y -= 10;
  heading("1   Introduction");
  para("Laptops and tablets have replaced paper in many lecture halls. Typing is fast, so students capture more of what is said – yet several studies found that they remember less of it. A common explanation is that typing invites verbatim transcription, while writing by hand is slow enough to force a summary.");
  para("We test this explanation in a semester-long field study with three groups: students who typed, students who wrote on paper and students who wrote with a stylus on an e-ink tablet.");
  y -= 4;
  heading("2   Results");
  para("Figure 1 shows recall one week after each lecture. Both handwriting groups outperformed the typing group; the difference between paper and tablet was small and not significant.");
  // Figure 1: a small bar chart
  const fy = y - 120;
  const bars = [["Typed", 0.48], ["Paper", 0.66], ["Tablet", 0.64]];
  pg.drawLine({ start: { x: X + 80, y: fy }, end: { x: X + 380, y: fy }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
  pg.drawLine({ start: { x: X + 80, y: fy }, end: { x: X + 80, y: fy + 112 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
  bars.forEach(([name, v], i) => {
    const bx = X + 115 + i * 92;
    pg.drawRectangle({ x: bx, y: fy, width: 50, height: v * 150, color: i === 0 ? rgb(0.72, 0.72, 0.72) : rgb(0.25, 0.25, 0.25) });
    const w = serif.widthOfTextAtSize(name, 9.5);
    pg.drawText(name, { x: bx + 25 - w / 2, y: fy - 13, size: 9.5, font: serif, color: rgb(0.15, 0.15, 0.15) });
    lines.push({ t: name, x: bx + 25 - w / 2, y: fy - 13, size: 9.5, font: serif });
  });
  y = fy - 32;
  centred("Figure 1: Key ideas recalled after one week (share of all ideas).", serifItalic, 9.5, rgb(0.25, 0.25, 0.25));
  pg.drawText("1", { x: W / 2 - 3, y: 40, size: 10, font: serif, color: rgb(0.3, 0.3, 0.3) });
  return { bytes: await doc.save(), lines };
}

/** A local stand-in for arXiv and Hugging Face Papers: made-up papers, our PDF. */
async function papersServer(pdfBytes) {
  const all = [PAPER, ...OTHER_PAPERS];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, PAPERS_URL);
    if (url.pathname === "/daily_papers") {
      const p = Number(url.searchParams.get("p") ?? 0);
      const items = p > 0 ? [] : all.map((x, i) => ({ paper: { id: x.id, title: x.title, summary: x.summary, authors: x.authors.map((name) => ({ name })), publishedAt: `2026-10-${29 - i}T00:00:00.000Z`, upvotes: 412 - i * 57 } }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(items));
    } else if (url.pathname.startsWith("/pdf/")) {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(pdfBytes));
    } else if (url.pathname === "/api/query") {
      res.writeHead(200, { "content-type": "application/atom+xml" });
      res.end(`<?xml version='1.0' encoding='UTF-8'?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>`);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(8769, "127.0.0.1", r));
  return server;
}

const PAPER_NAME = "Pens Beat Keyboards - Handwriting and Long-Term Recall";

scenes.arxiv = async () => {
  console.log("▶ arxiv: the most popular papers, Import, then marking it up");
  await remove(`Papers/Attachments/${PAPER_NAME}.ink.md`, `Papers/Attachments/${PAPER_NAME}.pdf`, `Papers/${PAPER_NAME}.md`);
  const { bytes, lines } = await paperPdf();
  const server = await papersServer(bytes);
  try {
    await ev((base) => Object.assign(__t.plugin().papers.endpoints, { arxivApi: `${base}/api/query`, arxivSite: base, popular: `${base}/daily_papers` }), PAPERS_URL);
    // start from the trip notes (any page will do)
    await openFile(TRIP.ink, "ink-notebook");
    await tidyWorkspace();
    await ev(() => app.commands.executeCommandById("ink-notebook:import-arxiv"));
    await ev(async () => __t.waitFor(() => document.querySelectorAll(".ink-arxiv-card").length >= 4 && !document.querySelector(".ink-arxiv-status span"), 20000, "papers"));
    await ev(() => document.activeElement?.blur());
    await sleep(800);
    const take = new Take("arxiv");
    const imp = await centre(".ink-arxiv-card:nth-of-type(1) .ink-arxiv-import");
    take.pen = { x: imp.x - 150, y: imp.y + 300, down: false };
    await take.frame();
    take.hold(10);
    take.mark("tapImport");
    await tapAt(take, imp.x, imp.y, { sec: 0.7 });
    await waitView("ink-notebook", `Papers/Attachments/${PAPER_NAME}.ink.md`);
    await tidyWorkspace();
    await ev(async (name) => __t.waitFor(() => __t.plugin().images.pdfPage(`Papers/Attachments/${name}.pdf`, 1, 100), 10000, "pdf page").catch(() => null), PAPER_NAME);
    await tool({ tool: "pen", pen: "fountain", color: "#000000" });
    await sleep(1500);
    await take.frame();
    take.mark("opened");
    take.hold(24);
    take.save();
    await markUp(lines);
  } finally {
    server.close();
  }
};

/** The paper on its ink page: highlight, circle, a note in the margin, then the export menu. */
async function markUp(lines) {
  const k = await ev(() => __t.surface().page.w / 595);
  const P = (x, y) => [x * k, (842 - y) * k];
  const span = (phrase) => {
    const l = lines.find((l) => l.t.includes(phrase));
    if (!l) throw new Error(`no line with "${phrase}" in:\n${lines.map((x) => x.t).join("\n")}`);
    const x0 = l.x + l.font.widthOfTextAtSize(l.t.slice(0, l.t.indexOf(phrase)), l.size);
    return { x0, x1: x0 + l.font.widthOfTextAtSize(phrase, l.size), y: l.y, size: l.size };
  };
  const take = new Take("pdf");
  const m = await mapping();
  const h1 = span("students who wrote by hand recalled 34% more");
  const [hx0, hy] = P(h1.x0 - 1, h1.y + 3.2);
  const [hx1] = P(h1.x1 + 1, h1.y);
  take.pen = { ...m.at(hx0 + 80, hy + 140), down: false };
  await take.frame();
  take.hold(3);
  // the highlighter
  take.mark("marker");
  await tapEl(take, `${ACTIVE} .ink-tool-marker`, { sec: 0.4 });
  await take.frame();
  await write(take, [handLine([[hx0, hy], [hx1, hy - 1]], { seed: 501, wobble: 0.5 })], { speed: 1300, m });
  take.mark("markerEnd");
  take.hold(2);
  // the pen, in red: circle "34%", a note in the margin with an arrow
  await tapEl(take, `${ACTIVE} .ink-tool-pen`, { sec: 0.35 });
  await tool({ tool: "pen", pen: "fountain", color: "#d32f2f" });
  await take.frame();
  const f = span("34%");
  const [fx0, fy] = P(f.x0, f.y + 3.5);
  const [fx1] = P(f.x1, f.y);
  take.mark("circle");
  await write(take, [handLine(ellipse((fx0 + fx1) / 2, fy, (fx1 - fx0) / 2 + 13, 17), { seed: 506, step: 1.5 })], { speed: 900, m });
  take.hold(2);
  take.mark("note");
  // the right margin of the abstract
  const noteX = P(500, 0)[0];
  await write(take, hs("wow!", noteX + 10, fy + 70, 502, { size: 2.3 }), { speed: 800, m });
  const a0 = [noteX + 20, fy + 40];
  const a1 = [fx1 + 22, fy + 6];
  const ang = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]);
  const head = (da) => [a1[0] - 16 * Math.cos(ang + da), a1[1] - 16 * Math.sin(ang + da)];
  await write(take, [handLine([a0, [(a0[0] + a1[0]) / 2 + 4, (a0[1] + a1[1]) / 2 + 8], a1], { seed: 505, step: 1.5 }), handLine([head(0.5), a1, head(-0.5)], { seed: 507, step: 1.2, rounds: 0 })], { speed: 900, m });
  // underline the conclusion in blue
  await tool({ tool: "pen", pen: "fountain", color: "#1565c0" });
  const u = span("writing, not the paper, drives the effect.");
  const [ux0, uy] = P(u.x0, u.y - 2.5);
  const [ux1] = P(u.x1, u.y);
  take.mark("underline");
  await write(take, [handLine([[ux0, uy], [ux1, uy + 1]], { seed: 508 })], { speed: 900, m });
  take.mark("noteEnd");
  take.hold(4);
  await sleep(1500);
  // More → Export: the annotated PDF, with the ink as vectors
  take.mark("more");
  await tapEl(take, `${ACTIVE} .ink-tb-more`, { sec: 0.4 });
  await sleep(500);
  await ev(() => {
    const items = [...document.querySelectorAll(".ink-pop-menu *")];
    const ex = items.find((e) => /^Export$/.test(e.textContent?.trim() ?? ""));
    ex?.scrollIntoView({ block: "start" });
  });
  await sleep(300);
  await take.frame();
  take.mark("menu");
  take.hold(4);
  const ann = await ev(() => {
    const b = [...document.querySelectorAll(".ink-pop-menu button")].find((x) => /Annotated PDF/.test(x.textContent));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (ann) {
    await travel(take, ann, 0.4);
    take.hold(8);
  }
  take.save();
  await closePopovers();
}

// ---------------------------------------------------------------- pens

scenes.pens = async () => {
  console.log("▶ pens: the pen card, five pens, ten colours");
  await newInkPage("Pens");
  await ev((bg) => __t.surface().setBackground(bg), paper("lined", "white", "wide"));
  const y = (k) => L(k) - 4;
  await addInk([
    ...hw("Fountain pen", X0, y(2), 601, { size: 2.4 }),
    ...hw("Ballpoint", X0, y(4), 602, { size: 2.4, pen: "ballpoint", color: "#1565c0", width: 1.5 }),
    ...hw("Pencil", X0, y(6), 603, { size: 2.4, pen: "pencil", color: "#4d4d4d", width: 2.1 }),
    ...hw("Brush pen", X0, y(8), 604, { size: 2.4, pen: "brush", color: "#d32f2f", width: 4 }),
  ]);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(800);
  const take = new Take("pens");
  const m = await mapping();
  const penBtn = await centre(`${ACTIVE} .ink-tool-pen`);
  take.pen = { x: penBtn.x + 90, y: penBtn.y + 200, down: false };
  await take.frame();
  take.hold(3);
  take.mark("open");
  await tapAt(take, penBtn.x, penBtn.y, { sec: 0.35 });
  await page().waitForSelector(".ink-pop-pen", { timeout: 3000 });
  await sleep(300);
  await take.frame();
  take.mark("card");
  take.hold(3);
  await tapEl(take, ".ink-pop-pen .ink-tile[aria-label='Calligraphy']", { sec: 0.3 });
  await sleep(250);
  await take.frame();
  take.hold(2);
  await tapEl(take, ".ink-pop-pen button[aria-label='Purple']", { sec: 0.3 });
  await sleep(250);
  await take.frame();
  take.mark("picked");
  take.hold(4);
  await closePopovers();
  // the pen moves on to the page (and the swatch's tooltip goes)
  await travel(take, m.at(X0 - 10, y(10) - 50), 0.25);
  await sleep(300);
  await take.frame();
  take.mark("closed");
  take.mark("write");
  await write(take, hs("Calligraphy", X0, y(10), 605, { size: 2.6 }), { speed: 700, m });
  take.mark("written");
  take.hold(10);
  take.save();
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
};

// ---------------------------------------------------------------- paper templates

scenes.paper = async () => {
  console.log("▶ paper: nine paper templates, the writing stays");
  await newInkPage("Any paper");
  await ev((bg) => __t.surface().setBackground(bg), paper("lined"));
  await addInk([
    ...hw("Same notes,", X0 + 30, 300, 701, { size: 3.0 }),
    ...hw("any paper.", X0 + 30, 400, 702, { size: 3.0 }),
    ...hw("- ruled, dotted, squared", X0 + 30, 560, 703, { size: 2.0 }),
    ...hw("- Cornell, checklist, music", X0 + 30, 630, 704, { size: 2.0 }),
    { pts: handLine(ellipse(700, 860, 110, 70, 1.05), { seed: 705, step: 2 }), color: "#1565c0" },
    ...hw("yes!", 652, 878, 706, { size: 2.4, color: "#1565c0" }),
  ]);
  await sleep(600);
  // the picker
  await ev(() => void __t.view().changePaper());
  await page().waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  await sleep(700);
  const pick = new Take("picker");
  pick.pen = { x: 430, y: 720, down: false };
  await pick.frame();
  pick.hold(3);
  for (const style of ["dots", "grid", "cornell"]) {
    await tapEl(pick, `.modal.ink-paper-picker .ink-paper-card[data-style="${style}"]`, { sec: 0.3 });
    await sleep(300);
    await pick.frame();
    pick.hold(5);
  }
  pick.save();
  await closeModals();
  // the page itself, on every paper
  const take = new Take("paper");
  for (const [style, color, spacing] of [["lined", "white", "normal"], ["dots", "white", "normal"], ["grid", "ivory", "normal"], ["graph", "white", "normal"], ["isometric", "white", "normal"], ["cornell", "white", "normal"], ["checklist", "yellow", "normal"], ["music", "white", "normal"], ["blank", "blue", "normal"], ["lined", "ivory", "wide"]]) {
    await ev((bg) => __t.surface().setBackground(bg), paper(style, color, spacing));
    await sleep(300);
    take.mark(style + (take.marks[style] !== undefined ? "2" : ""));
    await take.frame();
  }
  take.save();
};

// ---------------------------------------------------------------- pages: a notebook

scenes.pages = async () => {
  console.log("▶ pages: swipe to the next page, all pages");
  await openFile(TRIP.ink, "ink-notebook");
  await tidyWorkspace();
  await ev(() => {
    const s = __t.surface();
    while (s.pageCount > 1) s.deletePage(s.pageCount - 1);
    s.goTo(0);
  });
  const newPage = async (bg) => {
    await ev((bg) => {
      const s = __t.surface();
      s.addPage("end", bg);
      s.goTo(s.pageCount - 1);
    }, bg);
    await sleep(300);
  };
  const H = (text, x, y, seed, opts = {}) => hw(text, x, y, seed, { size: 1.9, ...opts });
  // 2: a packing checklist
  await newPage(paper("checklist"));
  const LN = (k) => 110 + 44 * k;
  const pack = [...H("Packing list", 70, LN(0) - 6, 801, { size: 2.6 })];
  ["passport", "camera + charger", "sunscreen", "comfy shoes", "tram card"].forEach((t, i) => pack.push(...H(t, 72, LN(i + 2) - 10, 802 + i)));
  for (const i of [0, 1, 3]) pack.push({ pts: handLine([[37, LN(i + 2) - 30], [44, LN(i + 2) - 22], [58, LN(i + 2) - 44]], { seed: 810 + i, step: 1.2, rounds: 0 }), width: 2.2 });
  await addInk(pack);
  // 3: a map, sketched on dotted paper
  await newPage(paper("dots", "ivory"));
  const map = [...H("Day 2", 80, 160, 820, { size: 2.6 })];
  map.push({ pts: handLine([[60, 700], [220, 640], [380, 690], [560, 620], [760, 660], [940, 600]], { seed: 821, step: 3 }), color: "#1565c0", width: 3 });
  map.push(...H("river Tejo", 600, 740, 822, { color: "#1565c0" }));
  for (const [x, yy, name, seed] of [[200, 420, "Alfama", 823], [470, 330, "Baixa", 824], [760, 470, "Belem", 825]]) {
    map.push({ pts: handLine(ellipse(x, yy, 16, 16, 1.02), { seed, step: 1.2 }), color: "#d32f2f", width: 3 });
    map.push(...H(name, x + 28, yy + 8, seed + 10));
  }
  map.push({ pts: handLine([[216, 420], [454, 336]], { seed: 830, step: 2 }), dash: true });
  map.push({ pts: handLine([[486, 336], [744, 466]], { seed: 831, step: 2 }), dash: true });
  await addInk(map);
  // 4: phrases on Cornell paper
  await newPage(paper("cornell"));
  const corn = [...H("Phrases", 30, LN(2), 840, { color: "#1565c0" })];
  [[2, "obrigado - thank you"], [3, "bom dia - good morning"], [4, "a conta - the bill"], [6, "uma bica - an espresso"]].forEach(([k, t], i) => corn.push(...H(t, 300, LN(k), 841 + i)));
  await addInk(corn);
  // 5: a budget on squared paper
  await newPage(paper("grid"));
  const budget = [...H("Budget", 70, 170, 850, { size: 2.6 })];
  [["flights", "180"], ["hotel", "240"], ["food", "120"], ["trams", "20"]].forEach(([a, b], i) => {
    budget.push(...H(a, 90, 280 + i * 70, 851 + i), ...H(b, 520, 280 + i * 70, 860 + i));
  });
  budget.push({ pts: handLine([[80, 560], [640, 562]], { seed: 870 }), width: 2 });
  budget.push(...H("560", 520, 630, 871, { size: 2.3, color: "#d32f2f" }));
  await addInk(budget);
  // 6: a tune heard in Alfama, on music paper
  await newPage(paper("music"));
  const tune = [...H("Fado in Alfama", 70, 150, 880, { size: 2.3 })];
  await addInk(tune);
  await ev(() => __t.surface().goTo(0));
  await sleep(800);

  const take = new Take("pages");
  const r = await ev(() => {
    const b = __t.surface().el.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height };
  });
  take.pen = null;
  await take.frame();
  take.hold(3);
  // a finger swipes to the next page
  take.mark("swipe");
  await swipe(take, { x: r.l + r.w * 0.78, y: r.t + r.h * 0.55 }, { x: r.l + r.w * 0.22, y: r.t + r.h * 0.52 }, 0.3);
  await sleep(500);
  await take.frame();
  take.mark("turned");
  take.hold(6);
  // tap the page number: all pages
  const label = await centre(`${ACTIVE} .ink-tb-pagelabel`);
  take.pen = { x: label.x - 60, y: label.y + 260, down: false };
  take.mark("tapPages");
  await tapAt(take, label.x, label.y, { sec: 0.35 });
  await page().waitForSelector(".modal.ink-pages-modal .ink-page-canvas", { timeout: 5000 });
  await sleep(1500);
  await travel(take, { x: label.x - 220, y: label.y + 420 }, 0.4);
  await take.frame();
  take.mark("overview");
  take.hold(FPS * 2);
  take.save();
  await closeModals();
};

// ---------------------------------------------------------------- stills for the feature wall

/** One frame of what is on the screen now. */
async function still(name) {
  const t = new Take(`still-${name}`);
  await t.frame();
  t.save();
}

scenes.stills = async () => {
  console.log("▶ stills: erasers, menus, typed notes, daily notes, files, embeds, libraries, setup");
  // the eraser card
  await openFile(TRIP.ink, "ink-notebook");
  await tidyWorkspace();
  await ev(() => __t.surface().goTo(0));
  // a tap chooses the eraser, a second tap opens its card
  await page().click(`${ACTIVE} .ink-tool-eraser`);
  await sleep(700);
  if (!(await ev(() => !!document.querySelector(".ink-popover")))) await page().click(`${ACTIVE} .ink-tool-eraser`);
  await page().waitForSelector(".ink-popover", { timeout: 3000 }).catch(() => console.log("    (no eraser card)"));
  await sleep(400);
  await still("eraser");
  await closePopovers();
  await tool({ tool: "pen" });
  // the Insert items (in the More menu at this width)
  await page().click(`${ACTIVE} .ink-tb-more`);
  await sleep(500);
  await still("more");
  await closePopovers();
  // typed notes: typed on the text page, shown next to the ink
  const text = await ev((p) => __t.read(p), TRIP.text);
  if (!/Typed on the train/.test(text)) {
    await ev(async (p) => {
      const f = app.vault.getAbstractFileByPath(p);
      await app.vault.process(f, (t) => t.trimEnd() + "\n\n## Typed on the train\n- Ask Mia about the **fado bar**\n- Restaurant: *Taberna da Rua*\n- [ ] Book the tram tour\n");
    }, TRIP.text);
    await sleep(800);
  }
  await ev(() => __t.view().toggleNotes());
  await sleep(1200);
  await still("notes");
  await ev(() => __t.view().toggleNotes());
  await sleep(300);
  // the files: two Markdown files per page
  await ev(() => app.commands.executeCommandById("file-explorer:reveal-active-file"));
  await sleep(1500);
  await ev(async () => {
    const v = app.workspace.getLeavesOfType("file-explorer")[0]?.view;
    // (the drawer's tree is drawn when it is sorted)
    v?.requestSort?.();
    await __t.sleep(600);
    for (const [p, open] of [["Ink", true], ["Ink/Attachments", true], ["Papers", false], ["People", false], ["Ink libraries", false]]) v?.fileItems?.[p]?.setCollapsed?.(!open);
  });
  await sleep(1000);
  console.log("    files:", await ev(() => document.querySelectorAll(".nav-file-title, .tree-item-self").length));
  await still("files");
  await ev(() => app.workspace.leftSplit.collapse());
  await sleep(400);
  // an ink page embedded in a note
  fs.writeFileSync(path.join(VAULT, "Trips.md"), "# Trips\n\nThe Lisbon notebook:\n\n![[Lisbon weekend.ink]]\n");
  await sleep(800);
  await openFile("Trips.md", "markdown");
  await ev(async () => {
    const leaf = app.workspace.getMostRecentLeaf();
    await leaf.setViewState({ type: "markdown", state: { file: "Trips.md", mode: "preview" } });
  });
  await sleep(2500);
  await still("embed");
  // an Excalidraw library in the object library
  await excalidrawLibrary();
  await openFile(TRIP.ink, "ink-notebook");
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  await page().waitForSelector(PANEL, { timeout: 5000 });
  await sleep(500);
  await ev(() => {
    const b = [...document.querySelectorAll(".workspace-leaf.mod-active .ink-library-source")].find((x) => /Doodles/.test(x.getAttribute("aria-label") ?? x.textContent));
    b?.click();
  });
  await sleep(800);
  await still("excalidraw");
  await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-library-panel .ink-library-close")?.click());
  // today's daily note, on an ink page
  await ev(() => app.internalPlugins.getPluginById("daily-notes")?.enable?.());
  await sleep(500);
  await ev(() => app.commands.executeCommandById("ink-notebook:open-today-ink"));
  await sleep(3000);
  await tidyWorkspace();
  const isInk = await ev(() => __t.view()?.getViewType() === "ink-notebook");
  if (isInk) {
    await addInk([
      ...hw("Thursday", X0, 250, 901, { size: 3.0 }),
      ...hw("- call the bakery", X0, 360, 902),
      ...hw("- 3pm design review", X0, 420, 903),
      ...hw("- run 5 km", X0, 480, 904),
    ]);
    await sleep(800);
    await still("daily");
  } else console.log("    (no daily note on an ink page)", await ev(() => __t.view()?.getViewType()));
  // the setup assistant
  await ev(() => app.commands.executeCommandById("ink-notebook:open-setup"));
  await sleep(1500);
  await still("setup");
  await closeModals();
};

/** A small Excalidraw library (a cloud, a star, a server and a smiley) in the vault. */
async function excalidrawLibrary() {
  const base = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, roundness: null, isDeleted: false, groupIds: [], boundElements: null, locked: false, version: 1, versionNonce: 1, seed: 1 };
  let n = 0;
  const el = (o) => ({ ...base, id: `el${++n}`, ...o });
  const cloud = [];
  for (const [x, y, w, h] of [[0, 30, 70, 60], [40, 0, 90, 80], [100, 25, 80, 65], [30, 50, 120, 50]]) cloud.push(el({ type: "ellipse", x, y, width: w, height: h, backgroundColor: "#a5d8ff", fillStyle: "solid", strokeColor: "#1971c2" }));
  const star = [];
  {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 ? 26 : 62;
      pts.push([62 + r * Math.cos(a), 62 + r * Math.sin(a)]);
    }
    star.push(el({ type: "line", x: 0, y: 0, width: 124, height: 124, points: pts, backgroundColor: "#ffd43b", fillStyle: "hachure", strokeColor: "#e67700" }));
  }
  const server = [
    el({ type: "rectangle", x: 0, y: 0, width: 110, height: 40, backgroundColor: "#d0bfff", fillStyle: "cross-hatch", strokeColor: "#5f3dc4", roundness: { type: 3 } }),
    el({ type: "rectangle", x: 0, y: 50, width: 110, height: 40, backgroundColor: "#d0bfff", fillStyle: "cross-hatch", strokeColor: "#5f3dc4", roundness: { type: 3 } }),
    el({ type: "ellipse", x: 85, y: 14, width: 12, height: 12, backgroundColor: "#2f9e44", fillStyle: "solid", strokeColor: "#2f9e44" }),
    el({ type: "ellipse", x: 85, y: 64, width: 12, height: 12, backgroundColor: "#2f9e44", fillStyle: "solid", strokeColor: "#2f9e44" }),
  ];
  const smile = [
    el({ type: "ellipse", x: 0, y: 0, width: 110, height: 110, backgroundColor: "#ffec99", fillStyle: "solid", strokeColor: "#f08c00" }),
    el({ type: "ellipse", x: 32, y: 36, width: 10, height: 14, backgroundColor: "#1e1e1e", fillStyle: "solid" }),
    el({ type: "ellipse", x: 68, y: 36, width: 10, height: 14, backgroundColor: "#1e1e1e", fillStyle: "solid" }),
    el({ type: "line", x: 28, y: 66, width: 54, height: 18, points: [[0, 0], [14, 14], [40, 14], [54, 0]] }),
  ];
  const arrow = [el({ type: "arrow", x: 0, y: 40, width: 160, height: 30, points: [[0, 0], [70, -30], [160, 0]], strokeColor: "#c2255c", endArrowhead: "arrow", startArrowhead: null, roundness: { type: 2 } })];
  const note = [
    el({ type: "rectangle", x: 0, y: 0, width: 130, height: 90, backgroundColor: "#b2f2bb", fillStyle: "solid", strokeColor: "#2b8a3e" }),
    el({ type: "text", x: 18, y: 30, width: 94, height: 25, text: "To do!", fontSize: 20, fontFamily: 1, textAlign: "center", verticalAlign: "middle", strokeColor: "#2b8a3e", originalText: "To do!", lineHeight: 1.25 }),
  ];
  const items = [["Cloud", cloud], ["Star", star], ["Server", server], ["Smiley", smile], ["Swoosh", arrow], ["Sticky note", note]].map(([name, elements], i) => ({ id: `item${i}`, status: "published", created: 1, name, elements }));
  fs.mkdirSync(path.join(VAULT, "Ink libraries"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Ink libraries", "Doodles.excalidrawlib"), JSON.stringify({ type: "excalidrawlib", version: 2, source: "promo", libraryItems: items }));
  await sleep(1200);
}

// ---------------------------------------------------------------- order

const order = ["setup", "write", "smart", "lasso", "flow", "mermaid", "table", "arxiv", "pens", "paper", "pages", "stills"];
const run = only ? ["setup", ...only.split(",")] : order;
for (const name of run) {
  try {
    await scenes[name]();
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.stack ?? e}`);
    await page().screenshot({ path: path.join(OUT, `error-${name}.png`) }).catch(() => {});
    process.exitCode = 1;
  }
}
await R.rig.browser.close();
