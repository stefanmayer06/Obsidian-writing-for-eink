import type { Pt, Rect } from "../geometry";
import { attachPoint, labelBox, makeConnector, shapeCenter, smoothPath } from "./connectors";
import { closedOutline } from "./fill";
import { parseColor } from "./pens";
import { pointInPolygon, strokePointBounds } from "./geom";
import { DEFAULT_LAYOUT, layoutGraph, placeInOrder, type EdgeRoute, type FlowDirection, type Size } from "./layered";
import { parseMermaid, type LinkCurve, type MermaidFlowchart, type MermaidStyle, type NodeShape } from "./mermaid";
import { makeStroke, newId, q, type Items, type Stroke, type TextBox } from "./model";
import { ellipsePoints } from "./shapes";
import { itemsBounds, transformItems, translation } from "./transform";

/**
 * Mermaid flowcharts as ink: every node becomes a shape of the page with its
 * label in it (a label that moves with the shape), every link an arrow
 * attached to the shapes at its ends (it follows them when they move), drawn
 * as a smooth curve like Mermaid draws it (or with right angles or straight
 * lines, as the diagram's `curve` says), subgraphs boxes with their title,
 * and the colours of `classDef`/`style`/`linkStyle` are kept.
 */

export interface TextMeasure {
  /** Width of one line of text at a font size (page units). */
  measure: (text: string, size: number) => number;
  /** Break text into the lines it shows at a width (as the ink page does); a simple word wrap when not given. */
  wrap?(text: string, width: number, size: number): string[];
  /** Line height as a factor of the font size (1.3 on the ink page). */
  lineHeight?: number;
}

/** A rough width of text (when there is no canvas to measure it). */
export function approxTextWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[ijlft.,;:'!|I ()[\]]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.85 : /[A-Z0-9#&]/.test(ch) ? 0.66 : 0.55;
  return w * size;
}

/** Break text into lines no wider than `width` (word by word, like the ink page). */
export function wrapWords(text: string, width: number, size: number, measure: TextMeasure["measure"]): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (line && measure(next.trimEnd(), size) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Font sizes and spacing (page units: an A4 page is 1000 wide). */
export const MERMAID_INK = {
  nodeFont: 18,
  edgeFont: 15,
  titleFont: 17,
  /** Labels longer than this are wrapped (Mermaid wraps at 200 px). */
  maxLabelWidth: 230,
  padX: 14,
  padY: 9,
  lineWidth: 1.6,
  thickWidth: 3.4,
  clusterWidth: 1.3,
};

const BLACK = "#000000";
const WHITE = "#ffffff";
const CLUSTER_LINE = "#808080";
const CLUSTER_FILLS = ["#f3f3f3", "#e7e7e7", "#dcdcdc", "#d1d1d1"];
const GAP = 2;
const STUB = 22;
/**
 * Room kept around measured text, so that it never wraps differently – not
 * even when the diagram is scaled to fit a page, which changes the widths of
 * text a little: a few units, and a few per cent.
 */
const SLACK = 4;
const SLACK_FACTOR = 1.04;

const CSS_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  navy: "#000080",
  teal: "#008080",
  olive: "#808000",
  maroon: "#800000",
  aqua: "#00ffff",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gold: "#ffd700",
  violet: "#ee82ee",
  indigo: "#4b0082",
  coral: "#ff7f50",
  salmon: "#fa8072",
  khaki: "#f0e68c",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  lavender: "#e6e6fa",
  tomato: "#ff6347",
  crimson: "#dc143c",
  orchid: "#da70d6",
  plum: "#dda0dd",
  tan: "#d2b48c",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  lightyellow: "#ffffe0",
  lightpink: "#ffb6c1",
  darkblue: "#00008b",
  darkgreen: "#006400",
  darkred: "#8b0000",
  darkorange: "#ff8c00",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  royalblue: "#4169e1",
  dodgerblue: "#1e90ff",
  seagreen: "#2e8b57",
  forestgreen: "#228b22",
  firebrick: "#b22222",
  chocolate: "#d2691e",
  slategray: "#708090",
  whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc",
};

/** A CSS colour as #rrggbb (transparency mixed with white); null for none/transparent; undefined when it is not a colour. */
export function cssColor(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const t = value.trim().toLowerCase();
  if (t === "none" || t === "transparent") return null;
  if (CSS_COLORS[t]) return CSS_COLORS[t];
  const m = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(t);
  if (m) {
    const ch = (v: string) => Math.max(0, Math.min(255, Math.round(v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v))));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return parseColor(`#${hex(ch(m[1]))}${hex(ch(m[2]))}${hex(ch(m[3]))}`, Math.max(0, Math.min(1, a)) * 100);
  }
  if (!t.startsWith("#")) return undefined;
  return parseColor(t) ?? undefined;
}

interface Look {
  line: string;
  fill: string | null;
  text: string;
  width: number;
  dash: boolean;
  fontSize: number;
}

function applyStyle(look: Look, s: MermaidStyle | undefined): Look {
  if (!s) return look;
  const out = { ...look };
  const fill = cssColor(s.fill);
  if (fill !== undefined) out.fill = fill;
  const line = cssColor(s.stroke);
  if (line) out.line = line;
  const text = cssColor(s.color);
  if (text) out.text = text;
  if (s.strokeWidth !== undefined) out.width = Math.max(0.6, Math.min(10, Math.round(s.strokeWidth * 1.4 * 10) / 10));
  if (s.dash !== undefined) out.dash = s.dash;
  if (s.fontSize !== undefined) out.fontSize = Math.max(8, Math.min(48, s.fontSize));
  return out;
}

// ------------------------------------------------------------------ shapes

