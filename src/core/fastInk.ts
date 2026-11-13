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
 * Rectangles are CSS pixels of Obsidian's window; the Bridge converts them.
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

export interface FastInkMessage {
  v: 1;
  type: "state";
  seq: number;
  armed: boolean;
  /** Wall clock ms until which this holds. */
  until: number;
  dpr: number;
  region: CssRect | null;
  exclude: CssRect[];
  pen: FastInkPen;
  refreshMs: number;
  sideButtonErases: boolean;
  /** Counts strokes that were not ink after all (the Bridge takes their fast ink away). */
  clear: number;
  /** The last pen-down (CSS pixels, wall clock ms): the Bridge measures where the window is with it. */
  down?: { x: number; y: number; t: number };
  /** Wall clock ms when this was sent (the Bridge waits for a state sent after the pen visited a toolbar). */
  at: number;
  /**
   * Counts presses on anything but the page (toolbars, cards, Obsidian), sent the moment the press
   * starts: the firmware pauses at once, so the panel shows what the press changes without delay.
   */
  ui: number;
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
}

/** What the page looks like right now, measured by the view. */
export interface FastInkInputs {
  /** The page can take ink now: it is on screen, nothing covers it, the pen tool is selected. */
  ready: boolean;
  region: CssRect | null;
  exclude: CssRect[];
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
  opts: { seq: number; now: number; leaseMs: number; clear: number; ui?: number; down?: { x: number; y: number; t: number } | null },
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
  };
  if (opts.down) msg.down = { x: round1(opts.down.x), y: round1(opts.down.y), t: Math.round(opts.down.t) };
  return msg;
}

/** Two messages ask the Bridge for the same thing (the lease, the time and the pen-down aside). */
export function sameRequest(a: FastInkMessage | null, b: FastInkMessage | null): boolean {
  if (!a || !b) return a === b;
  const strip = (m: FastInkMessage) => JSON.stringify({ ...m, seq: 0, until: 0, at: 0, down: undefined });
  return strip(a) === strip(b);
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
    };
  } catch {
    return null;
  }
}
