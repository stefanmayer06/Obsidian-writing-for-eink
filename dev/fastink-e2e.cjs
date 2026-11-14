// End-to-end check of instant ink (Boox) without a Boox.
//
// The real plugin code – the ink surface, the toolbar and the instant ink bridge
// (src/obsidian/fastInkBridge.ts) – runs in Chromium, served from http://localhost
// as Obsidian on Android is, with real pen input (CDP). It talks over a real
// WebSocket to the real Bridge app code (android/: control socket, protocol,
// calibration, firmware request) running on the JVM, where the Boox firmware is
// replaced by a report of what it would be asked to draw.
//
// A second connection plays the firmware's pen reader: it reports each pen-down
// in screen pixels, as on a tablet whose Obsidian window starts 48 px down (the
// status bar). The page's events carry that screen position too, as Android's
// WebView fills them (screenY = clientY + 24 CSS px): the plugin reports where its
// window is, and the Bridge places the page from that before any stroke (its
// first guess, 40 px, holds only until an event has shown where the window is).
//
// Run (port 80 needs root, like in a container):
//   (cd android && ./gradlew -q writeTestClasspath) && node dev/build-harness.mjs && node dev/fastink-e2e.cjs
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 47613;
const DPR = 2;
const VIEW = { width: 760, height: 1000 };
/** Where the (simulated) Obsidian window starts on the (simulated) screen, and the Bridge's first guess. */
const SCREEN_Y = 48;
const GUESS_Y = 40;

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, "http://localhost").pathname)));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(80, () => resolve(server)));
}

function startBridge() {
  const cp = fs.readFileSync(path.join(ROOT, "android/app/build/test-classpath.txt"), "utf8").trim();
  const java = spawn(
    "java",
    ["-cp", cp, "io.github.stefanmayer06.inkbridge.E2eServer", String(PORT), String(VIEW.width * DPR), String(VIEW.height * DPR + SCREEN_Y), String(GUESS_Y)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    java.stdout.on("data", (d) => String(d).includes("listening") && resolve(java));
    java.on("exit", (c) => reject(new Error(`the Bridge stopped (${c})`)));
  });
}

