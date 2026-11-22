import { containsPoint, type Pt } from "../core/geometry";
import { linkBounds } from "../core/ink/geom";
import { inkPageForPdfPage, pdfLinkAt, type PdfLink } from "../core/pdfLinks";
import { flingStep, flingVelocity, type MoveSample } from "../core/fling";
import { handLinkBadge } from "./render";
import type { InkSurface } from "./surface";
import { createSession, type InputPt, type ToolSession } from "./tools";
import type { ToolId } from "./types";

/**
 * Routes pointer input like the Boox Notes app:
 *  - the pen writes with the selected tool; its eraser end (or the side button) erases.
 *    On Android (Samsung S Pen, Boox) the side button is only reported while the pen hovers,
 *    so it counts when it is held as the pen touches the screen
 *  - fingers turn pages (swipe), pan and zoom (pinch); two-finger tap undoes,
 *    three-finger tap redoes; a finger never writes unless finger drawing is on
 *  - a finger tap (or a Ctrl/Cmd+click) on a link inside a PDF page follows it;
 *    the pen and a plain click write over PDF links as anywhere else
 *  - touches while the pen is near the screen are ignored (palm rejection)
 *  - a mouse writes like the pen; the wheel turns pages, Ctrl+wheel zooms
 */

interface TouchInfo {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

type GestureMode = "none" | "pan" | "pinch" | "swipe";

interface Gesture {
  start: number;
  max: number;
  moved: boolean;
  mode: GestureMode;
  /** Pinch reference (distance and centre at its start). */
  d0: number;
  c0: Pt;
  /** CSS transform being applied to the stage. */
  k: number;
  tx: number;
  ty: number;
  /** Pan offset before a pinch started. */
  baseTx: number;
  baseTy: number;
  /** A finger that was drawing (finger drawing on) when a second one came down. */
  ended: boolean;
  /** Continuous scroll: the pan moved the view itself as it went (tx/ty are already applied). */
  live: boolean;
  /** Recent pan positions, for the speed at which the finger let go. */
  samples: MoveSample[];
  /** It began by stopping a fling: a quick touch then is not a tap. */
  caught: boolean;
}

const PALM_MS = 700;
/** How long what the hovering pen last reported still tells whether its side button is held. */
const HOVER_BUTTON_MS = 1000;
const TAP_MS = 320;
const TAP_PX = 12;

export class InputRouter {
  private session: ToolSession | null = null;
  private sessionPointer = -1;
  private rect: DOMRect | null = null;
  private lastPenTime = 0;
  /** The pen's buttons when it last hovered above the screen, and when (performance.now()). */
  private penHover = { buttons: 0, t: -Infinity };
  private usingRaw = false;
  private touches = new Map<number, TouchInfo>();
  private gesture: Gesture | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private wheelAcc = 0;
  private lastWheelTurn = 0;
  /** A press on a link: it is followed if the pointer comes up without moving. */
  private link: { open: (newTab: boolean) => void; x: number; y: number; pointer: number } | null = null;
  private mousePan: { x: number; y: number; ox: number; oy: number; pointer: number } | null = null;
  private listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions | undefined]> = [];
  /** When the pen (or mouse/finger) last wrote, erased or selected (performance.now()). */
  lastActivity = 0;

