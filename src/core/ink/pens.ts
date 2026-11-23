import type { PenType, Stroke } from "./model";

/**
 * The pens, like the pen box of the Boox Notes app, and the geometry of a
 * stroke.
 *
 * A stroke is drawn segment by segment: every new point adds one curve piece
 * (a quadratic curve between the midpoints of neighbouring points) with the
 * width at that point. The same `StrokeBuilder` is used while writing (each
 * segment is drawn the moment the point arrives, nothing is ever redrawn) and
 * for redrawing a page, exporting SVG/PDF or rendering figures, so live ink
 * and redrawn ink are identical.
 */

export interface PenDef {
  label: string;
  /** Lucide icon name. */
  icon: string;
  /** Width presets (page units) for the five thickness buttons. */
  presets: readonly [number, number, number, number, number];
  /** Width factor at pressure 0 and at pressure 1 (1 at pressure 0.5). */
  minFactor: number;
  maxFactor: number;
  /** How quickly the width follows the pressure (1 = immediately). */
  follow: number;
  /** Highlighter: drawn transparent ("multiply") underneath the ink. */
  marker?: boolean;
  /** Pencil: lighter at low pressure. */
  shade?: boolean;
  /** Calligraphy: width depends on the direction (broad nib at 45°). */
  nib?: boolean;
}

export const PENS: Record<PenType, PenDef> = {
  fountain: { label: "Fountain pen", icon: "pen-tool", presets: [1.2, 1.8, 2.6, 3.6, 5], minFactor: 0.35, maxFactor: 1.65, follow: 0.35 },
  ballpoint: { label: "Ballpoint pen", icon: "pen", presets: [1, 1.5, 2.2, 3, 4.2], minFactor: 0.82, maxFactor: 1.18, follow: 0.5 },
  pencil: { label: "Pencil", icon: "pencil", presets: [1, 1.5, 2.1, 3, 4.2], minFactor: 0.7, maxFactor: 1.3, follow: 0.4, shade: true },
  brush: { label: "Brush pen", icon: "brush", presets: [2.5, 4, 6.5, 10, 15], minFactor: 0.12, maxFactor: 1.88, follow: 0.25 },
  calligraphy: { label: "Calligraphy pen", icon: "feather", presets: [2.5, 4, 6, 9, 13], minFactor: 0.8, maxFactor: 1.2, follow: 0.4, nib: true },
  marker: { label: "Highlighter", icon: "highlighter", presets: [10, 16, 24, 32, 44], minFactor: 1, maxFactor: 1, follow: 1, marker: true },
};

/** Ink colours (good on Kaleido colour e-ink and as greys on black-and-white screens). */
export const INK_COLORS: ReadonlyArray<{ color: string; label: string }> = [
  { color: "#000000", label: "Black" },
  { color: "#4d4d4d", label: "Dark grey" },
  { color: "#8c8c8c", label: "Grey" },
  { color: "#d32f2f", label: "Red" },
  { color: "#ef6c00", label: "Orange" },
  { color: "#c79a00", label: "Ochre" },
  { color: "#2e7d32", label: "Green" },
  { color: "#1565c0", label: "Blue" },
  { color: "#6a1b9a", label: "Purple" },
  { color: "#6d4c41", label: "Brown" },
];

/** The pen bar's colours: the ink colours and some more (its colour strip scrolls sideways). */
export const PEN_BAR_COLORS: ReadonlyArray<{ color: string; label: string }> = [
  ...INK_COLORS,
  { color: "#d81b60", label: "Pink" },
  { color: "#00897b", label: "Teal" },
  { color: "#039be5", label: "Light blue" },
  { color: "#283593", label: "Navy" },
  { color: "#7cb342", label: "Light green" },
  { color: "#bdbdbd", label: "Light grey" },
];

export const MARKER_COLORS: ReadonlyArray<{ color: string; label: string }> = [
  { color: "#ffe14d", label: "Yellow" },
  { color: "#9be38f", label: "Green" },
  { color: "#8fd0ff", label: "Blue" },
  { color: "#ff9fd8", label: "Pink" },
  { color: "#ffc078", label: "Orange" },
  { color: "#c8c8c8", label: "Grey" },
];

export function isMarker(s: Pick<Stroke, "pen">): boolean {
  return s.pen === "marker";
}