/** How big a shape must be for text of this size (tw × th) inside it. */
function shapeSize(shape: NodeShape, tw: number, th: number): Size {
  const { padX: px, padY: py } = MERMAID_INK;
  const h0 = th + 2 * py;
  switch (shape) {
    case "stadium":
      return { w: tw + 2 * px + h0 * 0.5, h: h0 };
    case "subroutine":
      return { w: tw + 2 * px + 16, h: h0 };
    case "cylinder": {
      const w = tw + 2 * px;
      const ry = Math.max(5, Math.min(11, w * 0.07));
      return { w, h: h0 + 2 * ry };
    }
    case "circle": {
      const d = Math.max(Math.hypot(tw, th) + 10, h0);
      return { w: d, h: d };
    }
    case "double-circle": {
      const d = Math.max(Math.hypot(tw, th) + 10, h0) + 10;
      return { w: d, h: d };
    }
    case "small-circle":
      return tw > 0 ? { w: Math.max(Math.hypot(tw, th) + 10, h0), h: Math.max(Math.hypot(tw, th) + 10, h0) } : { w: 18, h: 18 };
    case "diamond": {
      // the text box fits in the diamond: tw/W + th/H ≤ 1
      const a = tw + 16;
      const b = th + 12;
      const k = 2.6;
      return { w: Math.max(a / (1 - 1 / k), 60), h: Math.max(b * k, 40) };
    }
    case "hexagon":
      return { w: tw + 2 * px + h0 * 0.5, h: h0 };
    case "lean-right":
    case "lean-left":
      return { w: tw + 2 * px + h0 * 0.4, h: h0 };
    case "trapezoid":
    case "trapezoid-top":
      return { w: tw + 2 * px + h0 * 0.8, h: h0 };
    case "asymmetric":
      return { w: tw + 2 * px + h0 * 0.5, h: h0 };
    case "document":
      return { w: tw + 2 * px, h: h0 + 10 };
    case "delay":
      return { w: tw + 2 * px + h0 * 0.35, h: h0 };
    default:
      return { w: Math.max(tw + 2 * px, 40), h: h0 };
  }
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 12): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/** The outline of a shape in a box, and lines drawn inside it. */
function shapeOutline(shape: NodeShape, r: Rect): { outline: Pt[]; inner: Pt[][]; closedInner?: Pt[] } {
  const { x, y, w, h } = r;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const P = (px: number, py: number): Pt => ({ x: px, y: py });
  switch (shape) {
    case "round": {
      const rr = Math.min(9, h / 3, w / 4);
      return {
        outline: [
          ...arc(x + w - rr, y + rr, rr, rr, -Math.PI / 2, 0, 4),
          ...arc(x + w - rr, y + h - rr, rr, rr, 0, Math.PI / 2, 4),
          ...arc(x + rr, y + h - rr, rr, rr, Math.PI / 2, Math.PI, 4),
          ...arc(x + rr, y + rr, rr, rr, Math.PI, (3 * Math.PI) / 2, 4),
        ],
        inner: [],
      };
    }
    case "stadium": {
      const rr = h / 2;
      return { outline: [...arc(x + w - rr, cy, rr, rr, -Math.PI / 2, Math.PI / 2, 14), ...arc(x + rr, cy, rr, rr, Math.PI / 2, (3 * Math.PI) / 2, 14)], inner: [] };
    }
    case "subroutine":
      return {
        outline: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)],
        inner: [
          [P(x + 8, y), P(x + 8, y + h)],
          [P(x + w - 8, y), P(x + w - 8, y + h)],
        ],
      };
    case "cylinder": {
      const ry = Math.max(5, Math.min(11, w * 0.07));
      const rx = w / 2;
      return {
        outline: [...arc(cx, y + ry, rx, ry, Math.PI, 2 * Math.PI, 16), ...arc(cx, y + h - ry, rx, ry, 0, Math.PI, 16)],
        inner: [arc(cx, y + ry, rx, ry, Math.PI, 0, 16)],
      };
    }
    case "circle":
    case "small-circle":
      return { outline: ellipsePoints(cx, cy, w / 2, h / 2), inner: [] };
    case "double-circle":
      return { outline: ellipsePoints(cx, cy, w / 2, h / 2), inner: [], closedInner: ellipsePoints(cx, cy, w / 2 - 5, h / 2 - 5) };
    case "diamond":
      return { outline: [P(cx, y), P(x + w, cy), P(cx, y + h), P(x, cy)], inner: [] };
    case "hexagon": {
      const d = h / 4;
      return { outline: [P(x + d, y), P(x + w - d, y), P(x + w, cy), P(x + w - d, y + h), P(x + d, y + h), P(x, cy)], inner: [] };
    }
    case "lean-right": {
      const d = h * 0.4;
      return { outline: [P(x + d, y), P(x + w, y), P(x + w - d, y + h), P(x, y + h)], inner: [] };
    }
    case "lean-left": {
      const d = h * 0.4;
      return { outline: [P(x, y), P(x + w - d, y), P(x + w, y + h), P(x + d, y + h)], inner: [] };
    }
    case "trapezoid": {
      const d = h * 0.4;
      return { outline: [P(x + d, y), P(x + w - d, y), P(x + w, y + h), P(x, y + h)], inner: [] };
    }
    case "trapezoid-top": {
      const d = h * 0.4;
      return { outline: [P(x, y), P(x + w, y), P(x + w - d, y + h), P(x + d, y + h)], inner: [] };
    }
    case "asymmetric": {
      const d = h * 0.3;
      return { outline: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h), P(x + d, cy)], inner: [] };
    }
    case "document": {
      const wave: Pt[] = [];
      for (let i = 0; i <= 20; i++) wave.push(P(x + w - (w * i) / 20, y + h - 6 + 6 * Math.sin((Math.PI * 2 * i) / 20)));
      return { outline: [P(x, y), P(x + w, y), ...wave], inner: [] };
    }
    case "delay": {
      const rr = h / 2;
      return { outline: [P(x, y), ...arc(x + w - rr, cy, rr, rr, -Math.PI / 2, Math.PI / 2, 12), P(x, y + h)], inner: [] };
    }
    default:
      return { outline: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)], inner: [] };
  }
}

