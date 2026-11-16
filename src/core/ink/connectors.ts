import { distanceToOutline, polygonArea, type Pt } from "../geometry";
import { closedOutline } from "./fill";
import { pointInPolygon, strokePointBounds } from "./geom";
import { makeStroke, pointCount, q, withStroke, type Page, type Selection, type Stroke } from "./model";

/**
 * Connectors for flowcharts: an arrow drawn from one shape to another is
 * attached to both (its `from` and `to`). When a shape moves, its connectors
 * follow: they are routed again from outline to outline – straight, with
 * right angles (`elbow`), or with right angles rounded into a curve (`curve`).
 * Labels (text boxes with a `container`) move with their shape.
 */

/** Shapes a connector can attach to: anything that encloses an area (not areas, highlighters or connectors). */
export function isConnectable(s: Stroke): boolean {
  return !s.area && s.pen !== "marker" && !s.from && !s.to && closedOutline(s) !== null;
}

/** The shape at a point: the smallest one the point is inside of, or whose outline is within `slack`. */
export function shapeAt(page: Page, p: Pt, slack: number, except?: string): Stroke | null {
  let best: Stroke | null = null;
  let bestArea = Infinity;
  for (const s of page.strokes) {
    if (s.id === except || !isConnectable(s)) continue;
    const b = strokePointBounds(s);
    if (p.x < b.x - slack || p.y < b.y - slack || p.x > b.x + b.w + slack || p.y > b.y + b.h + slack) continue;
    const poly = closedOutline(s) as Pt[];
    if (!pointInPolygon(p.x, p.y, poly) && distanceToOutline(p, poly) > slack) continue;
    const a = polygonArea(poly);
    if (a < bestArea) {
      best = s;
      bestArea = a;
    }
  }
  return best;
}

export function shapeCenter(s: Stroke): Pt {
  const b = strokePointBounds(s);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Where a ray from `c` in direction `d` leaves the polygon (the last crossing), as a factor of `d`. */
function rayExit(poly: ReadonlyArray<Pt>, c: Pt, d: Pt): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = d.x * ey - d.y * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const ax = a.x - c.x;
    const ay = a.y - c.y;
    const t = (ax * ey - ay * ex) / denom;
    const u = (ax * d.y - ay * d.x) / denom;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9 && (best === null || t > best)) best = t;
  }
  return best;
}

/** The point of a shape's outline in the direction of `toward` (seen from its centre), `gap` outside it. */
export function attachPoint(shape: Stroke, toward: Pt, gap: number): Pt {
  const poly = closedOutline(shape);
  const c = shapeCenter(shape);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy);
  if (!poly || len < 1e-6) return c;
  const t = rayExit(poly, c, { x: dx, y: dy });
  if (t === null) return c;
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

type Dir = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

/** The side of a shape facing a point (right, left, below, above), weighed by the shape's size. */
function sideToward(shape: Stroke, p: Pt): Dir {
  const b = strokePointBounds(shape);
  const c = shapeCenter(shape);
  const dx = (p.x - c.x) / Math.max(1, b.w / 2);
  const dy = (p.y - c.y) / Math.max(1, b.h / 2);
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 };
}

function port(shape: Stroke, d: Dir, gap: number): Pt {
  const c = shapeCenter(shape);
  return attachPoint(shape, { x: c.x + d.x * 1e4, y: c.y + d.y * 1e4 }, gap);
}

const sign = (n: number): -1 | 0 | 1 => (n > 1e-6 ? 1 : n < -1e-6 ? -1 : 0);

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

const STUB = 24;

/**
 * A path with right angles from `s` (leaving in direction `ds`) to `e`
 * (entered from direction `de`, i.e. arriving against it).
 */
