import { distanceToSegment, type Pt } from "../geometry";
import { strokeHit, strokeInside, strokePointBounds } from "./geom";
import { makeStroke, newId, type Stroke } from "./model";
import { areaStroke, fillOutline } from "./fill";

/**
 * The erasers of the Boox Notes app:
 *  - partial eraser: removes the parts of strokes it passes over (strokes are split)
 *  - stroke eraser: removes every stroke it touches
 *  - lasso eraser: removes the strokes inside a drawn loop
 * and "scribble to erase": scratching over writing erases it.
 *
 * Fills are not rubbed away with the writing on them: the partial and the
 * stroke eraser leave areas alone, and cutting the line of a filled shape
 * keeps its fill (as an area). The lasso eraser and the fill tool remove fills.
 */

/** Points of a straight-segment stroke, filled in so that erasing can cut an edge in the middle. */
function densify(s: Stroke, step: number): Float32Array {
  const p = s.pts;
  const n = Math.floor(p.length / 3);
  const out: number[] = [];
  const total = s.closed && n > 2 ? n + 1 : n;
  for (let k = 0; k < total; k++) {
    const i = k % n;
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const pr = p[i * 3 + 2];
    if (k > 0) {
      const j = (k - 1) % n;
      const px = p[j * 3];
      const py = p[j * 3 + 1];
      const len = Math.hypot(x - px, y - py);
      const parts = Math.floor(len / step);
      for (let t = 1; t < parts; t++) out.push(px + ((x - px) * t) / parts, py + ((y - py) * t) / parts, pr);
    }
    out.push(x, y, pr);
  }
  return Float32Array.from(out);
}

/**
 * Erase the parts of a stroke within `radius` of the eraser path a–b.
 * Returns null when the stroke is not touched, otherwise the remaining pieces
 * (possibly none).
 */
export function eraseFromStroke(s: Stroke, a: Pt, b: Pt, radius: number): Stroke[] | null {
  if (s.area || !strokeHit(s, a, b, radius)) return null;
  const reach = radius + s.width / 2;
  const pts = s.poly ? densify(s, Math.max(1.5, radius / 3)) : s.pts;
  const n = Math.floor(pts.length / 3);
  const keep = new Uint8Array(n);
  let removed = 0;
  for (let i = 0; i < n; i++) {
    const hit = distanceToSegment({ x: pts[i * 3], y: pts[i * 3 + 1] }, a, b) <= reach;
    keep[i] = hit ? 0 : 1;
    if (hit) removed++;
  }
  if (removed === 0) {
    // the eraser crossed a long segment between two points: cut it (shapes are densified already)
    return s.poly ? null : [s];
  }
  const pieces: Stroke[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const count = end - start;
    // single leftover points of a longer stroke are crumbs, not dots
    if (count >= 2 || n === 1) {
      const isTail = end === n;
      pieces.push(
        makeStroke({
          pen: s.pen,
          color: s.color,
          width: s.width,
          pts: pts.slice(start * 3, end * 3),
          poly: s.poly,
          dash: s.dash,
          dot: s.dot,
          arrow: s.arrow && isTail,
          id: newId(),
        }),
      );
    }
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      if (start < 0) start = i;
    } else flush(i);
  }
  flush(n);
  // a closed outline cut once is one open piece: join the end back onto the start
  if (s.closed && pieces.length >= 2 && keep[0] && keep[n - 1]) {
    const first = pieces.shift() as Stroke;
    const last = pieces.pop() as Stroke;
    const joined = new Float32Array(last.pts.length + first.pts.length - 3);
    joined.set(last.pts.subarray(0, last.pts.length - 3));
    joined.set(first.pts, last.pts.length - 3);
    pieces.push({ ...last, pts: joined });
  }
  // the fill stays where it was
  const poly = fillOutline(s);
  if (poly && s.fill) pieces.unshift(areaStroke(poly, s.fill, s.fillStyle ?? "solid"));
  return pieces;
}

export interface EraseResult {
  /** Ids of strokes that were removed or split. */
  removed: Set<string>;
  /** New pieces that replace split strokes. */
  added: Stroke[];
}