function toPts(points: ReadonlyArray<Pt>): Float32Array {
  const arr = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    arr[i * 3] = q(p.x);
    arr[i * 3 + 1] = q(p.y);
    arr[i * 3 + 2] = 0.5;
  });
  return arr;
}

// ------------------------------------------------------------------ edges

/** Drop repeated points and points in the middle of a straight run. */
function tidy(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.05 && Math.abs(last.y - p.y) < 0.05) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((Math.abs(a.x - b.x) < 0.05 && Math.abs(b.x - c.x) < 0.05) || (Math.abs(a.y - b.y) < 0.05 && Math.abs(b.y - c.y) < 0.05)) out.splice(i, 1);
  }
  return out;
}

/** Between page coordinates and coordinates along the flow (v) and across it (u). */
function frame(dir: FlowDirection) {
  const toN = (p: Pt): { u: number; v: number } => {
    switch (dir) {
      case "BT":
        return { u: p.x, v: -p.y };
      case "LR":
        return { u: p.y, v: p.x };
      case "RL":
        return { u: p.y, v: -p.x };
      default:
        return { u: p.x, v: p.y };
    }
  };
  const fromN = (u: number, v: number): Pt => {
    switch (dir) {
      case "BT":
        return { x: u, y: -v };
      case "LR":
        return { x: v, y: u };
      case "RL":
        return { x: -v, y: u };
      default:
        return { x: u, y: v };
    }
  };
  const axis = (g: number) => (dir === "BT" || dir === "RL" ? -g : g);
  return { toN, fromN, axis };
}

/** Where an edge leaves or enters a shape: the middle of the side facing (du, dv) in the flow's frame. */
function port(shape: Stroke, dir: FlowDirection, du: number, dv: number): Pt {
  const { fromN } = frame(dir);
  const c = shapeCenter(shape);
  const d = fromN(du, dv);
  return attachPoint(shape, { x: c.x + d.x * 1e4, y: c.y + d.y * 1e4 }, GAP + shape.width / 2);
}

/**
 * Where an edge along the flow enters a shape: on its near side, `du` across
 * the flow from its middle (several edges coming into one shape get places of
 * their own). The middle of the side when `du` misses the shape.
 */
function entry(shape: Stroke, dir: FlowDirection, du: number): Pt {
  if (Math.abs(du) < 0.05) return port(shape, dir, 0, -1);
  const { toN, fromN } = frame(dir);
  const poly = closedOutline(shape)?.map(toN);
  const c = toN(shapeCenter(shape));
  const u = c.u + du;
  let near = Infinity;
  for (let i = 0; poly && i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a.u - u) * (b.u - u) > 0 || Math.abs(b.u - a.u) < 1e-9) continue;
    near = Math.min(near, a.v + ((u - a.u) / (b.u - a.u)) * (b.v - a.v));
  }
  if (!Number.isFinite(near) || near > c.v) return port(shape, dir, 0, -1);
  return fromN(u, near - GAP - shape.width / 2);
}

function spanU(shape: Stroke, dir: FlowDirection): [number, number] {
  const b = strokePointBounds(shape);
  const { toN } = frame(dir);
  const a = toN({ x: b.x, y: b.y });
  const c = toN({ x: b.x + b.w, y: b.y + b.h });
  return [Math.min(a.u, c.u), Math.max(a.u, c.u)];
}

/** Between an edge and its label (as in the layout). */
const LABEL_GAP = 6;

interface NRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

const M = 3;

/** Does a segment along the flow (at u, from v a to b) or across it (at v, from u a to b) run through a box? */
const hitsAlong = (r: NRect, u: number, a: number, b: number) => u > r.u0 - M && u < r.u1 + M && Math.max(a, b) > r.v0 && Math.min(a, b) < r.v1;
const hitsAcross = (r: NRect, v: number, a: number, b: number) => v > r.v0 - M && v < r.v1 + M && Math.max(a, b) > r.u0 && Math.min(a, b) < r.u1;

/** A lane along the flow from v a to b, at u or beyond it on `side`, clear of the boxes (and of the way across to it from `from`). */
function clearLane(u: number, side: number, a: number, b: number, rects: NRect[], from?: { u: number; v: number }): number {
  for (let i = 0; i < 64; i++) {
    const hit = rects.find((r) => hitsAlong(r, u, a, b) || (from !== undefined && hitsAcross(r, from.v, from.u, u)));
    if (!hit) break;
    u = side > 0 ? hit.u1 + STUB * 0.7 : hit.u0 - STUB * 0.7;
  }
  return u;
}

type NPt = { u: number; v: number };

/** An edge worked out: its route with right angles, its label, and what a curve along it is drawn from. */
export interface EdgePlan {
  src: Stroke;
  dst: Stroke;
  /** With right angles (page coordinates). */
  ortho: Pt[];
  label: Rect | null;
  /** Mermaid's points of the edge: its ends on the outlines, the middle of every gap between ranks and its bends (none when it leaves or enters a shape from a side). */
  bends: Pt[] | null;
  /**
   * Curves that are upright wherever the edge crosses a rank (out of its
   * shape, past its label, into its target) and bend between the ranks: as
   * far as they can, then only within the gaps.
   */
  upright: Pt[][];
  obstacles: readonly Rect[];
}

