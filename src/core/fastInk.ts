import type { PenType } from "./ink/model";

/**
 * Instant ink on Onyx Boox tablets: the messages for the Ink Notebook Bridge
 * app (protocol version 1, see docs/boox-fast-ink-plan.md and android/).
 *
 * The Bridge turns on the Boox firmware's own pen drawing – the way the Boox
 * Notes app shows ink with no lag – over the ink page. The plugin still gets the
 * pen as always and records the stroke; it only tells the Bridge where the page
 * is, which parts of it its toolbars and cards cover, which pen is selected, and
 * until when that holds (a lease it renews while the page is open).
 *
 * Rectangles are CSS pixels of Obsidian's window. The plugin also says where that
 * window is on the screen (Android gives every touch its screen position too), so
 * the Bridge places them exactly instead of measuring the place from strokes.
 */

export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pen the firmware draws with: an Onyx stroke style, the width in device pixels, a colour. */
export interface FastInkPen {
  style: FastInkStyle;
  width: number;
  color: string;
}

export type FastInkStyle = "pencil" | "fountain" | "marker" | "brush" | "charcoal" | "dash" | "charcoal2";

/**
 * Where Obsidian's window is on the screen, in CSS pixels: its top-left corner (`x`, `y`, from the
 * pen's and fingers' events, which carry both positions), its size (`w`, `h`) and the screen's
 * (`sw`, `sh`). With it the Bridge needs nothing measured: a CSS pixel at (cx, cy) is the screen pixel
 * ((cx + x) × dpr, (cy + y) × dpr).
 */
export interface FastInkWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  sw: number;
  sh: number;
}

export interface FastInkMessage {
  v: 1;
  type: "state";
  seq: number;
  armed: boolean;
  /** Wall clock ms until which this holds. */
  until: number;
  dpr: number;
  /** Where the pen writes ink: the part of the page that is on screen. The firmware draws here. */
  region: CssRect | null;
  exclude: CssRect[];
  /** The whole page (it may reach past the screen when zoomed in). */
  page?: CssRect;
  /** The ink view around the page: the pen hovering here is not away from the page (the firmware keeps drawing). */
  surface?: CssRect;
  /** Where Obsidian's window is on the screen (once an event has shown it). */
  win?: FastInkWindow;
  pen: FastInkPen;
  refreshMs: number;
  sideButtonErases: boolean;
  /** Counts strokes that were not ink after all (the Bridge takes their fast ink away). */
  clear: number;
  /** The last pen-down (CSS pixels, wall clock ms): the Bridge measures where the window is with it. */
  down?: { x: number; y: number; t: number };
  /**
   * The pen-downs of the last moments (each is sent the moment it happens). The Bridge checks that
   * the firmware drew each of these strokes, and pauses the firmware if not.
   */
  downs?: Array<{ x: number; y: number; t: number }>;
  /** Wall clock ms when this was sent (the Bridge waits for a state sent after the pen visited a toolbar). */
  at: number;
  /**
   * Counts presses on anything but the page (toolbars, cards, Obsidian), sent the moment the press
   * starts: the firmware pauses at once, so the panel shows what the press changes without delay.
   */
  ui: number;
  /**
   * The presses (of `ui`) this message already includes the result of: the Bridge waits for it after
   * a press instead of for a fixed time, so the firmware draws again the moment the new pen is known.
   */
  uiDone: number;
}

/** What the Bridge reports back. */
export interface FastInkStatus {
  v: 1;
  type: "status";
  app?: string;
  at: number;
  armed: boolean;
  calibrated: boolean;
  transport?: string;
  error?: string;
  /** What the firmware's pen reader reported to the Bridge (since it started). */
  penHovers?: number;
  penStrokes?: number;
  /** Why the firmware is paused although instant ink is on (the pen is over a toolbar, …). */
  paused?: string;
  /** Strokes the firmware did not draw (Ink Notebook's own drawing showed them), and where the last was (CSS pixels). */
  missed?: number;
  lastMissed?: { x: number; y: number };
  /** The firmware's drawing area, in the Bridge's words. */
  area?: string;
  /** How the Bridge placed the page on screen, in its words ("from Obsidian's window", "measured from strokes"). */
  placement?: string;
}

/** What the page looks like right now, measured by the view. */
export interface FastInkInputs {
  /** The page can take ink now: it is on screen, nothing covers it, the pen tool is selected. */
  ready: boolean;
  /** Where the pen writes ink (the page's part on screen). */
  region: CssRect | null;
  exclude: CssRect[];
  /** The whole page, and the ink view around it. */
  page?: CssRect | null;
  surface?: CssRect | null;
  win?: FastInkWindow | null;
  pen: FastInkPen | null;
  dpr: number;
  refreshMs: number;
  sideButtonErases: boolean;
  /** Why the page cannot take instant ink now, in words (null when it can). */
  reason?: string | null;
}