/** Widths are rounded to this step so that runs of equal width can be drawn in one go. */
const WIDTH_STEP = 1 / 8;
const SHADE_LEVELS = 6;

function hex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, "0");
}

/** Mix a #rrggbb colour with white (amount 0..1). */
export function lighten(color: string, amount: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m || amount <= 0) return color;
  const mix = (h: string) => parseInt(h, 16) + (255 - parseInt(h, 16)) * amount;
  return `#${hex(mix(m[1]))}${hex(mix(m[2]))}${hex(mix(m[3]))}`;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
};

/**
 * A colour (#rgb, #rgba, #rrggbb, #rrggbbaa or a few names) as #rrggbb, its
 * transparency and `opacity` (0..100) mixed with white; null for
 * "transparent", "none" and what cannot be read.
 */
export function parseColor(v: unknown, opacity = 100): string | null {
  if (typeof v !== "string") return null;
  let c = v.trim().toLowerCase();
  if (!c || c === "transparent" || c === "none") return null;
  c = NAMED[c] ?? c;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(c);
  if (m) c = `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}${m[4] ? m[4] + m[4] : ""}`;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (!m) return null;
  let alpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
  alpha *= Math.min(1, Math.max(0, opacity / 100));
  if (alpha <= 0.02) return null;
  return lighten(`#${m[1]}`, 1 - alpha);
}

export interface Pt2 {
  x: number;
  y: number;
}

/** One piece of a stroke: a line or quadratic curve from `a` to `b`, or a dot at `a`. */
export interface Segment {
  kind: "line" | "quad" | "dot";
  a: Pt2;
  c?: Pt2;
  b: Pt2;
  /** Width in page units (rounded to WIDTH_STEP). */
  w: number;
  color: string;
}

/**
 * Turns points into segments, one point at a time. For a stroke with points
 * P0…Pn the segments are: P0→M1 (line), then Mi→Mi+1 curving through Pi,
 * and Mn→Pn (line) at the end, where Mi is the midpoint of Pi-1 and Pi.
 * Shapes (`poly`) use straight lines between the points.
 */
export class StrokeBuilder {
  private n = 0;
  private px = 0;
  private py = 0;
  private mx = 0;
  private my = 0;
  private w = 0;
  private color: string;
  private def: PenDef;
  private first = { x: 0, y: 0 };

  constructor(
    pen: PenType,
    color: string,
    private base: number,
    private poly = false,
  ) {
    this.def = PENS[pen] ?? PENS.ballpoint;
    this.color = color;
  }

  /** Width (unrounded) the pen wants at this point. */
  private target(p: number, dx: number, dy: number): number {
    const d = this.def;
    if (this.poly) return this.base;
    let f = d.minFactor + (d.maxFactor - d.minFactor) * Math.min(1, Math.max(0, p));
    if (d.nib) {
      const len = Math.hypot(dx, dy);
      // broad nib held at 45° ("/"): thin when moving along it (up and to the right), full width across it
      const across = len > 1e-6 ? Math.abs((dx + dy) / (len * Math.SQRT2)) : 0.6;
      f *= 0.22 + 0.78 * across;
    }
    return this.base * f;
  }

  private rounded(w: number): number {
    return Math.max(WIDTH_STEP, Math.round(w / WIDTH_STEP) * WIDTH_STEP);
  }

  private colorAt(p: number): string {
    if (!this.def.shade || this.poly) return this.color;
    const level = Math.round((1 - Math.min(1, Math.max(0, p))) * SHADE_LEVELS) / SHADE_LEVELS;
    return lighten(this.color, level * 0.55);
  }

  private lastP = 0.5;

  /** Add a point; returns the segment that can be drawn now (none for the first point). */
  add(x: number, y: number, p: number): Segment | null {
    if (this.n === 0) {
      this.n = 1;
      this.px = x;
      this.py = y;
      this.first = { x, y };
      this.mx = x;
      this.my = y;
      this.w = this.target(p, 0, 0);
      this.lastP = p;
      return null;
    }
    const dx = x - this.px;
    const dy = y - this.py;
    // the width belongs to the previous point (the control point of the new piece)
    const w = this.rounded(this.w);
    const color = this.colorAt(this.lastP);
    let seg: Segment;
    if (this.poly) {
      seg = { kind: "line", a: { x: this.px, y: this.py }, b: { x, y }, w, color };
    } else {
      const mx = (this.px + x) / 2;
      const my = (this.py + y) / 2;
      seg =
        this.n === 1
          ? { kind: "line", a: { x: this.px, y: this.py }, b: { x: mx, y: my }, w, color }
          : { kind: "quad", a: { x: this.mx, y: this.my }, c: { x: this.px, y: this.py }, b: { x: mx, y: my }, w, color };
      this.mx = mx;
      this.my = my;
    }
    this.w += (this.target(p, dx, dy) - this.w) * this.def.follow;
    this.px = x;
    this.py = y;
    this.lastP = p;
    this.n++;
    return seg;
  }