/**
 * The route of an edge laid out from `src` to `dst`, with right angles, and
 * where its label goes. An edge along the flow goes out of the shape's far
 * side and into the next one's near side, bending between ranks (out of or
 * into a side when a box is in the way); one against the flow goes out of a
 * side, along a channel beside what lies between and into the same side of
 * its target. `obstacles` are the boxes it should not run through;
 * `entryShift` moves where it enters its target (across the flow).
 */
export function planEdge(src: Stroke, dst: Stroke, route: EdgeRoute, obstacles: readonly Rect[] = [], entryShift = 0): EdgePlan {
  const { toN, fromN, axis } = frame(route.dir);
  const page = (pts: NPt[]) => pts.map((p) => fromN(p.u, p.v));
  const rects: NRect[] = obstacles.map((r) => {
    const a = toN({ x: r.x, y: r.y });
    const b = toN({ x: r.x + r.w, y: r.y + r.h });
    return { u0: Math.min(a.u, b.u), u1: Math.max(a.u, b.u), v0: Math.min(a.v, b.v), v1: Math.max(a.v, b.v) };
  });
  const dummies = route.points.map(toN);
  const gaps = route.gaps.map(axis);
  const sc = toN(shapeCenter(src));
  const ec = toN(shapeCenter(dst));
  const out: NPt[] = [];
  let label = route.label;
  let bends: NPt[] | null = null;
  let upright: NPt[][] | null = null;
  if (!route.reversed) {
    let s = toN(port(src, route.dir, 0, 1));
    let e = toN(entry(dst, route.dir, entryShift));
    const us = [s.u, ...dummies.map((d) => d.u), e.u];
    const head: NPt[] = [];
    const tail: NPt[] = [];
    let sideways = false;
    // out of a side when something lies between the shape and the first gap
    if (rects.some((r) => hitsAlong(r, s.u, s.v, gaps[0]))) {
      const side = us[1] > s.u + 1 ? 1 : us[1] < s.u - 1 ? -1 : 1;
      const [s0, s1] = spanU(src, route.dir);
      const p = toN(port(src, route.dir, side, 0));
      const lane = clearLane(side > 0 ? s1 + STUB : s0 - STUB, side, sc.v, gaps[0], rects, p);
      head.push(p, { u: lane, v: sc.v });
      s = { u: lane, v: sc.v };
      us[0] = lane;
      sideways = true;
    } else head.push(s);
    const last = gaps.length - 1;
    if (rects.some((r) => hitsAlong(r, e.u, gaps[last], e.v))) {
      const side = us[us.length - 2] > e.u + 1 ? 1 : us[us.length - 2] < e.u - 1 ? -1 : 1;
      const [e0, e1] = spanU(dst, route.dir);
      const p = toN(port(dst, route.dir, side, 0));
      const lane = clearLane(side > 0 ? e1 + STUB : e0 - STUB, side, gaps[last], ec.v, rects, p);
      tail.push({ u: lane, v: ec.v }, p);
      e = { u: lane, v: ec.v };
      us[us.length - 1] = lane;
      sideways = true;
    } else tail.push(e);
    out.push(...head);
    gaps.forEach((g, i) => out.push({ u: us[i], v: g }, { u: us[i + 1], v: g }));
    out.push(...tail);
    if (!sideways && gaps.length) {
      // as Mermaid: out of the outline toward the middle of the first gap, above the next bend
      const aims = gaps.map((g, i) => ({ u: us[i + 1], v: g }));
      const start = toN(attachPoint(src, fromN(aims[0].u, aims[0].v), GAP + src.width / 2));
      bends = [start];
      aims.forEach((a, i) => {
        bends?.push(a);
        if (i < dummies.length) bends?.push(dummies[i]);
      });
      // and straight into the target, so that the arrow points into it
      bends.push({ u: e.u, v: (aims[aims.length - 1].v + e.v) / 2 }, e);
    }
    if (gaps.length) {
      // upright through every rank (straight past the label), bending between them: as far as it can, or only within the gaps
      let lv: [number, number] | null = null;
      if (label) {
        const a = toN({ x: label.x, y: label.y }).v;
        const b = toN({ x: label.x + label.w, y: label.y + label.h }).v;
        lv = [Math.min(a, b), Math.max(a, b)];
      }
      // out of a side or into a side: a straight bit first, to round the corner on
      const RADIUS = 14;
      const runs = [{ u: s.u, v0: s.v, v1: s.v + (head.length > 1 ? 2 * RADIUS : 0) }];
      for (const d of dummies) {
        const k = lv && d.v >= lv[0] && d.v <= lv[1] ? Math.max(d.v - lv[0], lv[1] - d.v) + 3 : 0;
        runs.push({ u: d.u, v0: d.v - k, v1: d.v + k });
      }
      runs.push({ u: e.u, v0: e.v - (tail.length > 1 ? 2 * RADIUS : 0), v1: e.v });
      const along = (half: number): NPt[] => {
        const pts: NPt[] = [];
        const push = (...ps: NPt[]) => {
          for (const p of ps) {
            const last = pts[pts.length - 1];
            if (!last || Math.abs(p.u - last.u) > 0.05 || Math.abs(p.v - last.v) > 0.05) pts.push(p);
          }
        };
        push({ u: runs[0].u, v: runs[0].v0 });
        for (let i = 1; i < runs.length; i++) {
          const a = runs[i - 1];
          const b = runs[i];
          const lo = Math.max(a.v1, gaps[i - 1] - half);
          const hi = Math.min(b.v0, gaps[i - 1] + half);
          if (Math.abs(a.u - b.u) > 0.05) {
            if (hi > lo) {
              const c = (hi - lo) / 2;
              push({ u: a.u, v: lo }, ...cubic({ u: a.u, v: lo }, { u: a.u, v: lo + c }, { u: b.u, v: hi - c }, { u: b.u, v: hi }));
            } else push({ u: a.u, v: gaps[i - 1] }, { u: b.u, v: gaps[i - 1] });
          }
          push({ u: b.u, v: b.v0 }, { u: b.u, v: b.v1 });
        }
        // out of a side and into a side: round corners
        const all = [...head.slice(0, -1), ...pts, ...tail.slice(1)];
        const corners = new Set([head.length - 1, all.length - tail.length]);
        return tidyN(all.flatMap((p, i) => (corners.has(i) && i > 0 && i < all.length - 1 ? fillet(all[i - 1], p, all[i + 1], RADIUS) : [p])));
      };
      const same = (a: NPt[], b: NPt[]) => a.length === b.length && a.every((p, i) => p.u === b[i].u && p.v === b[i].v);
      upright = [];
      for (const half of [Infinity, 4, 2, 1].map((k) => (k * DEFAULT_LAYOUT.rankSep) / 2)) {
        const path = along(half);
        if (!upright.some((u) => same(u, path))) upright.push(path);
      }
    }
  } else {
    const [s0, s1] = spanU(src, route.dir);
    const [e0, e1] = spanU(dst, route.dir);
    const lo = Math.min(sc.v, ec.v);
    const hi = Math.max(sc.v, ec.v);
    const us = dummies.map((d) => d.u);
    // the side the bends are on, unless the other one crosses fewer boxes
    const mean = us.length ? us.reduce((t, u) => t + u, 0) / us.length : Infinity;
    const preferred = mean >= (sc.u + ec.u) / 2 ? 1 : -1;
    const candidate = (side: number) => {
      const start = side > 0 ? Math.max(...us, s1 + STUB, e1 + STUB) : Math.min(...us, s0 - STUB, e0 - STUB);
      const sp = toN(port(src, route.dir, side, 0));
      const ep = toN(port(dst, route.dir, side, 0));
      const chan = clearLane(start, side, lo, hi, rects);
      const hits = rects.filter((r) => hitsAcross(r, sp.v, sp.u, chan) || hitsAcross(r, ep.v, ep.u, chan)).length;
      return { side, chan, sp, ep, hits, len: Math.abs(chan - sp.u) + Math.abs(chan - ep.u) };
    };
    const a = candidate(preferred);
    const b = candidate(-preferred);
    const best = b.hits < a.hits ? b : a;
    out.push(best.sp, { u: best.chan, v: best.sp.v }, { u: best.chan, v: best.ep.v }, best.ep);
    // round the side and back: the corners of the channel guide the curve
    bends = out.slice();
    if (label) {
      // beside the channel
      const la = toN({ x: label.x, y: label.y });
      const lb = toN({ x: label.x + label.w, y: label.y + label.h });
      const width = Math.abs(lb.u - la.u);
      const u0 = best.side > 0 ? best.chan + LABEL_GAP : best.chan - LABEL_GAP - width;
      const p = fromN(u0, la.v);
      const r = fromN(u0 + width, lb.v);
      label = { x: Math.min(p.x, r.x), y: Math.min(p.y, r.y), w: Math.abs(r.x - p.x), h: Math.abs(r.y - p.y) };
    }
  }
  return { src, dst, ortho: tidy(page(out)), label, bends: bends && page(bends), upright: upright ? upright.map((u) => tidy(page(u))) : [], obstacles };
}

