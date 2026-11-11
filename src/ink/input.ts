import { containsPoint, type Pt } from "../core/geometry";
import { linkBounds } from "../core/ink/geom";
import { handLinkBadge } from "./render";
import type { InkSurface } from "./surface";
import { createSession, type InputPt, type ToolSession } from "./tools";
import type { ToolId } from "./types";

/**
 * Routes pointer input like the Boox Notes app:
 *  - the pen writes with the selected tool; its eraser end (or the side button) erases
 *  - fingers turn pages (swipe), pan and zoom (pinch); two-finger tap undoes,
 *    three-finger tap redoes; a finger never writes unless finger drawing is on
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
}

const PALM_MS = 700;
const TAP_MS = 320;
const TAP_PX = 12;

export class InputRouter {
  private session: ToolSession | null = null;
  private sessionPointer = -1;
  private rect: DOMRect | null = null;
  private lastPenTime = 0;
  private usingRaw = false;
  private touches = new Map<number, TouchInfo>();
  private gesture: Gesture | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private wheelAcc = 0;
  private lastWheelTurn = 0;
  private link: { target: string; x: number; y: number; pointer: number } | null = null;
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

  /** Stop whatever is running (page turn, undo, …). */
  cancel(): void {
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
      if ((e.buttons & 2) !== 0 || e.button === 2) {
        const a = this.s.settings.sideButton;
        return a === "none" ? this.s.tools.tool : a;
      }
    } else if (e.pointerType === "mouse" && e.button !== 0) {
      return "none";
    }
    return this.s.tools.tool;
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
    const now = performance.now();
    if (e.pointerType === "touch") {
      // palm rejection: the pen is writing or hovering
      if (this.session?.pen || now - this.lastPenTime < PALM_MS) return;
      if (this.s.settings.fingerDrawing && !this.gesture && this.touches.size === 0 && !this.session) {
        e.preventDefault();
        this.focus();
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
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
    if (e.pointerType === "pen") this.s.host.penDown?.(e.clientX, e.clientY);
    const rect = this.s.el.getBoundingClientRect();
    if (tool !== "lasso" && tool !== "eraser") {
      const target = this.linkAt(this.s.toPage(e.clientX, e.clientY, rect));
      if (target) {
        this.link = { target, x: e.clientX, y: e.clientY, pointer: e.pointerId };
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
    if (e.pointerType === "pen") this.lastPenTime = performance.now();
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
      if (Math.hypot(e.clientX - l.x, e.clientY - l.y) < TAP_PX) this.s.host.openLink(l.target, e.ctrlKey || e.metaKey);
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
    return { x: p.w * v.scale > this.s.width + 1, y: p.h * v.scale > this.s.height + 1 };
  }

  private touchDown(e: PointerEvent): void {
    e.preventDefault();
    const now = performance.now();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    if (!this.gesture) {
      this.gesture = { start: now, max: 1, moved: false, mode: "none", d0: 0, c0: { x: 0, y: 0 }, k: 1, tx: 0, ty: 0, baseTx: 0, baseTy: 0, ended: false };
    }
    const g = this.gesture;
    g.max = Math.max(g.max, this.touches.size);
    if (this.touches.size === 2) {
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
      g.k = 1;
      g.tx = pan.x ? dx : 0;
      g.ty = pan.y ? dy : 0;
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
  }

  /** Apply (or drop) the CSS transform of a pan/pinch to the real view. */
  private endGesture(apply: boolean, g: Gesture | null = this.gesture): void {
    this.gesture = null;
    this.s.stage.style.removeProperty("transform");
    if (!g || !apply || (g.k === 1 && g.tx === 0 && g.ty === 0)) return;
    const v = this.s.view;
    this.s.setView({ scale: v.scale * g.k, ox: v.ox * g.k + g.tx, oy: v.oy * g.k + g.ty });
  }

  private tap(t: TouchInfo): void {
    const rect = this.s.el.getBoundingClientRect();
    const p = this.s.toPage(t.x, t.y, rect);
    const target = this.linkAt(p);
    if (target) {
      this.s.host.openLink(target, false);
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