(async () => {
  const server = await serve();
  const java = await startBridge();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, hasTouch: true });
    // Android's WebView gives each touch and pen event its raw screen position; desktop Chromium
    // reports the window at the screen's corner. Here the window starts SCREEN_Y px down.
    await context.addInitScript((offY) => {
      Object.defineProperty(MouseEvent.prototype, "screenX", { configurable: true, get() { return this.clientX; } });
      Object.defineProperty(MouseEvent.prototype, "screenY", { configurable: true, get() { return this.clientY + offY; } });
    }, SCREEN_Y / DPR);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost/dev/harness.html");
    await page.waitForTimeout(300);
    const cdp = await context.newCDPSession(page);

    // the firmware's side: pen-downs in screen pixels in, firmware requests out
    await page.evaluate(
      ([port]) =>
        new Promise((resolve, reject) => {
          window.fw = [];
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error("no Bridge"));
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === "firmware-test") window.fw.push(m);
          };
          window.rawPen = (x, y) => ws.send(JSON.stringify({ type: "raw-test", x, y, t: Date.now() }));
        }),
      [PORT],
    );
    // the plugin's side: the real instant ink code
    await page.evaluate(() => window.attachFastInk());

    const last = () => page.evaluate(() => window.fw[window.fw.length - 1] ?? null);
    async function waitFw(pred, ms = 5000) {
      const t0 = Date.now();
      let f = null;
      while (Date.now() - t0 < ms) {
        f = await last();
        if (f && pred(f)) return f;
        await page.waitForTimeout(100);
      }
      return f;
    }
    const box = await page.evaluate(() => {
      const r = window.surface.el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    // the page (the paper) on screen: where ink stays, and the firmware's drawing area
    const pageOnScreen = () =>
      page.evaluate(() => {
        const s = window.surface;
        const r = s.el.getBoundingClientRect();
        const x0 = Math.max(r.left, r.left + s.view.ox);
        const y0 = Math.max(r.top, r.top + s.view.oy);
        const x1 = Math.min(r.right, r.left + s.view.ox + s.page.w * s.view.scale);
        const y1 = Math.min(r.bottom, r.top + s.view.oy + s.page.h * s.view.scale);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      });
    const region = await pageOnScreen();
    const limitFor = (offY, r = region) => [Math.ceil(r.x) * DPR, Math.ceil(r.y) * DPR + offY, Math.floor(r.x + r.w) * DPR, Math.floor(r.y + r.h) * DPR + offY];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    async function pen(points, opts = {}) {
      const base = { pointerType: "pen", button: opts.side ? "right" : "left", buttons: opts.side ? 2 : 1, tiltX: 0, tiltY: 0 };
      const s0 = points[0];
      // the firmware's pen reader sees the pen-down first, in screen pixels (unless it does not draw there)
      if (!opts.firmwareMisses) await page.evaluate(([x, y]) => window.rawPen(x, y), [s0.x * DPR, s0.y * DPR + SCREEN_Y]);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: 0, force: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: 0.5, ...base });
      for (const s of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, force: 0.5, ...base });
      if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
      const e = points[points.length - 1];
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: e.x, y: e.y, clickCount: 1, force: 0, ...base, buttons: 0 });
    }
    const wave = (x0, y0) => Array.from({ length: 30 }, (_, i) => ({ x: x0 + i * 8, y: y0 + Math.sin(i / 3) * 20 }));

    console.log("Instant ink, plugin ⇄ Bridge (no firmware):");
    let f = await waitFw((m) => m.armed);
    check("pen tool on an open page: the firmware is asked to draw", f?.armed, JSON.stringify(f));
    check("…on the page, placed by the first guess until an event shows where Obsidian's window is", same(f?.limit, limitFor(GUESS_Y)), `${JSON.stringify(f?.limit)} vs ${JSON.stringify(limitFor(GUESS_Y))}`);
    check("…with the selected pen (fountain pen, black)", f?.pen?.style === 1 && f?.pen?.color === -16777216, JSON.stringify(f?.pen));
    check(
      "the firmware's area is the page (the paper), not the grey around it",
      f && f.limit[0] > Math.ceil(box.x) * DPR && f.limit[2] < Math.floor(box.x + box.w) * DPR,
      `${JSON.stringify(f?.limit)} in a view of ${JSON.stringify(box)}`,
    );

    // the pen only hovers over the page: that event shows where the window is on the screen
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 300, y: 400, pointerType: "pen", buttons: 0, force: 0 });
    f = await waitFw((m) => m.fromWindow);
    check("placed from Obsidian's window as soon as the pen hovers, before any stroke", f?.fromWindow && same(f?.limit, limitFor(SCREEN_Y)), `${JSON.stringify(f?.limit)} vs ${JSON.stringify(limitFor(SCREEN_Y))}`);
    check("…from the window position the plugin reported (24 CSS px down)", f?.win?.[1] === SCREEN_Y / DPR && f?.offset?.[1] === SCREEN_Y, JSON.stringify({ win: f?.win, offset: f?.offset }));
    check(
      "…and the ink view around the page goes along (hovering there is not leaving the page)",
      !!f?.surface && f.surface[0] <= f.limit[0] && f.surface[1] <= f.limit[1] && f.surface[2] >= f.limit[2] && f.surface[3] >= f.limit[3],
      JSON.stringify({ surface: f?.surface, limit: f?.limit }),
    );

    await pen(wave(150, 300));
    await page.waitForTimeout(300);
    f = await last();
    check("the first stroke only confirms the placement: nothing is measured or moved", f?.fromWindow && f.offset[1] === SCREEN_Y && f.offset[0] === 0 && same(f.correction, [0, 0]) && same(f?.limit, limitFor(SCREEN_Y)), JSON.stringify({ offset: f?.offset, correction: f?.correction, limit: f?.limit }));
    const strokes = await page.evaluate(() => window.surface.page.strokes.length);
    check("the plugin still records the stroke itself", strokes === 1, `strokes: ${strokes}`);

    // undo redraws the page: once it settles, the Bridge is asked to repaint (one request, not one per redraw)
    const clearsBefore = (await last())?.clears ?? 0;
    await page.evaluate(() => window.surface.undo());
    f = await waitFw((m) => m.clears > clearsBefore);
    check("undo: the Bridge repaints the page from Obsidian's drawing", f && f.clears === clearsBefore + 1, `clears ${clearsBefore} → ${f?.clears}`);
    await page.evaluate(() => window.surface.redo());
    await page.waitForTimeout(400);

    // the pen card over the page is left out of the firmware's area
    const tCard = Date.now();
    await page.click(".ink-tool-pen");
    await page.waitForSelector(".ink-pop-pen", { state: "visible" });
    const card = await page.evaluate(() => {
      const r = document.querySelector(".ink-pop-pen").getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    f = await waitFw((m) => m.armed && m.exclude.length > 0, 5000);
    const cardMs = Date.now() - tCard;
    check("…and the Bridge hears of the card at once (not at the next check a second later)", cardMs < 700, `${cardMs} ms`);
    const cardTop = Math.floor(Math.max(card.y, Math.ceil(region.y))) * DPR + SCREEN_Y - 4;
    const cardLeft = Math.floor(Math.max(card.x, Math.ceil(region.x))) * DPR - 4;
    const ex = f?.exclude?.find((r) => Math.abs(r[0] - cardLeft) <= 2);
    check("the open pen card is left out (never ink over the card)", !!ex && Math.abs(ex[1] - cardTop) <= 2, `${JSON.stringify(f?.exclude)} card ${JSON.stringify(card)}`);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, VIEW.height - 5);
    await page.waitForTimeout(200);

    // a pen press on a toolbar button: the Bridge hears of it the moment the press starts, before the
    // tool changes (it pauses the firmware, so the panel shows the change at its normal speed)
    const uiBefore = (await last())?.ui ?? 0;
    const lassoBtn = await page.evaluate(() => {
      const r = document.querySelector(".ink-tool-lasso").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const penBtn = { pointerType: "pen", button: "left", tiltX: 0, tiltY: 0 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: lassoBtn.x, y: lassoBtn.y, buttons: 0, force: 0, ...penBtn });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: lassoBtn.x, y: lassoBtn.y, clickCount: 1, buttons: 1, force: 0.5, ...penBtn });
    f = await waitFw((m) => m.ui > uiBefore, 2000);
    check("a pen press on the toolbar reaches the Bridge before the tool changes", f && f.ui === uiBefore + 1 && f.armed, JSON.stringify({ ui: f?.ui, armed: f?.armed }));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: lassoBtn.x, y: lassoBtn.y, clickCount: 1, buttons: 0, force: 0, ...penBtn });
    f = await waitFw((m) => !m.armed);
    check("lasso: the firmware stops drawing", f && !f.armed);
    check("…in the message that says it includes that press (the Bridge waits for exactly this)", f && f.uiDone === f.ui && f.ui === uiBefore + 1, JSON.stringify({ ui: f?.ui, uiDone: f?.uiDone }));
    const why = await page.evaluate(() => window.fastInk().onPage);
    check("…and the settings can say why", !why?.armed && /lasso tool/.test(why?.reason ?? ""), JSON.stringify(why));
    await page.evaluate(() => window.surface.setTools({ tool: "marker" }));
    await page.waitForTimeout(300);
    f = await last();
    check("highlighter: no firmware ink (it would cover the writing)", f && !f.armed);
    await page.evaluate(() => window.surface.setTools({ tool: "pen", pen: "brush", color: "#d32f2f" }));
    f = await waitFw((m) => m.armed && m.pen.style === 3);
    check("brush pen in red: the firmware's brush in red", f?.pen?.style === 3 && f?.pen?.color === (0xffd32f2f | 0), JSON.stringify(f?.pen));

    const w1 = f?.pen?.width;
    await page.evaluate(() => window.surface.zoomAt(2, 300, 400));
    f = await waitFw((m) => m.armed && Math.abs(m.pen.width - 2 * w1) < 0.2);
    check("zoomed in twice: the firmware's line is twice as wide", f && Math.abs(f.pen.width - 2 * w1) < 0.2, `${w1} → ${f?.pen?.width}`);
    await page.evaluate(() => window.surface.resetZoom());
    await page.evaluate(() => window.surface.setTools({ pen: "fountain", color: "#000000" }));

    // Obsidian keeps some pop-ups in the page while they are closed: they must not count
    await page.evaluate(() => {
      for (const cls of ["suggestion-container", "prompt", "menu"]) {
        const d = document.createElement("div");
        d.className = `${cls} hidden-popup`;
        d.style.display = "none";
        document.body.appendChild(d);
      }
    });
    await page.waitForTimeout(400);
    f = await last();
    const page1 = await page.evaluate(() => window.fastInk().onPage);
    check("closed Obsidian pop-ups left in the page do not stop instant ink", f?.armed && page1?.armed, JSON.stringify(page1));
    await page.evaluate(() => document.querySelectorAll(".hidden-popup").forEach((d) => d.remove()));

    // something of Obsidian's over the page: a modal, a sidebar
    // like Obsidian's: it covers the whole window
    await page.evaluate(() => {
      const m = document.createElement("div");
      m.className = "modal-container";
      m.style.cssText = "position:fixed;inset:0;z-index:60";
      document.body.appendChild(m);
    });
    f = await waitFw((m) => !m.armed);
    check("an Obsidian modal is open: the firmware stops", f && !f.armed);
    const why2 = await page.evaluate(() => window.fastInk().onPage);
    check("…and the settings say an Obsidian window is open", /modal-container/.test(why2?.reason ?? ""), JSON.stringify(why2));
    await page.evaluate(() => document.querySelector(".modal-container").remove());
    f = await waitFw((m) => m.armed);
    check("…and draws again when it closes", f?.armed);
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "drawer";
      d.style.cssText = "position:fixed;left:0;top:0;bottom:0;width:60%;background:#ccc;z-index:50";
      document.body.appendChild(d);
    });
    f = await waitFw((m) => !m.armed);
    check("a sidebar slides over the page: the firmware stops", f && !f.armed);
    await page.evaluate(() => document.getElementById("drawer").remove());
    f = await waitFw((m) => m.armed);
    // a small floating button of Obsidian's over the page is only left out
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "fab";
      b.style.cssText = "position:fixed;right:20px;bottom:20px;width:120px;height:120px;z-index:50";
      document.body.appendChild(b);
    });
    f = await waitFw((m) => m.armed && m.exclude.some((r) => r[2] - r[0] >= 240 && r[3] - r[1] >= 240));
    check("a small floating button over the page is left out, instant ink stays on", f?.armed && f.exclude.length > 0, JSON.stringify(f?.exclude));
    await page.evaluate(() => document.getElementById("fab").remove());
    f = await waitFw((m) => m.armed && m.exclude.length === 0);

    // a tooltip over the page takes no presses (Obsidian's have pointer-events: none): the pen writes
    // through it, so the firmware must draw there too – left out, those strokes showed nowhere
    await page.evaluate(() => {
      const t = document.createElement("div");
      t.className = "tooltip";
      t.id = "tip";
      t.textContent = "Fountain pen";
      t.style.cssText = "position:fixed;left:200px;top:150px;width:160px;height:40px;z-index:60;pointer-events:none;background:#333;color:#fff";
      document.body.appendChild(t);
    });
    await page.waitForTimeout(400);
    f = await last();
    check("a tooltip over the page is not left out (the pen writes through it)", f?.armed && f.exclude.length === 0, JSON.stringify(f?.exclude));
    await page.evaluate(() => document.getElementById("tip").remove());

    // a stroke that is not ink after all: hold to snap turns it into a line
    // writing on the page is not a press elsewhere
    const uiWriting = f?.ui ?? 0;
    await pen(wave(150, 700));
    await page.waitForTimeout(300);
    check("writing on the page does not count as a press elsewhere", ((await last())?.ui ?? 0) === uiWriting, `${uiWriting} → ${(await last())?.ui}`);
    check("…and the firmware drew it (no stroke missed)", ((await last())?.missed ?? -1) === 0, JSON.stringify((await last())?.missed));

    // a stroke in the grey around the page: no ink stays there, so the firmware does not draw there,
    // and that is not a missed stroke (no pause, no switch to Ink Notebook's own drawing)
    const missedBefore = (await last())?.missed ?? 0;
    const margin = await pageOnScreen();
    await pen(
      Array.from({ length: 10 }, (_, i) => ({ x: margin.x - 6, y: margin.y + 100 + i * 10 })),
      { firmwareMisses: true },
    );
    await page.waitForTimeout(500);
    check("a stroke in the grey margin beside the page is not a missed stroke", ((await last())?.missed ?? -1) === missedBefore, `${missedBefore} → ${(await last())?.missed}`);

    // a stroke where the firmware does not draw: the Bridge finds out at once (and pauses the firmware,
    // so the screen shows Ink Notebook's own drawing of it instead of nothing until the next tool change)
    const tMiss = Date.now();
    await pen(wave(400, 200), { firmwareMisses: true });
    f = await waitFw((m) => m.missed > 0, 2000);
    check("a stroke on the page the firmware did not draw is found within a moment", f?.missed === 1 && Date.now() - tMiss < 1500, `${f?.missed} after ${Date.now() - tMiss} ms`);

    const before = (await last())?.clears ?? 0;
    await pen(
      Array.from({ length: 24 }, (_, i) => ({ x: 120 + i * 12, y: 600 })),
      { holdMs: 900 },
    );
    f = await waitFw((m) => m.clears > before);
    check("hold to snap: the firmware's hand-drawn line is cleared for the clean one", f && f.clears > before, `clears ${before} → ${f?.clears}`);

    // the lease: when the plugin stops renewing, the Bridge stops on its own
    await page.evaluate(() => window.fastInk().destroy());
    f = await waitFw((m) => !m.armed, 3000);
    check("the plugin goes away: the firmware stops", f && !f.armed);

    check("no errors on the page", errors.length === 0, errors.join("\n"));
  } finally {
    await browser.close();
    java.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