/** Drop repeated points. */
function tidyN(pts: NPt[]): NPt[] {
  return pts.filter((p, i) => i === 0 || Math.abs(p.u - pts[i - 1].u) > 0.05 || Math.abs(p.v - pts[i - 1].v) > 0.05);
}

/** A corner b (between a and c) rounded off with a radius of r at most, half a leg at most. */
function fillet(a: NPt, b: NPt, c: NPt, r: number): NPt[] {
  const l1 = Math.hypot(b.u - a.u, b.v - a.v);
  const l2 = Math.hypot(c.u - b.u, c.v - b.v);
  const rr = Math.min(r, l1 / 2, l2 / 2);
  if (rr < 0.5) return [b];
  const p = { u: b.u + ((a.u - b.u) * rr) / l1, v: b.v + ((a.v - b.v) * rr) / l1 };
  const e = { u: b.u + ((c.u - b.u) * rr) / l2, v: b.v + ((c.v - b.v) * rr) / l2 };
  const out: NPt[] = [p];
  for (let k = 1; k <= 6; k++) {
    const t = k / 6;
    const s = 1 - t;
    out.push({ u: s * s * p.u + 2 * s * t * b.u + t * t * e.u, v: s * s * p.v + 2 * s * t * b.v + t * t * e.v });
  }
  return out;
}

/** Points along a cubic Bézier curve (without its start), about 5 units apart. */
function cubic(p0: NPt, p1: NPt, p2: NPt, p3: NPt): NPt[] {
  const len = Math.hypot(p1.u - p0.u, p1.v - p0.v) + Math.hypot(p2.u - p1.u, p2.v - p1.v) + Math.hypot(p3.u - p2.u, p3.v - p2.v);
  const steps = Math.max(4, Math.min(64, Math.ceil(len / 5)));
  const out: NPt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const s = 1 - t;
    const a = s * s * s;
    const b = 3 * s * s * t;
    const c = 3 * s * t * t;
    const d = t * t * t;
    out.push({ u: a * p0.u + b * p1.u + c * p2.u + d * p3.u, v: a * p0.v + b * p1.v + c * p2.v + d * p3.v });
  }
  return out;
}

