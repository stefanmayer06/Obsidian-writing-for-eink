// The recording rig of the promo video: a connection to the real Obsidian
// (through the Chrome DevTools protocol), a "take" that captures the window
// frame by frame, and a stylus, a finger and a keyboard that act on the window
// in virtual time: every frame (1/30 s) gets the input of its moment, then the
// window is captured. So the footage has an even pace however fast this
// machine is.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";

export const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const VAULT = path.join(E2E, "vault");
export const OUT = path.join(E2E, "shots", "promo");
export const MOCK = "http://127.0.0.1:8765";
export const FPS = 30;
/** The window: a Boox Note Air held upright (CSS pixels; 1404 × 1872 at 2×). */
export const WIN = { w: 702, h: 936 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mock = (cfg) => fetch(`${MOCK}/__config`, { method: "POST", body: JSON.stringify(cfg) });

/** The connection: `page` and `cdp` change when Obsidian reloads its window. */
export const rig = { browser: null, page: null, cdp: null };

export async function connect() {
  rig.browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  await attach();
}

export async function attach() {
  rig.page = rig.browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
  rig.cdp = await rig.page.context().newCDPSession(rig.page);
}

export const ev = (fn, arg) => rig.page.evaluate(fn, arg);

export async function installHelpers() {
  await ev(() => {
    window.__t = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      async waitFor(fn, timeout = 15000, label = "") {
        const t0 = Date.now();
        let last;
        while (Date.now() - t0 < timeout) {
          try {
            last = await fn();
            if (last) return last;
          } catch (e) {
            last = e;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`timeout waiting for ${label} (last: ${last})`);
      },
      plugin: () => app.plugins.plugins["ink-notebook"],
      view: () => app.workspace.getMostRecentLeaf()?.view,
      surface: () => app.workspace.getMostRecentLeaf()?.view?.surface,
      read: (p) => app.vault.read(app.vault.getAbstractFileByPath(p)),
      paint: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    };
  });
}

// ---------------------------------------------------------------- takes

/**
 * One scene's frames. `frame()` captures the window; `hold(n)` repeats the last
 * capture n times. Every frame records the pen ({ x, y } in CSS pixels of the
 * window, `down` while it touches the screen, `tap` on the frame of a tap) and
 * fingers on the screen (`touch`: [{ x, y }]).
 */
export class Take {
  constructor(name) {
    this.name = name;
    this.dir = path.join(OUT, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.files = 0;
    this.pen = null;
    this.touch = null;
    this.marks = {};
  }
  state(extra) {
    return { pen: this.pen ? { ...this.pen } : null, touch: this.touch ? this.touch.map((t) => ({ ...t })) : null, ...extra };
  }
  async frame(extra = {}) {
    await ev(() => __t.paint());
    const { data } = await rig.cdp.send("Page.captureScreenshot", { format: "png" });
    const file = `${String(++this.files).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(this.dir, file), Buffer.from(data, "base64"));
    this.frames.push({ file, ...this.state(extra) });
  }
  hold(n, extra = {}) {
    const last = this.frames[this.frames.length - 1];
    for (let i = 0; i < n; i++) this.frames.push({ file: last.file, ...this.state(extra) });
  }
  /** Name the current frame (the edit in timeline.mjs refers to these). */
  mark(name) {
    this.marks[name] = this.frames.length;
  }
  save(meta = {}) {
    fs.writeFileSync(path.join(this.dir, "manifest.json"), JSON.stringify({ name: this.name, fps: FPS, width: WIN.w, height: WIN.h, frames: this.frames, marks: this.marks, ...meta }, null, 1));
    console.log(`  🎞  ${this.name}: ${this.frames.length} frames (${(this.frames.length / FPS).toFixed(1)} s), ${this.files} captures, marks ${JSON.stringify(this.marks)}`);
  }
}

// ---------------------------------------------------------------- the stylus

/** Page coordinates → window coordinates of the open ink page. */
export async function mapping() {
  const m = await ev(() => {
    const s = __t.surface();
    const r = s.el.getBoundingClientRect();
    return { l: r.left, t: r.top, k: s.view.scale, ox: s.view.ox, oy: s.view.oy };
  });
  m.at = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  return m;
}

const mouse = (type, x, y, extra = {}) => rig.cdp.send("Input.dispatchMouseEvent", { type, x, y, pointerType: "pen", ...extra });
const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/** Move the lifted pen to a window point over `sec` seconds, one frame at a time. */
export async function travel(take, to, sec) {
  const from = take.pen ?? { x: to.x + 120, y: to.y + 160 };
  const n = Math.max(1, Math.round(sec * FPS));
  if (n === 1 && Math.hypot(to.x - from.x, to.y - from.y) < 40) {
    take.pen = { x: to.x, y: to.y, down: false };
    take.hold(1);
    return;
  }
  for (let i = 1; i <= n; i++) {
    const u = easeInOut(i / n);
    // a slight arc, like a hand lifting the pen
    const lift = Math.sin(Math.PI * u) * Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.15);
    take.pen = { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u - lift, down: false };
    await mouse("mouseMoved", take.pen.x, take.pen.y, { buttons: 0, force: 0 });
    take.hold(1); // nothing changes on the page while the pen moves above it
  }
}

/**
 * Write strokes (flat [x, y, pressure, …] arrays in page units) with the pen:
 * `speed` page units per second along the stroke, the pen travelling between
 * strokes. Every frame sends the points of its 1/30 s, then captures.
 * `hold` (ms): keep the pen down and still at the end (hold to snap); the
 * frames of the hold are captured too (`holdFrames`).
 */
export async function write(take, strokes, { speed = 600, gap = 0.12, m = null, hold = 0, holdFrames = 0, button = 1 } = {}) {
  m = m ?? (await mapping());
  for (const flat of strokes) {
    const pts = [];
    for (let i = 0; i < flat.length; i += 3) pts.push({ ...m.at(flat[i], flat[i + 1]), p: flat[i + 2], u: [flat[i], flat[i + 1]] });
    const d = take.pen ? Math.hypot(pts[0].x - take.pen.x, pts[0].y - take.pen.y) : 0;
    // the next letter is a quick hop, the next word or line a short trip
    if (take.pen && d > 2) await travel(take, pts[0], d < 25 ? 1 / FPS : Math.min(0.4, gap * 0.5 + d / 1400));
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].u[0] - pts[i - 1].u[0], pts[i].u[1] - pts[i - 1].u[1]));
    const total = len[len.length - 1];
    const dur = Math.max(1 / FPS, total / speed);
    await mouse("mouseMoved", pts[0].x, pts[0].y, { buttons: 0, force: 0 });
    await mouse("mousePressed", pts[0].x, pts[0].y, { button: "left", buttons: button, clickCount: 1, force: pts[0].p });
    take.pen = { x: pts[0].x, y: pts[0].y, down: true };
    let i = 1;
    const frames = Math.max(1, Math.round(dur * FPS));
    for (let f = 1; f <= frames; f++) {
      const reach = total * (f / frames);
      while (i < pts.length && len[i] <= reach + 1e-6) {
        await mouse("mouseMoved", pts[i].x, pts[i].y, { button: "left", buttons: button, force: pts[i].p });
        take.pen = { x: pts[i].x, y: pts[i].y, down: true };
        i++;
      }
      if (f < frames || hold) await take.frame();
    }
    if (hold) {
      // the pen rests: frames while the timer runs, then the snap
      const t0 = Date.now();
      for (let k = 0; k < holdFrames; k++) await take.frame();
      await sleep(Math.max(0, hold - (Date.now() - t0)));
      await take.frame();
    }
    const e = pts[pts.length - 1];
    await mouse("mouseReleased", e.x, e.y, { button: "left", buttons: 0, clickCount: 1, force: 0 });
    take.pen = { x: e.x, y: e.y, down: true };
    await take.frame();
    take.pen = { x: e.x, y: e.y, down: false };
  }
}

/** Tap with the pen on a window point (a button), after moving there. */
export async function tapAt(take, x, y, { sec = 0.4 } = {}) {
  await travel(take, { x, y }, sec);
  await mouse("mouseMoved", x, y, { buttons: 0, force: 0 });
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1, force: 0.5 });
  take.pen = { x, y, down: true };
  await take.frame({ tap: true });
  await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1, force: 0 });
  take.pen = { x, y, down: false };
}

/** The middle of an element (window coordinates). */
export async function centre(selector) {
  return ev((sel) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : null;
    if (!el) throw new Error(`no ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, selector);
}

/** Tap an element with the pen. */
export async function tapEl(take, selector, opts = {}) {
  const c = await centre(selector);
  await tapAt(take, c.x, c.y, opts);
  return c;
}

/** A finger swipe (touch events) from a to b over `sec`, captured frame by frame. */
export async function swipe(take, a, b, sec = 0.35) {
  const n = Math.max(2, Math.round(sec * FPS));
  const send = (type, pts) => rig.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
  await send("touchStart", [{ x: a.x, y: a.y, id: 3, radiusX: 9, radiusY: 9, force: 1 }]);
  take.touch = [{ x: a.x, y: a.y }];
  await take.frame();
  for (let i = 1; i <= n; i++) {
    const u = easeInOut(i / n);
    const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    await send("touchMove", [{ ...p, id: 3, radiusX: 9, radiusY: 9, force: 1 }]);
    take.touch = [p];
    await take.frame();
  }
  await send("touchEnd", []);
  take.touch = null;
}

/** Type text into the focused element, a few characters per frame. */
export async function typeText(take, text, { perFrame = 2 } = {}) {
  for (let i = 0; i < text.length; i += perFrame) {
    const chunk = text.slice(i, i + perFrame);
    for (const ch of chunk) {
      if (ch === "\n") await rig.page.keyboard.press("Enter");
      else await rig.page.keyboard.insertText(ch);
    }
    await take.frame();
  }
}

// ---------------------------------------------------------------- Obsidian

export async function setSettings(patch) {
  await ev(async (patch) => {
    const p = __t.plugin();
    Object.assign(p.settings, patch);
    await p.saveSettings();
    p.applyInkSettings();
  }, patch);
}

export async function closeModals() {
  for (let i = 0; i < 4; i++) {
    if ((await ev(() => document.querySelectorAll(".modal-container").length)) === 0) return;
    await ev(() => document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click()));
    await sleep(250);
    if ((await ev(() => document.querySelectorAll(".modal-container").length)) > 0) await rig.page.keyboard.press("Escape");
    await sleep(250);
  }
}

export async function closeLibrary() {
  await ev(() => document.querySelectorAll(".ink-library-panel .ink-library-close").forEach((b) => b.click()));
  await sleep(200);
}

/** Close the open tool card or menu (they close on Escape). */
export async function closePopovers() {
  await ev(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await sleep(200);
}

export async function setWindow(w, h) {
  await ev(({ w, h }) => {
    const win = window.require("@electron/remote").getCurrentWindow();
    win.unmaximize();
    win.setBounds({ x: 0, y: 0, width: w, height: h });
  }, { w, h });
  await sleep(900);
}

export async function waitView(type, file) {
  return ev(
    async ({ type, file }) => {
      await __t.waitFor(() => {
        const v = __t.view();
        return v && v.getViewType() === type && (!file || v.file?.path === file) && (type !== "ink-notebook" || v.inkFile);
      }, 15000, `view ${type} ${file ?? ""}`);
      await __t.sleep(300);
      return __t.view().file.path;
    },
    { type, file },
  );
}

export async function openFile(p, type) {
  await ev(async ({ p, type }) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type, state: { file: p }, active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, { p, type });
  await waitView(type, p);
}

/** One tab only, sidebars closed, no notices. */
export async function tidyWorkspace() {
  await ev(() => {
    const leaves = [];
    app.workspace.iterateRootLeaves((l) => leaves.push(l));
    const keep = app.workspace.getMostRecentLeaf();
    for (const l of leaves) if (l !== keep) l.detach();
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
    document.querySelectorAll(".notice").forEach((n) => n.remove());
  });
}

export async function tool(patch) {
  await ev((patch) => __t.surface().setTools(patch), patch);
}

/** What the mock Azure reads next: for each writing area its lines, top to bottom. */
export async function recognise(...areas) {
  await ev(() => __t.plugin().ocr.cache.clear());
  await mock({ reset: true, responses: [], fallback: null, pool: areas });
}

export async function remove(...paths) {
  await ev(async (paths) => {
    for (const p of paths) {
      const f = app.vault.getAbstractFileByPath(p);
      if (f) await app.vault.delete(f, true);
    }
  }, paths);
  await sleep(300);
}

/** A new ink page with the "New ink page" command, in Ink/ (ink file in Ink/Attachments/). */
export async function newInkPage(name) {
  await closeModals();
  await closePopovers();
  await closeLibrary();
  await remove(`Ink/Attachments/${name}.ink.md`, `Ink/${name}.md`);
  await setSettings({ askForPageName: true });
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  await ev(async (name) => {
    const input = await __t.waitFor(() => document.querySelector(".modal.ink-modal input.ink-wide-input"), 5000, "name prompt");
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, name);
  await setSettings({ askForPageName: false });
  await waitView("ink-notebook", `Ink/Attachments/${name}.ink.md`);
  await tidyWorkspace();
  await sleep(500);
}

let idn = 0;
export const sid = (p) => `${p}${(++idn).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Put strokes on the open page at once (what was written before the scene). */
export async function addInk(items) {
  await ev((items) => {
    const s = __t.surface();
    const p = s.page;
    const strokes = items.map((it) => {
      const o = { id: it.id, pen: it.pen ?? "fountain", color: it.color ?? "#000000", width: it.width ?? 1.8, pts: Float32Array.from(it.pts) };
      for (const k of ["poly", "closed", "arrow", "dash", "fill", "fillStyle", "from", "to", "elbow"]) if (it[k]) o[k] = it[k];
      return o;
    });
    s.commitPage({ ...p, strokes: [...p.strokes, ...strokes] }, "all");
  }, items.map((it) => ({ id: it.id ?? sid("s"), ...it })));
}


export const paper = (style, color = "white", spacing = "normal") => ({ kind: "paper", paper: { style, spacing, color, orientation: "portrait" } });

// ---------------------------------------------------------------- geometry

export const flat = (pts, p = 0.5) => pts.flatMap(([x, y]) => [x, y, p]);

/** Points every few units along a polyline. */
export function along(corners, step = 6) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** A hand-drawn ellipse (circling a word, a lasso loop). */
export function ellipse(cx, cy, rx, ry, turns = 1.08, start = -2.6, n = 48) {
  const pts = [];
  for (let i = 0; i <= n * turns; i++) {
    const a = start + (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a) * (1 + 0.03 * Math.sin(i / 5)), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** A shape as the shape tool draws it. */
export const rect = (x, y, w, h, extra = {}) => ({ id: sid("r"), pts: flat([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), poly: true, closed: true, ...extra });
export const oval = (cx, cy, rx, ry, extra = {}) => {
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return { id: sid("o"), pts: flat(pts), poly: true, closed: true, ...extra };
};