/** Partial eraser over a set of candidate strokes. */
export function partialErase(candidates: Iterable<Stroke>, a: Pt, b: Pt, radius: number): EraseResult {
  const removed = new Set<string>();
  const added: Stroke[] = [];
  for (const s of candidates) {
    const pieces = eraseFromStroke(s, a, b, radius);
    if (!pieces || (pieces.length === 1 && pieces[0] === s)) continue;
    removed.add(s.id);
    added.push(...pieces);
  }
  return { removed, added };
}

/** Stroke eraser: ids of the strokes the eraser touches. */
export function strokeErase(candidates: Iterable<Stroke>, a: Pt, b: Pt, radius: number): Set<string> {
  const out = new Set<string>();
  for (const s of candidates) if (!s.area && strokeHit(s, a, b, radius)) out.add(s.id);
  return out;
}

/** Strokes inside a lasso: most of their points are within the loop. */
export function strokesInLasso(strokes: Iterable<Stroke>, lasso: ReadonlyArray<Pt>, share = 0.6): Set<string> {
  const out = new Set<string>();
  if (lasso.length < 3) return out;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of lasso) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  for (const s of strokes) {
    const r = strokePointBounds(s);
    if (r.x > maxX || r.y > maxY || r.x + r.w < minX || r.y + r.h < minY) continue;
    if (strokeInside(s, lasso) >= share) out.add(s.id);
  }
  return out;
}

// ------------------------------------------------------------------ scribble to erase

/**
 * Is this stroke a scribble (a fast back-and-forth scratch)? Counts how often
 * the pen reverses along the main direction of movement.
 */
export function isScribble(s: Stroke): boolean {
  const p = s.pts;
  const n = Math.floor(p.length / 3);
  if (n < 16 || s.poly) return false;
  const r = strokePointBounds(s);
  const diag = Math.hypot(r.w, r.h);
  if (diag < 18) return false;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(p[i * 3] - p[(i - 1) * 3], p[i * 3 + 1] - p[(i - 1) * 3 + 1]);
  if (len < 4.5 * diag) return false;
  // main axis of the scratch
  const horizontal = r.w >= r.h;
  const axis = horizontal ? 0 : 1;
  const minLeg = Math.max(8, (horizontal ? r.w : r.h) * 0.35);
  let reversals = 0;
  let dir = 0;
  let anchor = p[axis];
  for (let i = 1; i < n; i++) {
    const v = p[i * 3 + axis];
    const d = v - anchor;
    if (dir >= 0 && d <= -minLeg) {
      if (dir > 0) reversals++;
      dir = -1;
      anchor = v;
    } else if (dir <= 0 && d >= minLeg) {
      if (dir < 0) reversals++;
      dir = 1;
      anchor = v;
    } else if ((dir > 0 && v > anchor) || (dir < 0 && v < anchor)) {
      anchor = v;
    }
  }
  return reversals >= 5;
}

/**
 * The strokes a scribble erases: those it passes over that lie mostly inside
 * the scribbled area (so a long line crossed by the scratch survives).
 */
export function scribbleTargets(scribble: Stroke, candidates: Iterable<Stroke>): Set<string> {
  const area = strokePointBounds(scribble);
  const p = scribble.pts;
  const n = Math.floor(p.length / 3);
  const out = new Set<string>();
  const radius = Math.max(2, scribble.width);
  for (const s of candidates) {
    if (s.id === scribble.id || s.area) continue;
    const r = strokePointBounds(s);
    const ix = Math.max(0, Math.min(r.x + r.w, area.x + area.w) - Math.max(r.x, area.x));
    const iy = Math.max(0, Math.min(r.y + r.h, area.y + area.h) - Math.max(r.y, area.y));
    const own = Math.max(1, r.w) * Math.max(1, r.h);
    if ((Math.max(ix, 1) * Math.max(iy, 1)) / own < 0.4) continue;
    for (let i = 1; i < n; i++) {
      if (strokeHit(s, { x: p[(i - 1) * 3], y: p[(i - 1) * 3 + 1] }, { x: p[i * 3], y: p[i * 3 + 1] }, radius)) {
        out.add(s.id);
        break;
      }
    }
  }
  return out;
}