/** A path with right angles whose corners are rounded off (`radius` at most, half a leg at most). */
function roundCorners(pts: ReadonlyArray<Pt>, radius: number): Pt[] {
  const n = pts.map((p) => ({ u: p.x, v: p.y }));
  return n.flatMap((p, i) => (i === 0 || i === n.length - 1 ? [p] : fillet(n[i - 1], p, n[i + 1], radius))).map((p) => ({ x: p.u, y: p.v }));
}

/** Does the segment from a to b run through the box? */
function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, qq: number): boolean => {
    if (Math.abs(p) < 1e-12) return qq >= 0;
    const t = qq / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t0 <= t1;
}

const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

/** How many of the boxes a path runs through, and whether it goes into the shapes at its ends. */
function pathHits(path: ReadonlyArray<Pt>, plan: EdgePlan, avoid: readonly Rect[]): number {
  const boxes = [...plan.obstacles.map((r) => grow(r, M)), ...avoid.map((r) => grow(r, 2)), ...(plan.label ? [grow(plan.label, 2)] : [])];
  let n = 0;
  for (const r of boxes) {
    for (let i = 1; i < path.length; i++) {
      if (segmentHitsRect(path[i - 1], path[i], r)) {
        n++;
        break;
      }
    }
  }
  for (const s of [plan.src, plan.dst]) {
    const poly = closedOutline(s);
    if (poly && path.slice(1, -1).some((p) => pointInPolygon(p.x, p.y, poly))) n++;
  }
  return n;
}

/**
 * How an edge is drawn: as Mermaid draws it – a curve through its points
 * (curves), with right angles (step) or straight between its points
 * (linear). A curve that would run through a box, a label or a title in
 * `avoid` gives way to one that stays upright across the ranks, then to
 * rounded right angles, then to the right angles themselves.
 */
export function drawEdge(plan: EdgePlan, curve: LinkCurve = "curve", avoid: readonly Rect[] = []): Pt[] {
  if (curve === "step") return plan.ortho;
  const tries: Pt[][] = [];
  if (curve === "linear") {
    if (plan.bends) tries.push(tidy(plan.bends));
  } else {
    if (plan.bends) tries.push(smoothPath(plan.bends));
    tries.push(...plan.upright, roundCorners(plan.ortho, 18), roundCorners(plan.ortho, 8));
  }
  tries.push(plan.ortho);
  let best = tries[tries.length - 1];
  let fewest = Infinity;
  for (const t of tries) {
    const n = pathHits(t, plan, avoid);
    if (n === 0) return t;
    if (n < fewest) {
      fewest = n;
      best = t;
    }
  }
  return best;
}

/** The points of an edge (see planEdge and drawEdge), and where its label goes. */
export function routeEdge(src: Stroke, dst: Stroke, route: EdgeRoute, obstacles: readonly Rect[] = [], curve: LinkCurve = "curve"): { points: Pt[]; label: Rect | null } {
  const plan = planEdge(src, dst, route, obstacles);
  return { points: drawEdge(plan, curve), label: plan.label };
}

/** Gap between edges coming into one shape (at most), and how much of its side they may use. */
const ENTRY_GAP = 18;
const ENTRY_SPAN = 0.6;

/**
 * Where links come into their target, across the flow from its middle: when
 * several come into one shape, each as near to where it comes from as it can
 * be, in that order, with a gap between them and within the middle of the side.
 */
function entryShifts(links: ReadonlyArray<{ dst: Stroke; dir: FlowDirection; from: Pt } | null>): Map<number, number> {
  const groups = new Map<string, Array<{ i: number; u: number }>>();
  const span = new Map<string, number>();
  const center = new Map<string, number>();
  links.forEach((l, i) => {
    if (!l) return;
    const key = `${l.dst.id} ${l.dir}`;
    const { toN } = frame(l.dir);
    const list = groups.get(key) ?? [];
    list.push({ i, u: toN(l.from).u });
    groups.set(key, list);
    const [u0, u1] = spanU(l.dst, l.dir);
    span.set(key, u1 - u0);
    center.set(key, toN(shapeCenter(l.dst)).u);
  });
  const out = new Map<number, number>();
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.u - b.u || a.i - b.i);
    const half = ((span.get(key) as number) * ENTRY_SPAN) / 2;
    const gap = Math.min(ENTRY_GAP, (2 * half) / (list.length - 1));
    const c = center.get(key) as number;
    const want = list.map((l) => Math.max(-half, Math.min(half, l.u - c)));
    const placed = placeInOrder(
      want.map((w) => [[w, 1] as const]),
      want,
      list.slice(1).map(() => gap),
    );
    // back within the side
    const shift = Math.max(0, -half - placed[0]) - Math.max(0, placed[placed.length - 1] - half);
    list.forEach((l, k) => out.set(l.i, placed[k] + shift));
  }
  return out;
}

// ------------------------------------------------------------------ the diagram

export interface MermaidInk {
  items: Items;
  /** The title of the diagram (frontmatter), if it has one. */
  title: string | null;
  shapes: number;
  arrows: number;
}

/** A Mermaid flowchart as ink, starting at (0, 0). Throws MermaidError for what cannot be read. */
export function mermaidToItems(code: string, text: TextMeasure = { measure: approxTextWidth }): MermaidInk {
  return flowchartToItems(parseMermaid(code), text);
}