  constructor(private s: InkSurface) {
    const el = s.el;
    this.on(el, "pointerdown", (e) => this.onDown(e as PointerEvent), { passive: false });
    this.on(el, "pointermove", (e) => this.onMove(e as PointerEvent, false));
    if ("onpointerrawupdate" in window) this.on(el, "pointerrawupdate", (e) => this.onMove(e as PointerEvent, true));
    this.on(el, "pointerup", (e) => this.onUp(e as PointerEvent));
    this.on(el, "pointercancel", (e) => this.onCancel(e as PointerEvent));
    this.on(el, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on(el, "contextmenu", (e) => {
      if (!this.isUi(e.target)) e.preventDefault();
    });
    // keep Obsidian's own swipe gestures (sidebars, pull-down) away from the page
    for (const name of ["touchstart", "touchmove", "touchend"]) {
      this.on(el, name, (e) => {
        if (this.isUi(e.target)) return;
        e.stopPropagation();
        if (name === "touchmove" && e.cancelable) e.preventDefault();
      }, { passive: false });
    }
  }

  private on(target: EventTarget, name: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(name, fn, opts);
    this.listeners.push([target, name, fn, opts]);
  }

  destroy(): void {
    this.cancel();
    for (const [t, n, f, o] of this.listeners) t.removeEventListener(n, f, o);
    this.listeners = [];
  }

  /** A tool or gesture is running (do not redraw everything now). */
  get busy(): boolean {
    return !!this.session || !!this.gesture;
  }

  /** A fling is still moving the page. */
  get flinging(): boolean {
    return this.fling !== null;
  }

  /** Stop whatever is running (page turn, undo, …). */
  cancel(): void {
    this.stopFling();
    if (this.session) {
      const sess = this.session;
      this.session = null;
      this.sessionPointer = -1;
      sess.cancel();
    }
    if (this.gesture) this.endGesture(false);
    this.touches.clear();
    this.link = null;
    this.mousePan = null;
  }

  private isUi(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".ink-ui");
  }

  private point(e: PointerEvent, last?: InputPt): InputPt {
    const rect = this.rect ?? this.s.el.getBoundingClientRect();
    const p = this.s.toPage(e.clientX, e.clientY, rect);
    let pressure = e.pressure;
    if (e.pointerType !== "pen" || !this.s.settings.pressure) pressure = 0.5;
    else if (!(pressure > 0)) pressure = last?.p ?? 0.5;
    return { x: p.x, y: p.y, p: pressure, t: e.timeStamp, cx: e.clientX, cy: e.clientY };
  }

  private points(e: PointerEvent): InputPt[] {
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const events = list.length > 0 ? list : [e];
    const out: InputPt[] = [];
    for (const ev of events) out.push(this.point(ev, out[out.length - 1]));
    return out;
  }

  /** The tool for a pen/mouse press: the eraser end and the side button override the selected tool. */
  private toolFor(e: PointerEvent): ToolId | "none" {
    if (e.pointerType === "pen") {
      if ((e.buttons & 32) !== 0 || e.button === 5) return "eraser";
      if ((e.buttons & 2) !== 0 || e.button === 2 || this.sideButtonHovered()) {
        const a = this.s.settings.sideButton;
        return a === "none" ? this.s.tools.tool : a;
      }
    } else if (e.pointerType === "mouse" && e.button !== 0) {
      return "none";
    }
    return this.s.tools.tool;
  }

  /**
   * Remember the buttons of a hovering pen. Chromium on Android (Obsidian's WebView) never
   * reports the side button while the pen touches the screen – a pen down always has
   * buttons 1 – but while it hovers it does, as the left button (crbug.com/816504).
   */
  private trackHover(e: PointerEvent, now: number): void {
    if (e.pressure !== 0 || e.pointerId === this.sessionPointer || e.pointerId === this.link?.pointer) return;
    this.penHover.buttons = e.buttons;
    this.penHover.t = now;
  }

  /** The hovering pen had a button held just before it touched the screen (Android). */
  private sideButtonHovered(): boolean {
    return this.penHover.buttons !== 0 && performance.now() - this.penHover.t < HOVER_BUTTON_MS;
  }

  /** A link chip (or handwritten link badge) under the point. */
  private linkAt(p: Pt): string | null {
    const page = this.s.page;
    const slack = 6 / this.s.view.scale;
    for (const l of page.links) {
      const r = linkBounds(l);
      if (containsPoint({ x: r.x - slack, y: r.y - slack, w: r.w + 2 * slack, h: r.h + 2 * slack }, p)) return l.target;
    }
    const hand = this.s.meta.handLinks;
    for (const st of page.strokes) {
      const target = hand[st.id];
      if (!target) continue;
      const b = handLinkBadge(st);
      if (containsPoint({ x: b.x - slack, y: b.y - slack, w: b.w + 2 * slack, h: b.h + 2 * slack }, p)) return target.replace(/^\[\[|\]\]$/g, "");
    }
    return null;
  }