/**
 * The firmware's stroke style closest to each pen. The highlighter has none:
 * the firmware would paint it opaque over the writing, so it keeps the normal
 * (slower) path.
 */
export const FAST_INK_STYLES: Record<PenType, FastInkStyle | null> = {
  fountain: "fountain",
  calligraphy: "fountain",
  ballpoint: "pencil",
  pencil: "charcoal2",
  brush: "brush",
  marker: null,
};

const DEFAULT_PEN: FastInkPen = { style: "pencil", width: 3, color: "#000000" };

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The firmware pen for a plugin pen of `width` page units, at `scale` CSS px per page unit. */
export function fastInkPen(pen: PenType, width: number, color: string, scale: number, dpr: number): FastInkPen | null {
  const style = FAST_INK_STYLES[pen];
  if (!style) return null;
  const px = width * scale * dpr;
  return {
    style,
    width: round1(Math.max(0.5, Math.min(200, Number.isFinite(px) ? px : 3))),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#000000",
  };
}

/** `r` rounded outwards to whole CSS pixels. */
export function roundOut(r: CssRect): CssRect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y };
}

/** `r` rounded inwards to whole CSS pixels. */
export function roundIn(r: CssRect): CssRect {
  const x = Math.ceil(r.x);
  const y = Math.ceil(r.y);
  return { x, y, w: Math.max(0, Math.floor(r.x + r.w) - x), h: Math.max(0, Math.floor(r.y + r.h) - y) };
}

/** The overlap of two rectangles, or null when they do not overlap. */
export function intersect(a: CssRect, b: CssRect): CssRect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

const round1Rect = (r: CssRect): CssRect => ({ x: round1(r.x), y: round1(r.y), w: round1(r.w), h: round1(r.h) });