  /** The last piece of the stroke (a dot for a single point). */
  end(closed = false): Segment | null {
    if (this.n === 0) return null;
    const w = this.rounded(this.w);
    const color = this.colorAt(this.lastP);
    if (this.n === 1) return { kind: "dot", a: { x: this.px, y: this.py }, b: { x: this.px, y: this.py }, w, color };
    if (this.poly) return closed ? { kind: "line", a: { x: this.px, y: this.py }, b: { ...this.first }, w, color } : null;
    return { kind: "line", a: { x: this.mx, y: this.my }, b: { x: this.px, y: this.py }, w, color };
  }
}

/** Size of an arrow head (page units). */
export function arrowHeadSize(width: number): number {
  return Math.max(14, width * 5);
}

/** Arrow head lines for an arrow ending at the last point (or starting at the first). */
export function arrowHead(s: Stroke, atStart = false): Segment[] {
  const n = Math.floor(s.pts.length / 3);
  if (n < 2) return [];
  const at = (i: number) => (atStart ? i : n - 1 - i);
  const tx = s.pts[at(0) * 3];
  const ty = s.pts[at(0) * 3 + 1];
  // direction from a point a little before the tip (robust to a short last segment)
  let i = 1;
  while (i < n - 1 && Math.hypot(tx - s.pts[at(i) * 3], ty - s.pts[at(i) * 3 + 1]) < 8) i++;
  const dx = tx - s.pts[at(i) * 3];
  const dy = ty - s.pts[at(i) * 3 + 1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [];
  const ux = dx / len;
  const uy = dy / len;
  const size = arrowHeadSize(s.width);
  const back = { x: tx - ux * size, y: ty - uy * size };
  const nx = -uy * size * 0.5;
  const ny = ux * size * 0.5;
  const w = Math.max(WIDTH_STEP, Math.round(s.width / WIDTH_STEP) * WIDTH_STEP);
  return [
    { kind: "line", a: { x: back.x + nx, y: back.y + ny }, b: { x: tx, y: ty }, w, color: s.color },
    { kind: "line", a: { x: back.x - nx, y: back.y - ny }, b: { x: tx, y: ty }, w, color: s.color },
  ];
}

/** The segments of a stroke's line, without its arrow heads. */
function lineSegments(s: Stroke): Segment[] {
  const b = new StrokeBuilder(s.pen, s.color, s.width, !!s.poly);
  const out: Segment[] = [];
  const pts = s.pts;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const seg = b.add(pts[i], pts[i + 1], pts[i + 2]);
    if (seg) out.push(seg);
  }
  const last = b.end(!!s.closed);
  if (last) out.push(last);
  return out;
}

function headSegments(s: Stroke): Segment[] {
  return [...(s.arrow ? arrowHead(s) : []), ...(s.arrowStart ? arrowHead(s, true) : [])];
}

/** All segments of a stroke, in drawing order. */
export function strokeSegments(s: Stroke): Segment[] {
  return [...lineSegments(s), ...headSegments(s)];
}

