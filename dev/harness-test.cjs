// Drives dev/harness.html in Chromium with real pen/touch input (CDP) and checks the ink surface.
// Run: node dev/build-harness.mjs && node dev/harness-test.cjs [shots-dir]
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SHOTS = process.argv[2] || path.join(__dirname, "out", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 760, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("file://" + path.join(__dirname, "harness.html"));
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);

  // instrument the move handler
  await page.evaluate(() => {
    window.domChanges = 0;
    new MutationObserver((list) => (window.domChanges += list.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const input = window.surface.input;
    const orig = input.onMove.bind(input);
    window.moveTimes = [];
    input.onMove = (e, raw) => {
      const t0 = performance.now();
      orig(e, raw);
      window.moveTimes.push(performance.now() - t0);
    };
  });

  const box = await page.evaluate(() => {
    const r = window.surface.el.getBoundingClientRect();
    const v = window.surface.view;
    return { left: r.left, top: r.top, scale: v.scale, ox: v.ox, oy: v.oy };
  });
  const toScreen = (x, y) => ({ x: box.left + box.ox + x * box.scale, y: box.top + box.oy + y * box.scale });

  const pen = async (pts, opts = {}) => {
    // CDP cannot send the eraser end (buttons 32); the side button erases by default
    const buttons = opts.side ? 2 : 1;
    const base = { pointerType: "pen", button: opts.side ? "right" : "left", buttons, tiltX: 0, tiltY: 0 };
    const [x0, y0] = pts[0];
    const s0 = toScreen(x0, y0);
    if (opts.androidSide) {
      // Android (S Pen, Boox): Chromium reports the side button only while the pen hovers – as
      // the left button (buttons 1, pressure 0) – and a pen on the screen always has buttons 1
      for (let i = 4; i >= 0; i--) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x + i * 3, y: s0.y - i * 3, pointerType: "pen", buttons: 1, force: 0 });
      }
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: opts.androidSide ? 1 : 0, force: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: opts.p ?? 0.5, ...base });
    for (let i = 1; i < pts.length; i++) {
      const s = toScreen(pts[i][0], pts[i][1]);
      const p = pts[i][2] ?? opts.p ?? 0.3 + 0.5 * Math.abs(Math.sin(i / 5));
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, force: p, ...base });
    }
    const last = toScreen(...pts[pts.length - 1]);
    if (opts.hold) await page.waitForTimeout(opts.hold);
    if (opts.beforeUp) await opts.beforeUp();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, force: 0, ...base, buttons: 0 });
  };
  const along = (corners, step = 3) => {
    const out = [corners[0]];
    for (let i = 1; i < corners.length; i++) {
      const [ax, ay] = corners[i - 1];
      const [bx, by] = corners[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    return out;
  };
  const word = (x, y, w, h) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push([x + (w * i) / 40, y + h / 2 + (h / 2) * Math.sin(i * 0.9)]);
    return pts;
  };
  // a stroke written straight down at x (the pen wrote instead of erasing)
  const lineAt = (x) =>
    page.evaluate((x) => window.surface.page.strokes.some((s) => s.pts.every((v, i) => i % 3 !== 0 || Math.abs(v - x) < 1)), x);
  const state = () =>
    page.evaluate(() => {
      const s = window.surface;
      return {
        pages: s.document.pages.length,
        page: s.pageIndex,
        strokes: s.page.strokes.length,
        texts: s.page.texts.length,
        sel: s.selection.strokes.size,
        tool: s.tools.tool,
        undo: s.history.canUndo,
        session: s.input.session?.constructor?.name ?? null,
        gesture: !!s.input.gesture,
        link: !!s.input.link,
      };
    });

  console.log("writing");
  for (let line = 0; line < 6; line++) {
    for (let w = 0; w < 5; w++) await pen(word(80 + w * 160, 150 + line * 60, 120, 30));
  }
  let st = await state();
  check("30 words become 30 strokes", st.strokes === 30, JSON.stringify(st));
  const domChanges = await page.evaluate(() => window.domChanges);
  // only the undo button turns on; e-ink screens refresh wherever the page changes
  check("writing leaves the rest of the page alone", domChanges <= 2, `${domChanges} DOM changes`);
  const times = await page.evaluate(() => {
    const t = window.moveTimes.slice().sort((a, b) => a - b);
    return { n: t.length, median: t[Math.floor(t.length / 2)], p95: t[Math.floor(t.length * 0.95)], max: t[t.length - 1] };
  });
  console.log(`   move handler: ${JSON.stringify(times)} ms`);
  check("a pen move is handled in well under a millisecond (median)", times.median < 0.5, JSON.stringify(times));
  await page.screenshot({ path: path.join(SHOTS, "01-writing.png") });

  // pressure makes the fountain pen vary

  console.log("hold to snap");
  await pen(along([[100, 600], [400, 604], [402, 800], [98, 798], [101, 606]], 4), { hold: 900 });
  st = await state();
  const last = await page.evaluate(() => {
    const s = window.surface.page.strokes.at(-1);
    return { poly: !!s.poly, closed: !!s.closed, n: s.pts.length / 3 };
  });
  check("a rectangle held at the end snaps to a clean rectangle", last.poly && last.closed && last.n === 4, JSON.stringify(last));

  console.log("scribble to erase");
  await pen(word(600, 600, 120, 30));
  st = await state();
  const before = st.strokes;
  const zig = [];
  for (let i = 0; i <= 12; i++) zig.push(...along([[i % 2 ? 730 : 590, 595 + i * 3], [i % 2 ? 590 : 730, 598 + i * 3]], 6));
  await pen(zig);
  st = await state();
  check("scratching over a word erases it", st.strokes === before - 1, `${before} -> ${st.strokes}`);

  console.log("side button of the pen erases");
  const beforeErase = st.strokes;
  // across the second word of the first line: it is cut in two
  await pen(along([[300, 128], [300, 188]], 4), { side: true });
  st = await state();
  check("the partial eraser cuts a word in two", st.strokes === beforeErase + 1 && !(await lineAt(300)), `${beforeErase} -> ${st.strokes}`);

  console.log("side button on Android (held while the pen hovers)");
  const beforeAndroid = st.strokes;
  // across the first word of the first line
  await pen(along([[160, 128], [160, 188]], 4), { androidSide: true });
  st = await state();
  const drewLine = await lineAt(160);
  check("held before touching the screen, it erases (a word is cut in two)", st.strokes === beforeAndroid + 1 && !drewLine, `${beforeAndroid} -> ${st.strokes}${drewLine ? ", the pen wrote a line" : ""}`);
  const beforeReleased = st.strokes;
  // released again: the pen writes
  await pen(along([[120, 900], [200, 900]], 4));
  st = await state();
  check("released, the pen writes again", st.strokes === beforeReleased + 1, `${beforeReleased} -> ${st.strokes}`);
  // back to where the tests below expect the page
  await page.evaluate(() => {
    window.surface.undo();
    window.surface.undo();
  });
  st = await state();
  check("(undone)", st.strokes === beforeAndroid, `${beforeAndroid} -> ${st.strokes}`);
  await page.screenshot({ path: path.join(SHOTS, "02-erased.png") });

  console.log("palm rejection, undo with two fingers");
  const undoBefore = st.strokes;
  const t1 = toScreen(500, 1000);
  const t2 = toScreen(600, 1000);
  const twoFingerTap = async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t1.x, y: t1.y, id: 1 }, { x: t2.x, y: t2.y, id: 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // a palm landing while the pen is near the screen is ignored
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t1.x, y: t1.y - 200, pointerType: "pen", buttons: 0, force: 0 });
  await twoFingerTap();
  st = await state();
  check("touches right after the pen are ignored (palm)", st.strokes === undoBefore, `${undoBefore} -> ${st.strokes}`);
  await page.waitForTimeout(800);
  await twoFingerTap();
  await page.waitForTimeout(100);
  st = await state();
  check("a two-finger tap undoes the erasing", st.strokes === beforeErase, `${undoBefore} -> ${st.strokes}`);
  const base1 = st.strokes;

  console.log("lasso");
  await page.evaluate(() => window.surface.setTools({ tool: "lasso" }));
  await pen(along([[60, 260], [900, 260], [900, 330], [60, 330], [60, 262]], 6));
  st = await state();
  check("the lasso selects the third line of words", st.sel === 5, JSON.stringify(st));
  await page.screenshot({ path: path.join(SHOTS, "03-lasso.png") });
  const yBefore = await page.evaluate(() => window.surface.selectedItems().strokes[0].pts[1]);
  await pen(along([[300, 300], [300, 450]], 5));
  const yAfter = await page.evaluate(() => window.surface.selectedItems().strokes[0].pts[1]);
  check("dragging the selection moves it", Math.abs(yAfter - yBefore - 150) < 2, `${yBefore} -> ${yAfter}`);
  await page.evaluate(() => window.surface.deleteSelection());
  st = await state();
  check("deleting the selection", st.strokes === base1 - 5 && st.sel === 0, JSON.stringify(st));

  console.log("pages");
  await page.evaluate(() => window.surface.setTools({ tool: "pen" }));
  await page.evaluate(() => window.surface.addPage("after"));
  st = await state();
  check("adding a page goes to it", st.pages === 2 && st.page === 1 && st.strokes === 0, JSON.stringify(st));
  await page.waitForTimeout(800);
  const s1 = toScreen(200, 700);
  const swipe = async (dx) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: s1.x, y: s1.y, id: 3 }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: s1.x + (dx * i) / 8, y: s1.y, id: 3 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(250);
  st = await state();
  check("swiping right turns back to page 1", st.page === 0 && st.strokes === base1 - 5, JSON.stringify(st));
  await swipe(-250);
  st = await state();
  check("swiping left turns to page 2", st.page === 1, JSON.stringify(st));

  console.log("pinch zoom");
  const c = toScreen(500, 700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x - 40, y: c.y, id: 4 }, { x: c.x + 40, y: c.y, id: 5 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: c.x - 40 - i * 15, y: c.y, id: 4 }, { x: c.x + 40 + i * 15, y: c.y, id: 5 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const zoom = await page.evaluate(() => window.surface.view.scale / window.surface.fitScale);
  check("pinching zooms in", zoom > 2, `zoom ${zoom}`);
  await page.evaluate(() => window.surface.resetZoom());

  console.log("text box");

  await page.evaluate(() => window.surface.setTools({ tool: "text" }));
  await pen([[100, 100], [100, 100]]);
  await page.waitForTimeout(50);
  await page.keyboard.type("Hello from the keyboard");
  await page.keyboard.press("Escape");
  st = await state();
  check("tapping with the text tool and typing adds a text box", st.texts === 1, JSON.stringify(st));

  console.log("shapes, highlighter");
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "ellipse" }));
  await pen(along([[200, 300], [500, 500]], 10));
  await page.evaluate(() => window.surface.setTools({ tool: "marker" }));
  let wetWhileDrawing = "";
  await pen(along([[90, 115], [420, 118]], 4), {
    beforeUp: async () => {
      wetWhileDrawing = await page.evaluate(() => getComputedStyle(window.surface.wet).display);
    },
  });
  st = await state();
  check("ellipse and highlighter are added", st.strokes === 2, JSON.stringify(st));
  const wetAfter = await page.evaluate(() => getComputedStyle(window.surface.wet).display);
  check("the preview layer shows the highlighter, then goes away", wetWhileDrawing === "block" && wetAfter === "none", `${wetWhileDrawing} / ${wetAfter}`);
  await page.screenshot({ path: path.join(SHOTS, "04-page2.png") });

  console.log("save and load");
  const roundtrip = await page.evaluate(() => {
    const s = window.surface;
    const text = window.serializeInkFile("", s.file);
    const back = window.parseInkFile(text);
    return { size: text.length, pages: back.doc.pages.length, strokes: back.doc.pages.map((p) => p.strokes.length) };
  });
  console.log(`   file: ${roundtrip.size} bytes`);
  check("the notebook survives saving", roundtrip.pages === 2 && roundtrip.strokes[0] === base1 - 5, JSON.stringify(roundtrip));

  console.log("toolbar");
  await page.evaluate(() => window.surface.setTools({ tool: "pen" }));
  await page.click(".ink-tool-pen");
  await page.waitForTimeout(100);
  check("tapping the selected pen opens its options", (await page.$(".ink-pop-pen")) !== null);
  await page.screenshot({ path: path.join(SHOTS, "05-pen-options.png") });
  await page.click(".ink-pop-pen .ink-tile[aria-label='Brush']");
  const penType = await page.evaluate(() => window.surface.tools.pen);
  check("picking a pen in the card", penType === "brush", penType);
  await page.mouse.click(5, 990);
  check("tapping outside closes the card", (await page.$(".ink-popover")) === null);

  console.log("fills");
  await page.mouse.click(5, 990);
  await page.evaluate(() => window.surface.addPage("end"));
  await page.waitForTimeout(400);
  const lastStroke = () =>
    page.evaluate(() => {
      const s = window.surface.page.strokes.at(-1);
      return s ? { id: s.id, fill: s.fill ?? null, fillStyle: s.fillStyle ?? null, area: !!s.area, closed: !!s.closed, from: s.from ?? null, to: s.to ?? null, n: s.pts.length / 3, pts: Array.from(s.pts) } : null;
    });
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "rect", shapeFill: "#fff3bf", fillStyle: "solid" }));
  await pen(along([[560, 650], [880, 850]], 10));
  let ls = await lastStroke();
  check("a rectangle drawn with a fill chosen is filled", ls?.fill === "#fff3bf" && ls.closed, JSON.stringify(ls));
  // a box of four separate lines, filled with the fill tool
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "line", shapeFill: "" }));
  for (const [a, b] of [[[100, 650], [400, 650]], [[400, 650], [400, 850]], [[400, 850], [100, 850]], [[100, 850], [100, 650]]]) await pen(along([a, b], 10));
  st = await state();
  const linesOnly = st.strokes;
  await page.evaluate(() => window.surface.setTools({ tool: "fill", fillColor: "#c4dfff", fillStyle: "solid" }));
  await pen([[250, 750], [250, 750]]);
  st = await state();
  ls = await lastStroke();
  check("tapping between four lines with the fill tool fills the box they make", st.strokes === linesOnly + 1 && ls?.area && ls.fill === "#c4dfff", JSON.stringify(ls && { area: ls.area, fill: ls.fill }));
  const filledPixel = await page.evaluate(() => {
    const s = window.surface;
    const p = s.toScreen({ x: 250, y: 760 });
    const d = s.bctx.getImageData(Math.round(p.x * s.dpr), Math.round(p.y * s.dpr), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check("the fill is on the page", Math.abs(filledPixel[0] - 0xc4) < 6 && Math.abs(filledPixel[2] - 0xff) < 6, JSON.stringify(filledPixel));
  await page.evaluate(() => window.surface.setTools({ fillStyle: "hatch" }));
  await pen([[700, 750], [700, 750]]);
  const hatched = await page.evaluate(() => window.surface.page.strokes.find((s) => s.fill && !s.area && s.closed));
  check("tapping the rectangle hatches it instead", hatched?.fill === "#c4dfff" && hatched.fillStyle === "hatch", JSON.stringify(hatched && { fill: hatched.fill, style: hatched.fillStyle }));
  await page.evaluate(() => window.surface.setTools({ fillColor: "" }));
  await pen([[250, 750], [250, 750]]);
  st = await state();
  check("with “Remove fills”, tapping a fill removes it", st.strokes === linesOnly, JSON.stringify(st));
  await page.screenshot({ path: path.join(SHOTS, "06-fills.png") });

  console.log("object library, flowchart");
  await page.evaluate(() => window.surface.setTools({ tool: "pen", fillColor: "#c4dfff", fillStyle: "solid" }));
  await page.click(".ink-tb-library");
  await page.waitForSelector(".ink-library-tile");
  check("the library button opens the flowchart shapes", (await page.$$(".ink-library-tile")).length >= 15);
  await page.screenshot({ path: path.join(SHOTS, "07-library.png") });
  await page.click(".ink-library-tile[aria-label='Process']");
  st = await state();
  check("tapping a shape in the library starts placing it", st.tool === "stamp", JSON.stringify(st));
  const folded = await page.evaluate(() => ({ folded: document.querySelector(".ink-library-panel").classList.contains("is-folded"), title: document.querySelector(".ink-library-title").textContent }));
  check("on a narrow screen the library folds away while placing", folded.folded && folded.title === "Placing “Process”", JSON.stringify(folded));
  const beforePlace = st.strokes;
  // (the library panel covers the right of the page in this window)
  await pen([[150, 200], [150, 200]]);
  await pen([[150, 450], [150, 450]]);
  st = await state();
  check("each tap on the page places one", st.strokes === beforePlace + 2 && st.tool === "stamp", JSON.stringify(st));
  await page.click(".ink-library-fold");
  await page.click(".ink-library-tile[aria-label='Decision']");
  await pen([[420, 450], [420, 450]]);
  const shapes = await page.evaluate(() => window.surface.page.strokes.slice(-3).map((s) => ({ id: s.id, closed: !!s.closed, n: s.pts.length / 3 })));
  check("placed shapes are closed outlines", shapes.every((s) => s.closed), JSON.stringify(shapes));
  // connect them: an arrow from the first process to the second, an elbow arrow from the second to the decision
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "arrow" }));
  await pen(along([[150, 200], [150, 450]], 8));
  ls = await lastStroke();
  check("an arrow drawn from one shape to another is attached to both", ls?.from === shapes[0].id && ls?.to === shapes[1].id, JSON.stringify(ls && { from: ls.from, to: ls.to }));
  check("it starts and ends at their outlines", ls && ls.pts[1] > 245 + 2 && ls.pts[ls.pts.length - 2] < 405 - 2, JSON.stringify(ls && [ls.pts[1], ls.pts[ls.pts.length - 2]]));
  const arrowId = ls?.id;
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "elbow" }));
  await pen(along([[150, 450], [420, 450]], 8));
  ls = await lastStroke();
  check("an elbow arrow attaches too", ls?.from === shapes[1].id && ls?.to === shapes[2].id, JSON.stringify(ls && { from: ls.from, to: ls.to }));
  // move the second process: both arrows follow
  await page.evaluate(() => window.surface.setTools({ tool: "lasso" }));
  // its left edge (where the arrow meets it, the arrow is on top)
  await pen([[60, 450], [60, 450]]);
  st = await state();
  const selected = await page.evaluate(() => [...window.surface.selection.strokes][0]);
  check("tapping the shape's outline selects it", st.sel === 1 && selected === shapes[1].id, JSON.stringify(st));
  await pen(along([[100, 450], [100, 600]], 6));
  const followed = await page.evaluate((id) => {
    const s = window.surface.page.strokes.find((x) => x.id === id);
    const n = s.pts.length / 3;
    return { x: s.pts[(n - 1) * 3], y: s.pts[(n - 1) * 3 + 1], to: s.to };
  }, arrowId);
  check("an arrow follows the shape it points at", followed.y > 540 && Math.abs(followed.x - 150) < 2 && followed.to === shapes[1].id, JSON.stringify(followed));
  // a label: tap into the first shape with the text tool
  await page.evaluate(() => window.surface.setTools({ tool: "text" }));
  await pen([[150, 200], [150, 200]]);
  await page.waitForTimeout(50);
  const align = await page.evaluate(() => document.querySelector(".ink-text-editor")?.style.textAlign);
  await page.keyboard.type("Start");
  await page.keyboard.press("Escape");
  const label = await page.evaluate(() => window.surface.page.texts.at(-1));
  check("the text tool labels a shape, centred in it", label?.container === shapes[0].id && label.align === "center" && align === "center" && Math.abs(label.y + label.h / 2 - 200) < 1, JSON.stringify(label));
  await page.evaluate(() => window.surface.setTools({ tool: "lasso" }));
  await pen([[150, 155], [150, 155]]);
  const selTexts = await page.evaluate(() => window.surface.selection.texts.size);
  check("selecting a shape selects its label", selTexts === 1, String(selTexts));
  await pen(along([[170, 200], [420, 200]], 6));
  const moved = await page.evaluate(() => window.surface.page.texts.at(-1).x);
  check("the label moves with its shape", Math.abs(moved - label.x - 250) < 1, `${label.x} -> ${moved}`);
  // fill the selected shape from the lasso bar
  await page.waitForSelector(".ink-sel-fill");
  await page.click(".ink-sel-fill");
  await page.click(".ink-selection-palette .ink-swatch-btn[aria-label='Mint']");
  const minted = await page.evaluate((id) => window.surface.page.strokes.find((x) => x.id === id).fill, shapes[0].id);
  check("“Fill” in the lasso bar fills the selected shape", minted === "#c8f0cc", String(minted));
  await page.evaluate(() => window.surface.setSelection({ strokes: new Set(), texts: new Set(), images: new Set(), links: new Set(), figures: new Set() }));
  // an Excalidraw library item
  await page.click(".ink-library-fold");
  await page.click(".ink-library-source[aria-label='Sample']");
  await page.waitForSelector(".ink-library-tile[aria-label='Labelled box']");
  await page.click(".ink-library-tile[aria-label='Labelled box']");
  await pen([[300, 1100], [300, 1100]]);
  const placed = await page.evaluate(() => {
    const p = window.surface.page;
    const s = p.strokes.at(-1);
    const t = p.texts.at(-1);
    return { fill: s.fill, style: s.fillStyle, color: s.color, text: t.text, container: t.container === s.id };
  });
  check("an Excalidraw library item keeps its colours, hatching and label", placed.fill === "#a5d8ff" && placed.style === "hatch" && placed.color === "#1971c2" && placed.text === "Server" && placed.container, JSON.stringify(placed));
  await page.screenshot({ path: path.join(SHOTS, "08-flowchart.png") });
  const saved = await page.evaluate(() => {
    const s = window.surface;
    const back = window.parseInkFile(window.serializeInkFile("", s.file)).doc.pages.at(-1);
    const a = back.strokes.filter((x) => x.from || x.to).length;
    return { connectors: a, labels: back.texts.filter((t) => t.container).length, fills: back.strokes.filter((x) => x.fill).length };
  });
  check("fills, connectors and labels survive saving", saved.connectors === 2 && saved.labels === 2 && saved.fills >= 2, JSON.stringify(saved));
  // a Mermaid diagram, on a page of its own
  console.log("object library, Mermaid");
  await page.evaluate(() => window.surface.addPage("end"));
  await page.click(".ink-library-fold");
  await page.click(".ink-library-source[aria-label='Mermaid']");
  await page.waitForSelector(".ink-library-tile[aria-label='Start up']");
  await page.click(".ink-library-tile[aria-label='Start up']");
  st = await state();
  check("tapping a Mermaid diagram starts placing it", st.tool === "stamp", JSON.stringify(st));
  await pen([[500, 707], [500, 707]]);
  const mermaid = await page.evaluate(() => {
    const p = window.surface.page;
    const ids = new Set(p.strokes.map((s) => s.id));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of p.strokes) for (let i = 0; i < s.pts.length; i += 3) {
      minX = Math.min(minX, s.pts[i]); maxX = Math.max(maxX, s.pts[i]);
      minY = Math.min(minY, s.pts[i + 1]); maxY = Math.max(maxY, s.pts[i + 1]);
    }
    return {
      strokes: p.strokes.length,
      connectors: p.strokes.filter((s) => s.from && s.to && ids.has(s.from) && ids.has(s.to)).length,
      labels: p.texts.filter((t) => t.container && ids.has(t.container)).length,
      texts: p.texts.length,
      w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY, pw: p.w, ph: p.h,
      size: p.texts.find((t) => t.text === "More players?")?.size,
    };
  });
  check("the diagram is placed as shapes, labels in them and attached arrows", mermaid.strokes === 29 && mermaid.connectors === 12 && mermaid.labels === 14 && mermaid.texts === 19, JSON.stringify(mermaid));
  check("a whole diagram may fill most of the page, and stays on it", mermaid.h > mermaid.ph * 0.7 && mermaid.minX >= 0 && mermaid.minY >= 0 && mermaid.maxX <= mermaid.pw && mermaid.maxY <= mermaid.ph, JSON.stringify(mermaid));
  await page.click(".ink-library-close");
  await page.waitForTimeout(50);
  await page.screenshot({ path: path.join(SHOTS, "09-mermaid.png") });
  // move a shape of the diagram: its arrows follow it
  const target = await page.evaluate(() => {
    const p = window.surface.page;
    const t = p.texts.find((x) => x.text === "Start game\nGame(shaker, players)");
    const s = p.strokes.find((x) => x.id === t.container);
    let minX = Infinity;
    for (let i = 0; i < s.pts.length; i += 3) minX = Math.min(minX, s.pts[i]);
    // its left edge (clear of the label, which a tap would pick first)
    return { id: s.id, x: t.x + t.w / 2, y: t.y + t.h / 2, edge: minX, arrow: p.strokes.find((x) => x.to === s.id).id };
  });
  await page.evaluate(() => window.surface.setTools({ tool: "lasso" }));
  await pen([[target.edge, target.y], [target.edge, target.y]]);
  const pickedShape = await page.evaluate(() => [...window.surface.selection.strokes]);
  await pen(along([[target.x, target.y], [target.x + 200, target.y + 20]], 8));
  const after = await page.evaluate((t) => {
    const p = window.surface.page;
    const a = p.strokes.find((x) => x.id === t.arrow);
    const n = a.pts.length / 3;
    const s = p.strokes.find((x) => x.id === t.id);
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) { minX = Math.min(minX, s.pts[i]); maxX = Math.max(maxX, s.pts[i]); }
    return { endX: a.pts[(n - 1) * 3], minX, maxX, to: a.to, elbow: !!a.elbow };
  }, target);
  check("a shape of the diagram can be moved, and its arrow follows", pickedShape.includes(target.id) && after.to === target.id && after.elbow && after.endX > after.minX - 4 && after.endX < after.maxX + 4, JSON.stringify({ pickedShape, ...after }));
  check("the library closes", (await page.$(".ink-library-panel")) === null);

  check("no errors in the page", errors.length === 0, errors.join("\n"));
  await browser.close();
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