/** The parts of `rects` inside `region` (rounded outwards), without empty ones and duplicates. */
export function clipRects(region: CssRect, rects: ReadonlyArray<CssRect>): CssRect[] {
  const out: CssRect[] = [];
  const keys = new Set<string>();
  for (const r of rects) {
    const x0 = Math.max(region.x, r.x);
    const y0 = Math.max(region.y, r.y);
    const x1 = Math.min(region.x + region.w, r.x + r.w);
    const y1 = Math.min(region.y + region.h, r.y + r.h);
    if (!(x1 > x0 && y1 > y0)) continue;
    const c = roundOut({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const key = `${c.x},${c.y},${c.w},${c.h}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(c);
  }
  return out;
}

/** Whether the firmware should draw for these inputs. */
export function isArmed(inputs: FastInkInputs): boolean {
  const r = inputs.region;
  return inputs.ready && !!inputs.pen && !!r && r.w > 0 && r.h > 0;
}

/** The message for the Bridge. */
export function buildMessage(
  inputs: FastInkInputs,
  opts: {
    seq: number;
    now: number;
    leaseMs: number;
    clear: number;
    ui?: number;
    uiDone?: number;
    down?: { x: number; y: number; t: number } | null;
    downs?: ReadonlyArray<{ x: number; y: number; t: number }>;
  },
): FastInkMessage {
  const armed = isArmed(inputs);
  const region = inputs.region ? roundIn(inputs.region) : null;
  const msg: FastInkMessage = {
    v: 1,
    type: "state",
    seq: opts.seq,
    armed,
    until: opts.now + opts.leaseMs,
    dpr: Math.round(inputs.dpr * 1000) / 1000,
    region,
    exclude: region ? clipRects(region, inputs.exclude) : [],
    pen: inputs.pen ?? DEFAULT_PEN,
    refreshMs: Math.round(inputs.refreshMs),
    sideButtonErases: inputs.sideButtonErases,
    clear: opts.clear,
    at: Math.round(opts.now),
    ui: opts.ui ?? 0,
    uiDone: opts.uiDone ?? opts.ui ?? 0,
  };
  if (inputs.page) msg.page = round1Rect(inputs.page);
  if (inputs.surface) msg.surface = roundOut(inputs.surface);
  if (inputs.win) {
    const w = inputs.win;
    msg.win = { x: round1(w.x), y: round1(w.y), w: round1(w.w), h: round1(w.h), sw: round1(w.sw), sh: round1(w.sh) };
  }
  if (opts.down) msg.down = { x: round1(opts.down.x), y: round1(opts.down.y), t: Math.round(opts.down.t) };
  if (opts.downs?.length) msg.downs = opts.downs.map((d) => ({ x: round1(d.x), y: round1(d.y), t: Math.round(d.t) }));
  return msg;
}

/** Two messages ask the Bridge for the same thing (the lease, the time and the pen-down aside). */
export function sameRequest(a: FastInkMessage | null, b: FastInkMessage | null): boolean {
  if (!a || !b) return a === b;
  const strip = (m: FastInkMessage) => JSON.stringify({ ...m, seq: 0, until: 0, at: 0, down: undefined, downs: undefined });
  return strip(a) === strip(b);
}

/**
 * Where Obsidian's window is on the screen, from pointer events.
 *
 * On Android every touch and pen event carries the position on the screen as well as in the window
 * (Chromium fills `screenX/Y` from the raw screen position), so `screen − client` is where the window
 * starts, in CSS pixels – the status bar, a split screen, whatever. It is the same for every event;
 * the median of the last few is kept, and changed only by a real move (more than a pixel), so the
 * Bridge is not told about rounding noise.
 */
export class WindowOrigin {
  private xs: number[] = [];
  private ys: number[] = [];
  value: { x: number; y: number } | null = null;

  /** An event at (clientX, clientY) in the window and (screenX, screenY) on the screen. True when the value changed. */
  add(clientX: number, clientY: number, screenX: number, screenY: number): boolean {
    const dx = screenX - clientX;
    const dy = screenY - clientY;
    if (![clientX, clientY, screenX, screenY].every(Number.isFinite)) return false;
    // no screen position at all (made-up events)
    if (screenX === 0 && screenY === 0 && (clientX !== 0 || clientY !== 0)) return false;
    // a window far off any screen: not a real screen position
    if (Math.abs(dx) > 20_000 || Math.abs(dy) > 20_000) return false;
    this.xs = [...this.xs, dx].slice(-WINDOW_SAMPLES);
    this.ys = [...this.ys, dy].slice(-WINDOW_SAMPLES);
    const x = median(this.xs);
    const y = median(this.ys);
    const v = this.value;
    if (v && Math.abs(x - v.x) <= WINDOW_SLOP && Math.abs(y - v.y) <= WINDOW_SLOP) return false;
    this.value = { x: round1(x), y: round1(y) };
    return true;
  }
}

const WINDOW_SAMPLES = 9;
/** CSS pixels the window must move before the Bridge is told (rounded screen positions jitter by under one). */
const WINDOW_SLOP = 1;

/** The middle value (the lower of the two middle ones): always one that was seen, never a mix of two positions. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * The wall clock time (ms) of an event with `timeStamp` (performance clock), now that it is handled:
 * the event's own time, not the moment JavaScript got to it (which can be much later while the page
 * draws – the Bridge compares it with the firmware's time for the same pen-down).
 */
export function eventWallTime(timeStamp: number | undefined, nowPerf: number, nowWall: number): number {
  if (timeStamp === undefined || !Number.isFinite(timeStamp) || timeStamp <= 0) return nowWall;
  const age = nowPerf - timeStamp;
  // a timestamp from another clock (or none) says nothing
  if (!(age >= 0 && age < 5000)) return nowWall;
  return nowWall - age;
}

function point(v: unknown): { x: number; y: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  return typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : undefined;
}

/** A status message from the Bridge, or null. */
export function parseStatus(text: string): FastInkStatus | null {
  try {
    const o: unknown = JSON.parse(text);
    if (!o || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    if (r.v !== 1 || r.type !== "status" || typeof r.at !== "number") return null;
    return {
      v: 1,
      type: "status",
      app: typeof r.app === "string" ? r.app : undefined,
      at: r.at,
      armed: r.armed === true,
      calibrated: r.calibrated === true,
      transport: typeof r.transport === "string" ? r.transport : undefined,
      error: typeof r.error === "string" ? r.error : undefined,
      penHovers: typeof r.penHovers === "number" ? r.penHovers : undefined,
      penStrokes: typeof r.penStrokes === "number" ? r.penStrokes : undefined,
      paused: typeof r.paused === "string" ? r.paused : undefined,
      missed: typeof r.missed === "number" ? r.missed : undefined,
      lastMissed: point(r.lastMissed),
      area: typeof r.area === "string" ? r.area : undefined,
      placement: typeof r.placement === "string" ? r.placement : undefined,
    };
  } catch {
    return null;
  }
}