export function flowchartToItems(g: MermaidFlowchart, text: TextMeasure = { measure: approxTextWidth }): MermaidInk {
  const lh = text.lineHeight ?? 1.3;
  const wrap = (t: string, width: number, size: number) => (text.wrap ? text.wrap(t, width, size) : wrapWords(t, width, size, text.measure));
  const measureLines = (t: string, size: number, maxW: number) => {
    const lines = t ? wrap(t, maxW, size) : [];
    const w = lines.reduce((m, l) => Math.max(m, text.measure(l, size)), 0);
    return { lines, w: lines.length ? Math.ceil(w * SLACK_FACTOR) + SLACK : 0, h: lines.length * size * lh };
  };

  // looks
  const nodeLook = (id: string): Look => {
    const n = g.nodes.get(id);
    let look: Look = { line: BLACK, fill: WHITE, text: BLACK, width: MERMAID_INK.lineWidth, dash: false, fontSize: MERMAID_INK.nodeFont };
    look = applyStyle(look, g.classDefs.get("default"));
    for (const cl of n?.classes ?? []) look = applyStyle(look, g.classDefs.get(cl));
    return applyStyle(look, n?.style);
  };
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const p = g.subgraphs.get(id)?.parent;
    const d = p ? depthOf(p) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const clusterLook = (id: string): Look => {
    const s = g.subgraphs.get(id);
    let look: Look = {
      line: CLUSTER_LINE,
      fill: CLUSTER_FILLS[Math.min(CLUSTER_FILLS.length - 1, depthOf(id))],
      text: BLACK,
      width: MERMAID_INK.clusterWidth,
      dash: false,
      fontSize: MERMAID_INK.titleFont,
    };
    for (const cl of s?.classes ?? []) look = applyStyle(look, g.classDefs.get(cl));
    return applyStyle(look, s?.style);
  };

  // sizes
  const nodeSizes = new Map<string, Size>();
  const nodeText = new Map<string, { lines: string[]; w: number; h: number; look: Look }>();
  for (const n of g.nodes.values()) {
    const look = nodeLook(n.id);
    const m = measureLines(n.label, look.fontSize, MERMAID_INK.maxLabelWidth);
    nodeText.set(n.id, { lines: m.lines, w: m.w, h: m.h, look });
    nodeSizes.set(n.id, shapeSize(n.shape, m.w, m.h));
  }
  const clusterText = new Map<string, { lines: string[]; w: number; h: number; look: Look }>();
  for (const s of g.subgraphs.values()) {
    const look = clusterLook(s.id);
    const m = measureLines(s.title.replace(/\n/g, " "), look.fontSize, 1e6);
    clusterText.set(s.id, { ...m, look });
  }
  const edgeLooks = g.edges.map((e) => {
    let look: Look = {
      line: BLACK,
      fill: null,
      text: BLACK,
      width: e.stroke === "thick" ? MERMAID_INK.thickWidth : MERMAID_INK.lineWidth,
      dash: e.stroke === "dotted",
      fontSize: MERMAID_INK.edgeFont,
    };
    look = applyStyle(look, e.style);
    const m = measureLines(e.label, look.fontSize, MERMAID_INK.maxLabelWidth * 0.75);
    return { look, label: m };
  });

  const layout = layoutGraph({
    dir: g.dir,
    nodes: nodeSizes,
    clusters: new Map(
      [...g.subgraphs.values()].map((s) => {
        const t = clusterText.get(s.id);
        return [s.id, { children: s.children, dir: s.dir, title: t && t.w > 0 ? { w: t.w, h: t.h } : null }] as const;
      }),
    ),
    root: g.root,
    edges: g.edges.map((e, i) => {
      const l = edgeLooks[i].label;
      return { id: String(i), from: e.from, to: e.to, minlen: e.minlen, label: l.w > 0 ? { w: l.w, h: l.h } : null };
    }),
  });

  const strokes: Stroke[] = [];
  const texts: TextBox[] = [];
  const shapeOf = new Map<string, Stroke>();

  // subgraphs, outer ones first (their fills go underneath)
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const sg = g.subgraphs.get(id);
      const box = layout.clusters.get(id);
      if (!sg || !box) continue;
      const look = clusterLook(id);
      const s = makeStroke({
        pen: "ballpoint",
        color: look.line,
        width: look.width,
        pts: toPts(shapeOutline("rect", box).outline),
        poly: true,
        closed: true,
        dash: look.dash,
        fill: look.fill ?? undefined,
      });
      strokes.push(s);
      shapeOf.set(id, s);
      const t = clusterText.get(id);
      if (t && t.lines.length && box.title) {
        texts.push({ id: newId(), x: q(box.title.x), y: q(box.title.y), w: q(t.w), h: q(t.h), text: t.lines.join("\n"), size: look.fontSize, color: look.text });
      }
      visit(sg.children);
    }
  };
  visit(g.root);

  // nodes and their labels
  for (const n of g.nodes.values()) {
    const r = layout.nodes.get(n.id);
    const info = nodeText.get(n.id);
    if (!r || !info) continue;
    const { look } = info;
    const geo = shapeOutline(n.shape, r);
    const main = makeStroke({
      pen: "ballpoint",
      color: look.line,
      width: look.width,
      pts: toPts(geo.outline),
      poly: true,
      closed: true,
      dash: look.dash,
      fill: look.fill ?? undefined,
    });
    strokes.push(main);
    shapeOf.set(n.id, main);
    for (const line of geo.inner) strokes.push(makeStroke({ pen: "ballpoint", color: look.line, width: look.width, pts: toPts(line), poly: true }));
    if (geo.closedInner) strokes.push(makeStroke({ pen: "ballpoint", color: look.line, width: look.width, pts: toPts(geo.closedInner), poly: true, closed: true }));
    if (info.lines.length && info.lines.some((l) => l)) {
      // never narrower than the text was measured (with its slack): it would wrap again and run out of the shape
      const box = labelBox(main, info.h);
      if (box.w < info.w) {
        box.x = q(box.x + box.w / 2 - info.w / 2);
        box.w = q(info.w);
      }
      texts.push({ id: newId(), ...box, h: q(info.h), text: info.lines.join("\n"), size: look.fontSize, color: look.text, align: "center", container: main.id });
    }
  }

  // links: they keep off the boxes that are not around their ends
  const ancestors = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    let p = g.nodes.has(id) ? [...g.subgraphs.values()].find((sg) => sg.children.includes(id))?.id : g.subgraphs.get(id)?.parent;
    while (p) {
      out.add(p);
      p = g.subgraphs.get(p)?.parent ?? undefined;
    }
    return out;
  };
  const boxes: Array<{ id: string; rect: Rect }> = [...[...layout.nodes].map(([id, rect]) => ({ id, rect })), ...[...layout.clusters].map(([id, rect]) => ({ id, rect }))];
  const obstaclesFor = (from: string, to: string): Rect[] => {
    const skip = new Set([...ancestors(from), ...ancestors(to)]);
    return boxes.filter((b) => !skip.has(b.id)).map((b) => b.rect);
  };
  // links coming into one shape along the flow get places of their own on its near side, in the order they come from (as in Mermaid)
  const shifts = entryShifts(
    g.edges.map((e, i) => {
      const src = shapeOf.get(e.from);
      const dst = shapeOf.get(e.to);
      const route = layout.edges.get(String(i));
      if (e.stroke === "invisible" || !src || !dst || src === dst || !route || route.reversed) return null;
      return { dst, dir: route.dir, from: route.points.length ? route.points[route.points.length - 1] : shapeCenter(src) };
    }),
  );
  // first where every link goes and where its label sits, then how it is drawn: curves keep off the other links' labels and the titles
  const plans = g.edges.map((e, i): EdgePlan | null => {
    const src = shapeOf.get(e.from);
    const dst = shapeOf.get(e.to);
    const route = layout.edges.get(String(i));
    if (e.stroke === "invisible" || !src || !dst || src === dst || !route) return null;
    return planEdge(src, dst, route, obstaclesFor(e.from, e.to), shifts.get(i) ?? 0);
  });
  const titles: Rect[] = [];
  for (const [id, box] of layout.clusters) {
    const t = clusterText.get(id);
    if (box.title && t && t.w > 0) titles.push({ x: box.title.x, y: box.title.y, w: t.w, h: t.h });
  }
  const labelRects = plans.map((p, i) => (p?.label && edgeLooks[i].label.lines.length ? p.label : null));
  let arrows = 0;
  g.edges.forEach((e, i) => {
    if (e.stroke === "invisible") return;
    const src = shapeOf.get(e.from);
    const dst = shapeOf.get(e.to);
    if (!src || !dst) return;
    const { look, label } = edgeLooks[i];
    const curve = e.curve ?? g.curve;
    const plan = plans[i];
    let stroke: Stroke;
    if (src === dst) {
      // a loop back to the same shape: a small loop on its right side, not attached
      const b = strokePointBounds(src);
      const x0 = b.x + b.w + GAP + src.width / 2;
      const y1 = b.y + b.h * 0.3;
      const y2 = b.y + b.h * 0.7;
      const loop = [
        { x: x0, y: y1 },
        { x: x0 + STUB, y: y1 },
        { x: x0 + STUB, y: y2 },
        { x: x0, y: y2 },
      ];
      stroke = makeStroke({
        pen: "ballpoint",
        color: look.line,
        width: look.width,
        pts: toPts(curve === "curve" ? smoothPath(loop) : loop),
        poly: true,
        arrow: e.end,
        arrowStart: e.start,
        dash: look.dash,
      });
      if (label.lines.length) texts.push({ id: newId(), x: q(x0 + STUB + 6), y: q(b.y + b.h / 2 - label.h / 2), w: q(label.w), h: q(label.h), text: label.lines.join("\n"), size: look.fontSize, color: look.text });
    } else if (plan) {
      const avoid = [...titles, ...labelRects.filter((r, j): r is Rect => r !== null && j !== i)];
      stroke = makeStroke({
        pen: "ballpoint",
        color: look.line,
        width: look.width,
        pts: toPts(drawEdge(plan, curve, avoid)),
        poly: true,
        arrow: e.end,
        arrowStart: e.start,
        dash: look.dash,
        // a straight line is routed straight again when its shapes move
        elbow: curve !== "linear",
        curve: curve === "curve",
        from: src.id,
        to: dst.id,
      });
      if (label.lines.length && plan.label) {
        texts.push({ id: newId(), x: q(plan.label.x), y: q(plan.label.y), w: q(label.w), h: q(label.h), text: label.lines.join("\n"), size: look.fontSize, color: look.text });
      }
    } else {
      // between a subgraph and something in it: straight from outline to outline
      const c = makeConnector(shapeCenter(src), shapeCenter(dst), src, dst, { color: look.line, width: look.width, elbow: false, arrow: e.end, dash: look.dash });
      stroke = makeStroke({ ...c, arrowStart: e.start });
    }
    strokes.push(stroke);
    arrows++;
  });

  const items: Items = { strokes, texts, images: [], links: [], figures: [] };
  const box = itemsBounds(items);
  const moved = box ? transformItems(items, translation(-box.x, -box.y)) : items;
  return { items: moved, title: g.title, shapes: g.nodes.size, arrows };
}