export function elbowPath(s: Pt, ds: Dir, e: Pt, de: Dir): Pt[] {
  const s1 = { x: s.x + ds.x * STUB, y: s.y + ds.y * STUB };
  const e1 = { x: e.x + de.x * STUB, y: e.y + de.y * STUB };
  const hs = ds.y === 0;
  const he = de.y === 0;
  let mid: Pt[];
  if (hs && he) {
    if (ds.x === -de.x && sign(e.x - s.x) === ds.x) {
      const mx = (s.x + e.x) / 2;
      mid = [
        { x: mx, y: s.y },
        { x: mx, y: e.y },
      ];
    } else if (ds.x === de.x) {
      const x = ds.x > 0 ? Math.max(s1.x, e1.x) : Math.min(s1.x, e1.x);
      mid = [
        { x, y: s.y },
        { x, y: e.y },
      ];
    } else {
      const my = (s.y + e.y) / 2;
      mid = [s1, { x: s1.x, y: my }, { x: e1.x, y: my }, e1];
    }
  } else if (!hs && !he) {
    if (ds.y === -de.y && sign(e.y - s.y) === ds.y) {
      const my = (s.y + e.y) / 2;
      mid = [
        { x: s.x, y: my },
        { x: e.x, y: my },
      ];
    } else if (ds.y === de.y) {
      const y = ds.y > 0 ? Math.max(s1.y, e1.y) : Math.min(s1.y, e1.y);
      mid = [
        { x: s.x, y },
        { x: e.x, y },
      ];
    } else {
      const mx = (s.x + e.x) / 2;
      mid = [s1, { x: mx, y: s1.y }, { x: mx, y: e1.y }, e1];
    }
  } else if (hs) {
    // one corner, if it is ahead of the start and on the side the end is entered from
    mid = sign(e.x - s.x) === ds.x && sign(s.y - e.y) === de.y ? [{ x: e.x, y: s.y }] : [s1, { x: s1.x, y: e1.y }, e1];
  } else {
    mid = sign(e.y - s.y) === ds.y && sign(s.x - e.x) === de.x ? [{ x: s.x, y: e.y }] : [s1, { x: e1.x, y: s1.y }, e1];
  }
  return tidy([s, ...mid, e]);
}

/**
 * A smooth curve guided by the points: a B-spline, as Mermaid draws its links
 * (d3's curveBasis). It starts at the first point heading for the second, ends
 * at the last one coming from the one before, and rounds off every point in
 * between (it passes near them, not through them); three or more points in a
 * line stay a straight line. Drawn with straight pieces about `step` long.
 */
export function smoothPath(pts: ReadonlyArray<Pt>, step = 5): Pt[] {
  const n = pts.length;
  if (n < 3) return [...pts];
  const out: Pt[] = [pts[0]];
  const mix = (a: Pt, wa: number, b: Pt, wb: number, c?: Pt, wc = 0): Pt => {
    const w = wa + wb + wc;
    return { x: (a.x * wa + b.x * wb + (c ? c.x * wc : 0)) / w, y: (a.y * wa + b.y * wb + (c ? c.y * wc : 0)) / w };
  };
  const bezier = (c1: Pt, c2: Pt, end: Pt) => {
    const p0 = out[out.length - 1];
    const len = Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(end.x - c2.x, end.y - c2.y);
    const k = Math.max(1, Math.min(32, Math.ceil(len / step)));
    for (let i = 1; i <= k; i++) {
      const t = i / k;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      out.push({ x: a * p0.x + b * c1.x + c * c2.x + d * end.x, y: a * p0.y + b * c1.y + c * c2.y + d * end.y });
    }
  };
  out.push(mix(pts[0], 5, pts[1], 1));
  for (let i = 2; i < n; i++) bezier(mix(pts[i - 2], 2, pts[i - 1], 1), mix(pts[i - 2], 1, pts[i - 1], 2), mix(pts[i - 2], 1, pts[i - 1], 4, pts[i], 1));
  bezier(mix(pts[n - 2], 2, pts[n - 1], 1), mix(pts[n - 2], 1, pts[n - 1], 2), mix(pts[n - 2], 1, pts[n - 1], 5));
  out.push(pts[n - 1]);
  return tidy(out);
}

/** Direction from a free end, at a right angle to `d`, pointing back toward `p`. */
function across(d: Dir, from: Pt, p: Pt): Dir {
  return d.y === 0 ? { x: 0, y: sign(p.y - from.y) } : { x: sign(p.x - from.x), y: 0 };
}

/** The main direction from a to b. */
function mainDir(a: Pt, b: Pt): Dir {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: sign(b.x - a.x) || 1, y: 0 } : { x: 0, y: sign(b.y - a.y) || 1 };
}

/**
 * The points of a connector from `a` to `b`. An end attached to a shape starts
 * on the shape's outline; free ends stay where they are. A `curve` is routed
 * with right angles, which are then rounded off.
 */