  /** A link inside the PDF page shown as the background, under the point. */
  private pdfLinkAt(p: Pt): PdfLink | null {
    const page = this.s.page;
    if (page.bg.kind !== "pdf") return null;
    const links = this.s.images.pdfLinks?.(page.bg.path, page.bg.page);
    return links ? pdfLinkAt(links, page.w, page.h, p, 4 / this.s.view.scale) : null;
  }

  /** Open a web address, or turn to the ink page showing the PDF page the link points to. */
  private followPdfLink(l: PdfLink): void {
    if (l.url) {
      if (this.s.host.openUrl) this.s.host.openUrl(l.url);
      else window.open(l.url, "_blank");
      return;
    }
    const bg = this.s.page.bg;
    if (l.page === undefined || bg.kind !== "pdf") return;
    const index = inkPageForPdfPage(this.s.document.pages, bg.path, l.page);
    if (index >= 0) this.s.goTo(index);
    else this.s.host.notice?.(`Page ${l.page} of this PDF is not in the notebook`);
  }

  private startSession(e: PointerEvent, tool: ToolId, rect = this.s.el.getBoundingClientRect()): void {
    this.rect = rect;
    this.lastActivity = performance.now();
    this.usingRaw = false;
    const pt = this.point(e);
    this.session = createSession(this.s, tool, pt, { isPen: e.pointerType === "pen", ctrl: e.ctrlKey || e.metaKey });
    this.sessionPointer = e.pointerId;
    try {
      this.s.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private onDown(e: PointerEvent): void {
    if (this.isUi(e.target)) return;
    e.stopPropagation();
    // touching the page catches a fling where it is (and that touch is not a tap on what passes by)
    this.caughtFling = this.flinging;
    this.stopFling();
    const now = performance.now();
    if (e.pointerType === "touch") {
      // palm rejection: the pen is writing or hovering
      if (this.session?.pen || now - this.lastPenTime < PALM_MS) return;
      if (this.s.settings.fingerDrawing && !this.gesture && this.touches.size === 0 && !this.session) {
        e.preventDefault();
        this.focus();
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
        this.s.activatePageAt(e.clientY);
        this.startTouchDraw(e);
        return;
      }
      if (this.session && !this.session.pen) {
        // a second finger: it was a gesture, not writing
        const sess = this.session;
        this.session = null;
        this.sessionPointer = -1;
        sess.cancel();
      }
      this.touchDown(e);
      return;
    }
    if (e.pointerType === "pen") {
      this.lastPenTime = now;
      // a palm that landed first must not keep panning/zooming
      if (this.gesture) this.endGesture(false);
      this.touches.clear();
    }
    if (this.session) return;
    e.preventDefault();
    this.focus();
    if (e.pointerType === "mouse" && e.button === 1) {
      this.mousePan = { x: e.clientX, y: e.clientY, ox: this.s.view.ox, oy: this.s.view.oy, pointer: e.pointerId };
      this.s.el.setPointerCapture(e.pointerId);
      return;
    }
    const tool = this.toolFor(e);
    if (tool === "none") return;
    // continuous scroll: write on the page that was touched, also when it is the one above or below
    this.s.activatePageAt(e.clientY);
    if (e.pointerType === "pen") this.s.host.penDown?.(e.clientX, e.clientY, e.timeStamp);
    const rect = this.s.el.getBoundingClientRect();
    const p = this.s.toPage(e.clientX, e.clientY, rect);
    if (tool !== "lasso" && tool !== "eraser") {
      const target = this.linkAt(p);
      if (target) {
        this.link = { open: (newTab) => this.s.host.openLink(target, newTab), x: e.clientX, y: e.clientY, pointer: e.pointerId };
        return;
      }
    }
    if (e.pointerType === "mouse" && (e.ctrlKey || e.metaKey)) {
      const pdfLink = this.pdfLinkAt(p);
      if (pdfLink) {
        this.link = { open: () => this.followPdfLink(pdfLink), x: e.clientX, y: e.clientY, pointer: e.pointerId };
        return;
      }
    }
    this.startSession(e, tool, rect);
  }

  /** Focus the surface for keyboard shortcuts (only when it is not focused yet). */
  private focus(): void {
    if (this.s.el.ownerDocument.activeElement !== this.s.el) this.s.el.focus({ preventScroll: true });
  }

  private startTouchDraw(e: PointerEvent): void {
    this.startSession(e, this.s.tools.tool);
  }

  private onMove(e: PointerEvent, raw: boolean): void {
    if (e.pointerType === "pen") {
      this.lastPenTime = performance.now();
      this.trackHover(e, this.lastPenTime);
    }
    if (this.mousePan && e.pointerId === this.mousePan.pointer) {
      const v = this.s.view;
      this.s.view = { ...v, ox: this.mousePan.ox + e.clientX - this.mousePan.x, oy: this.mousePan.oy + e.clientY - this.mousePan.y };
      this.s.clampView();
      this.s.renderAll();
      this.s.selectionOverlay.update();
      return;
    }
    if (this.session && e.pointerId === this.sessionPointer) {
      if (raw) this.usingRaw = true;
      else if (this.usingRaw) return;
      this.lastActivity = performance.now();
      if (e.pointerType === "touch") {
        const t = this.touches.get(e.pointerId);
        if (t) {
          t.x = e.clientX;
          t.y = e.clientY;
        }
      }
      this.session.move(this.points(e));
      return;
    }
    if (raw || e.pointerType !== "touch") return;
    this.touchMove(e);
  }

  private onUp(e: PointerEvent): void {
    if (this.mousePan && e.pointerId === this.mousePan.pointer) {
      this.mousePan = null;
      return;
    }
    if (this.link && e.pointerId === this.link.pointer) {
      const l = this.link;
      this.link = null;
      // the pen tapped a link: whatever the Boox firmware drew there is not ink
      if (e.pointerType === "pen") this.s.host.inkDiscarded?.();
      if (Math.hypot(e.clientX - l.x, e.clientY - l.y) < TAP_PX) l.open(e.ctrlKey || e.metaKey);
      return;
    }
    if (this.session && e.pointerId === this.sessionPointer) {
      const sess = this.session;
      this.session = null;
      this.sessionPointer = -1;
      this.lastActivity = performance.now();
      this.touches.delete(e.pointerId);
      try {
        sess.up(this.point(e));
      } catch (err) {
        console.error("Ink Notebook: finishing the stroke failed", err);
      }
      return;
    }
    if (e.pointerType === "touch") this.touchUp(e);
  }

  private onCancel(e: PointerEvent): void {
    if (this.session && e.pointerId === this.sessionPointer) {
      const sess = this.session;
      this.session = null;
      this.sessionPointer = -1;
      // keep what was written with the pen (the system may cancel a pointer when a palm lands)
      if (sess.pen) sess.up(null);
      else sess.cancel();
      return;
    }
    if (e.pointerType === "touch") this.touchUp(e, true);
  }

  // ------------------------------------------------------------------ fingers

  private canPan(): { x: boolean; y: boolean } {
    const p = this.s.page;
    const v = this.s.view;
    return { x: p.w * v.scale > this.s.width + 1, y: this.s.scrolling || p.h * v.scale > this.s.height + 1 };
  }

  private touchDown(e: PointerEvent): void {
    e.preventDefault();
    const now = performance.now();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (!this.gesture) {
      this.gesture = { start: now, max: 1, moved: false, mode: "none", d0: 0, c0: { x: 0, y: 0 }, k: 1, tx: 0, ty: 0, baseTx: 0, baseTy: 0, ended: false, live: false, samples: [], caught: this.caughtFling };
    }
    const g = this.gesture;
    g.max = Math.max(g.max, this.touches.size);
    if (this.touches.size === 2) {
      // a live scroll is already in the view: the pinch starts from there
      if (g.live) {
        g.tx = 0;
        g.ty = 0;
        g.live = false;
      }
      const [a, b] = [...this.touches.values()];
      g.mode = "pinch";
      g.d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      g.c0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.baseTx = g.tx;
      g.baseTy = g.ty;
    }
  }

  private touchMove(e: PointerEvent): void {
    const t = this.touches.get(e.pointerId);
    const g = this.gesture;
    if (!t || !g || g.ended) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (g.mode === "pinch" && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!g.moved && (Math.abs(d - g.d0) > TAP_PX || Math.hypot(c.x - g.c0.x, c.y - g.c0.y) > TAP_PX)) g.moved = true;
      if (!g.moved) return;
      const rect = this.s.el.getBoundingClientRect();
      const k = d / g.d0;
      // the point under the fingers' centre stays under it
      const cx0 = g.c0.x - rect.left - g.baseTx;
      const cy0 = g.c0.y - rect.top - g.baseTy;
      g.k = k;
      g.tx = c.x - rect.left - cx0 * k;
      g.ty = c.y - rect.top - cy0 * k;
      this.applyStageTransform(g);
      return;
    }
    if (this.touches.size !== 1 || g.mode === "pinch") return;
    const dx = t.x - t.x0;
    const dy = t.y - t.y0;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < TAP_PX) return;
      g.moved = true;
      const pan = this.canPan();
      const horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal ? pan.x : pan.y) g.mode = "pan";
      else g.mode = this.s.settings.swipePages ? "swipe" : pan.x || pan.y ? "pan" : "none";
    }
    if (g.mode === "pan") {
      const pan = this.canPan();
      const tx = pan.x ? dx : 0;
      const ty = pan.y ? dy : 0;
      g.k = 1;
      const now = performance.now();
      g.samples.push({ t: now, x: tx, y: ty });
      if (g.samples.length > 12) g.samples.shift();
      if (this.s.scrolling) {
        // continuous scroll: move the view itself, so the next pages come into sight as you scroll
        this.s.scrollBy(tx - g.tx, ty - g.ty);
        g.tx = tx;
        g.ty = ty;
        g.live = true;
        return;
      }
      g.tx = tx;
      g.ty = ty;
      this.applyStageTransform(g);
    }
  }

  private applyStageTransform(g: Gesture): void {
    this.s.stage.style.transform = `translate(${g.tx}px, ${g.ty}px) scale(${g.k})`;
  }

  private touchUp(e: PointerEvent, cancelled = false): void {
    const t = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.mode === "pinch" && this.touches.size === 1) {
      // one finger lifted: the pinch is over, wait for the other one
      g.ended = true;
    }
    if (this.touches.size > 0) return;
    this.gesture = null;
    if (cancelled) {
      this.endGesture(false, g);
      return;
    }
    const now = performance.now();
    const quick = now - g.start < TAP_MS;
    if (!g.moved && quick) {
      if (g.caught && g.max === 1) return;
      if (g.max === 2 && this.s.settings.twoFingerUndo) this.s.undo();
      else if (g.max === 3 && this.s.settings.threeFingerRedo) this.s.redo();
      else if (g.max === 1 && t) this.tap(t);
      return;
    }
    if (g.mode === "swipe" && t) {
      const dx = t.x - t.x0;
      const dy = t.y - t.y0;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.3 * Math.abs(dy)) {
        if (dx < 0) this.s.next();
        else this.s.prev();
      } else if (Math.abs(dy) > 80 && Math.abs(dy) > 1.3 * Math.abs(dx)) {
        if (dy < 0) this.s.next();
        else this.s.prev();
      }
      return;
    }
    this.endGesture(true, g);
    if (g.mode === "pan") {
      const { vx, vy } = flingVelocity(g.samples, now);
      if (vx !== 0 || vy !== 0) this.startFling(vx, vy);
    }
  }

  // ------------------------------------------------------------------ momentum

  private fling: { vx: number; vy: number; t: number; frame: number } | null = null;
  /** The last touch stopped a fling. */
  private caughtFling = false;

  /** Keep scrolling at the speed the finger let go with, slowing down until it stops. */
  private startFling(vx: number, vy: number): void {
    this.stopFling();
    const win = this.s.el.ownerDocument.defaultView ?? window;
    const tick = (t: number) => {
      const f = this.fling;
      if (!f) return;
      const step = flingStep(f.vx, f.vy, t - f.t);
      f.vx = step.vx;
      f.vy = step.vy;
      f.t = t;
      const before = this.s.view;
      const page = this.s.pageIndex;
      this.s.scrollBy(step.dx, step.dy);
      const after = this.s.view;
      // the end of the notebook (or of the page) stops it
      const stuck = page === this.s.pageIndex && Math.abs(after.ox - before.ox) + Math.abs(after.oy - before.oy) < 0.01 && Math.abs(step.dx) + Math.abs(step.dy) > 0.01;
      if (step.done || stuck) {
        this.fling = null;
        return;
      }
      f.frame = win.requestAnimationFrame(tick);
    };
    this.fling = { vx, vy, t: performance.now(), frame: win.requestAnimationFrame(tick) };
  }

  /** A touch, the pen or the wheel stops a fling where it is. */
  private stopFling(): void {
    if (!this.fling) return;
    (this.s.el.ownerDocument.defaultView ?? window).cancelAnimationFrame(this.fling.frame);
    this.fling = null;
  }

  /** Apply (or drop) the CSS transform of a pan/pinch to the real view. */
  private endGesture(apply: boolean, g: Gesture | null = this.gesture): void {
    this.gesture = null;
    this.s.stage.style.removeProperty("transform");
    if (!g || !apply || g.live || (g.k === 1 && g.tx === 0 && g.ty === 0)) return;
    const v = this.s.view;
    this.s.setView({ scale: v.scale * g.k, ox: v.ox * g.k + g.tx, oy: v.oy * g.k + g.ty });
  }

  private tap(t: TouchInfo): void {
    const rect = this.s.el.getBoundingClientRect();
    this.s.activatePageAt(t.y, rect);
    const p = this.s.toPage(t.x, t.y, rect);
    const target = this.linkAt(p);
    if (target) {
      this.s.host.openLink(target, false);
      return;
    }
    const pdfLink = this.pdfLinkAt(p);
    if (pdfLink) {
      this.lastTap = null;
      this.followPdfLink(pdfLink);
      return;
    }
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.t < 400 && Math.hypot(t.x - last.x, t.y - last.y) < 40) {
      this.lastTap = null;
      // double tap: back to the whole page, or zoom in
      if (this.s.zoomed) this.s.resetZoom();
      else this.s.zoomAt(2, t.x - rect.left, t.y - rect.top);
      return;
    }
    this.lastTap = { t: now, x: t.x, y: t.y };
  }

  // ------------------------------------------------------------------ wheel

  private onWheel(e: WheelEvent): void {
    if (this.isUi(e.target)) return;
    e.preventDefault();
    this.stopFling();
    const rect = this.s.el.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.s.height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      this.s.zoomAt(Math.exp(-dy * 0.0025), e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    const pan = this.canPan();
    if ((pan.y && Math.abs(dy) >= Math.abs(dx)) || (pan.x && Math.abs(dx) > Math.abs(dy))) {
      const v = this.s.view;
      const before = { ox: v.ox, oy: v.oy };
      this.s.view = { ...v, ox: v.ox - (e.shiftKey ? dy : dx), oy: v.oy - (e.shiftKey ? 0 : dy) };
      this.s.clampView();
      const moved = Math.abs(this.s.view.oy - before.oy) + Math.abs(this.s.view.ox - before.ox) > 0.5;
      if (moved) {
        this.s.renderAll();
        this.s.selectionOverlay.update();
        this.s.textEditor.position();
        return;
      }
    }
    // at the end of the page (or when it fits): turn the page
    const now = performance.now();
    this.wheelAcc += dy;
    if (Math.abs(this.wheelAcc) > 90 && now - this.lastWheelTurn > 400) {
      const forward = this.wheelAcc > 0;
      this.wheelAcc = 0;
      this.lastWheelTurn = now;
      const before = this.s.pageIndex;
      if (forward) this.s.next();
      else this.s.prev();
      if (this.s.pageIndex !== before && this.canPan().y) {
        // continue at the top (going forward) or the bottom (going back) of the page
        const v = this.s.view;
        this.s.view = { ...v, oy: forward ? 1e6 : -1e6 };
        this.s.clampView();
        this.s.renderAll();
      }
    }
    if (now - this.lastWheelTurn > 600) this.wheelAcc *= 0.5;
  }
}