/** A run of consecutive segments with the same width and colour, as SVG path data. */
export interface StrokeRun {
  w: number;
  color: string;
  d: string;
  /** An arrow head: drawn solid even on a dashed line. */
  head?: boolean;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Path data for a stroke: consecutive segments of equal width and colour share
 * one path. Each run starts with its own "M"; dots are a tiny line so that the
 * round cap draws them.
 */
export function strokeRuns(s: Stroke): StrokeRun[] {
  const runs: StrokeRun[] = [];
  let cur: StrokeRun | null = null;
  let endX = NaN;
  let endY = NaN;
  let line = lineSegments(s);
  // A dashed or dotted line is one width and one colour, so it is one path and its
  // pattern runs on evenly. (A pattern starts again with every piece of a path:
  // the pencil, whose shade follows the pressure, was cut into pieces shorter than
  // a dash, and its line came out solid wherever the pressure changed.)
  if (s.dash || s.dot) {
    const w = patternWidth(s.width, !!s.dot);
    line = line.map((seg) => (seg.w === w && seg.color === s.color ? seg : { ...seg, w, color: s.color }));
  }
  const all = [...line, ...headSegments(s)];
  all.forEach((seg, i) => {
    const head = i >= line.length;
    const continues = cur && !!cur.head === head && cur.w === seg.w && cur.color === seg.color && seg.a.x === endX && seg.a.y === endY;
    if (!continues) {
      cur = head ? { w: seg.w, color: seg.color, d: `M${f(seg.a.x)} ${f(seg.a.y)}`, head } : { w: seg.w, color: seg.color, d: `M${f(seg.a.x)} ${f(seg.a.y)}` };
      runs.push(cur);
    }
    const run = cur as StrokeRun;
    if (seg.kind === "dot") run.d += `l0.01 0`;
    else if (seg.kind === "quad" && seg.c) run.d += `Q${f(seg.c.x)} ${f(seg.c.y)} ${f(seg.b.x)} ${f(seg.b.y)}`;
    else run.d += `L${f(seg.b.x)} ${f(seg.b.y)}`;
    endX = seg.b.x;
    endY = seg.b.y;
  });
  return runs;
}

/** Dash pattern for dashed shapes, relative to the stroke width. */
export function dashPattern(width: number): [number, number] {
  return [Math.max(6, width * 4), Math.max(5, width * 3)];
}

/**
 * Dot pattern for dotted lines: (almost) zero-length dashes that the round cap
 * draws as dots, a dot's width (see patternWidth) and a bit apart.
 */
export function dotPattern(width: number): [number, number] {
  return [0.01, Math.max(4, width * 4)];
}

/** Dots are drawn this much wider than the pen's line, so that a thin pen's dots still show. */
const DOT_SCALE = 1.6;

/**
 * `count` of a pen's five thickness presets, spread from thin to thick (the pen bar
 * shows as many as you choose): 1 is the middle one, 3 thin, medium and thick.
 */
export function spreadPresets(presets: readonly number[], count: number): number[] {
  const n = Math.max(1, Math.min(presets.length, Math.round(count)));
  if (n >= presets.length) return [...presets];
  if (n === 1) return [presets[Math.floor((presets.length - 1) / 2)]];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = presets[Math.round((i * (presets.length - 1)) / (n - 1))];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** The pens that write (everything but the highlighter), in the order they are offered. */
export const WRITING_PEN_TYPES = ["fountain", "ballpoint", "pencil", "brush", "calligraphy"] as const;
export type WritingPenType = (typeof WRITING_PEN_TYPES)[number];

/** The pens offered in the pen bar and the pen's options: all but the hidden ones, and never none. */
export function shownPens(hidden: readonly string[]): WritingPenType[] {
  const shown = WRITING_PEN_TYPES.filter((p) => !hidden.includes(p));
  return shown.length > 0 ? shown : [...WRITING_PEN_TYPES];
}

/** How a pen line is drawn: solid, dashed or dotted. */
export type LineStyle = "solid" | "dashed" | "dotted";
export const LINE_STYLES: readonly LineStyle[] = ["solid", "dashed", "dotted"];

/** A stroke's dash pattern for canvas and PDF (empty: solid). Dotted wins over dashed. */
export function linePattern(s: { readonly width: number; readonly dash?: boolean; readonly dot?: boolean }): number[] {
  return s.dot ? dotPattern(s.width) : s.dash ? dashPattern(s.width) : [];
}

/** The stroke fields for a line style. */
export function lineStyleFields(style: LineStyle): { dash?: true; dot?: true } {
  return style === "dashed" ? { dash: true } : style === "dotted" ? { dot: true } : {};
}

/**
 * The one width a dashed or dotted line is drawn with: the pen's base width. A
 * line whose width changed with the pressure would restart its pattern at
 * every change, which breaks the dashes up.
 */
export function patternWidth(width: number, dotted = false): number {
  const w = dotted ? width * DOT_SCALE : width;
  return Math.max(WIDTH_STEP, Math.round(w / WIDTH_STEP) * WIDTH_STEP);
}