export function connectorPath(a: Pt, b: Pt, from: Stroke | null, to: Stroke | null, elbow: boolean, gap: number, curve = false): Pt[] {
  if (curve) return smoothPath(connectorPath(a, b, from, to, true, gap));
  const ca = from ? shapeCenter(from) : a;
  const cb = to ? shapeCenter(to) : b;
  if (!elbow) {
    const start = from ? attachPoint(from, cb, gap + from.width / 2) : a;
    const end = to ? attachPoint(to, ca, gap + to.width / 2) : b;
    return [start, end];
  }
  let ds: Dir;
  let de: Dir;
  let s: Pt;
  let e: Pt;
  if (from && to) {
    ds = sideToward(from, cb);
    de = sideToward(to, ca);
    s = port(from, ds, gap + from.width / 2);
    e = port(to, de, gap + to.width / 2);
  } else if (from) {
    ds = sideToward(from, b);
    s = port(from, ds, gap + from.width / 2);
    e = b;
    de = across(ds, e, s);
  } else if (to) {
    de = sideToward(to, a);
    e = port(to, de, gap + to.width / 2);
    s = a;
    // leave the free start at a right angle to how the end is entered
    ds = across(de, s, e);
  } else {
    s = a;
    e = b;
    ds = mainDir(a, b);
    de = across(ds, e, s);
  }
  if ((ds.x === 0 && ds.y === 0) || (de.x === 0 && de.y === 0)) return tidy([s, e]);
  return elbowPath(s, ds, e, de);
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

function endsOf(s: Stroke): { a: Pt; b: Pt } {
  const n = pointCount(s);
  return { a: { x: s.pts[0], y: s.pts[1] }, b: { x: s.pts[(n - 1) * 3], y: s.pts[(n - 1) * 3 + 1] } };
}

const GAP = 2;

/** A new connector (an arrow by default) from a to b, attached to the shapes given. */
export function makeConnector(
  a: Pt,
  b: Pt,
  from: Stroke | null,
  to: Stroke | null,
  style: { color: string; width: number; elbow: boolean; curve?: boolean; arrow?: boolean; dash?: boolean },
): Stroke {
  const pts = connectorPath(a, b, from, to, style.elbow, GAP, style.curve);
  return makeStroke({
    pen: "ballpoint",
    color: style.color,
    width: style.width,
    pts: toPts(pts),
    poly: true,
    arrow: style.arrow ?? true,
    dash: style.dash,
    elbow: style.elbow || style.curve,
    curve: style.curve,
    from: from?.id,
    to: to?.id,
  });
}

/** A connector routed again to the current position of its shapes (`shapeOf` finds them; missing shapes leave the end where it is). */
export function rerouted(c: Stroke, shapeOf: (id: string) => Stroke | undefined): Stroke {
  if (pointCount(c) < 2) return c;
  const from = c.from ? (shapeOf(c.from) ?? null) : null;
  const to = c.to ? (shapeOf(c.to) ?? null) : null;
  if (!from && !to) return c;
  const { a, b } = endsOf(c);
  // a straight connector with bends drawn by hand keeps only its ends
  return withStroke(c, { pts: toPts(connectorPath(a, b, from, to, !!c.elbow, GAP, !!c.curve)) });
}

/** Connectors attached to any of these shapes (that are not among them themselves). */
export function connectorsOf(page: Page, ids: ReadonlySet<string>): Stroke[] {
  return page.strokes.filter((s) => !ids.has(s.id) && ((s.from && ids.has(s.from)) || (s.to && ids.has(s.to))));
}

/**
 * After the items `moved` were moved, resized or rotated: connectors attached
 * to a moved shape are routed again. A connector that was moved on its own,
 * away from its shapes, lets go of them.
 */
export function followMoves(page: Page, moved: ReadonlySet<string>): Page {
  const byId = new Map(page.strokes.map((s) => [s.id, s] as const));
  let changed = false;
  const strokes = page.strokes.map((c) => {
    if (!c.from && !c.to) return c;
    const fromMoved = !!c.from && moved.has(c.from);
    const toMoved = !!c.to && moved.has(c.to);
    const self = moved.has(c.id);
    if (!fromMoved && !toMoved) {
      if (!self) return c;
      changed = true;
      return withStroke(c, { from: undefined, to: undefined });
    }
    // moved together with all its shapes: it is where it should be
    if (self && (!c.from || fromMoved || !byId.has(c.from)) && (!c.to || toMoved || !byId.has(c.to))) return c;
    changed = true;
    return rerouted(c, (id) => byId.get(id));
  });
  return changed ? { ...page, strokes } : page;
}

/** The labels of shapes: text boxes whose container is one of these strokes. */
export function labelsOf(page: Page, strokeIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const t of page.texts) if (t.container && strokeIds.has(t.container)) out.add(t.id);
  return out;
}

/** A selection with the labels of its shapes added (they move, are copied and deleted with them). */
export function withLabels(page: Page, sel: Selection): Selection {
  if (sel.strokes.size === 0) return sel;
  const labels = labelsOf(page, sel.strokes);
  if ([...labels].every((id) => sel.texts.has(id))) return sel;
  return { ...sel, texts: new Set([...sel.texts, ...labels]) };
}

/** The label of a shape, centred in it (`h` is the height of its text). */
export function labelBox(shape: Stroke, h: number): { x: number; y: number; w: number } {
  const b = strokePointBounds(shape);
  const pad = Math.min(16, Math.max(4, b.w * 0.08));
  const w = Math.max(40, b.w - 2 * pad);
  return { x: q(b.x + (b.w - w) / 2), y: q(b.y + b.h / 2 - h / 2), w: q(w) };
}
