import type { Pt } from "../geometry";
import { closedOutline } from "./fill";
import { parseColor } from "./pens";
import { ellipsePoints } from "./shapes";
import { itemsBounds, transformItems, translation } from "./transform";
import { makeStroke, newId, q, qp, type FillStyle, type Items, type LibraryItem, type Stroke, type TextAlign, type TextBox } from "./model";
import { isConnectable } from "./connectors";

/**
 * Excalidraw object libraries (`.excalidrawlib`, from libraries.excalidraw.com
 * or saved by Excalidraw and the Obsidian Excalidraw plugin): their items are
 * turned into ink – shapes, lines, arrows, pen strokes and text, with fills,
 * hatching, rounded corners, curves, rotation, labels in shapes and arrows
 * attached to shapes. The other way round, items from an ink page are saved
 * as a library item Excalidraw can open.
 */

/** An Excalidraw element (only what is read is typed; everything is checked). */
type ExEl = Record<string, unknown>;

export interface RawLibraryItem {
  id: string;
  name: string;
  elements: ExEl[];
}

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function elementsOf(v: unknown): ExEl[] {
  return Array.isArray(v) ? v.filter((e): e is ExEl => isObj(e) && typeof e.type === "string" && e.isDeleted !== true) : [];
}

/**
 * The items of a library: an `.excalidrawlib` file (version 1 or 2), the
 * library the Obsidian Excalidraw plugin keeps in its settings, or an
 * Excalidraw drawing (one item). Throws LibraryError for anything else.
 */
export function parseExcalidrawLibrary(data: unknown): RawLibraryItem[] {
  let v: unknown = data;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      throw new LibraryError("This is not an Excalidraw library (it is not JSON).");
    }
  }
  const out: RawLibraryItem[] = [];
  const add = (elements: ExEl[], name?: string, id?: string) => {
    if (elements.length === 0) return;
    out.push({ id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : newId(), name: name?.trim() || `Item ${out.length + 1}`, elements });
  };
  const items = (list: unknown) => {
    if (!Array.isArray(list)) return false;
    for (const it of list) {
      if (Array.isArray(it)) add(elementsOf(it));
      else if (isObj(it)) add(elementsOf(it.elements), str(it.name), str(it.id));
    }
    return true;
  };
  if (Array.isArray(v)) items(v);
  else if (isObj(v)) {
    // the Obsidian Excalidraw plugin's settings: the library is in "library2" (or "library" in old versions)
    const inner = v.library2 ?? (isObj(v.library) || typeof v.library === "string" ? v.library : undefined);
    if (inner !== undefined && v.type !== "excalidrawlib") return parseExcalidrawLibrary(inner);
    if (!items(v.libraryItems) && !items(v.library)) {
      if (Array.isArray(v.elements)) add(elementsOf(v.elements), "Drawing");
      else throw new LibraryError("This is not an Excalidraw library.");
    }
  } else throw new LibraryError("This is not an Excalidraw library.");
  return out;
}

// ------------------------------------------------------------------ Excalidraw → ink

function fillStyleOf(v: unknown): FillStyle {
  if (v === "solid") return "solid";
  if (v === "cross-hatch") return "cross";
  return "hatch";
}

/** Corner radius of a rounded Excalidraw rectangle. */
function cornerRadius(size: number, roundness: unknown): number {
  if (!isObj(roundness)) return 0;
  // ADAPTIVE_RADIUS (3): a fixed radius, but at most a quarter of the side
  if (roundness.type === 3) {
    const fixed = num(roundness.value, 32);
    return size <= fixed / 0.25 ? size * 0.25 : fixed;
  }
  return size * 0.25;
}

function roundRectPoints(x: number, y: number, w: number, h: number, r: number): Pt[] {
  if (r <= 0.5) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }
  r = Math.min(r, w / 2, h / 2);
  const out: Pt[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = from + (i / 6) * (Math.PI / 2);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return out;
}

/** A smooth curve through the points (Catmull–Rom), as Excalidraw draws curved lines. */
export function curveThrough(pts: ReadonlyArray<Pt>, steps = 8): Pt[] {
  if (pts.length < 3) return [...pts];
  const out: Pt[] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

function rotate(pts: Pt[], angle: number, c: Pt): Pt[] {
  if (!angle) return pts;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos }));
}

function toPts(points: ReadonlyArray<Pt>, pressures?: ReadonlyArray<number> | null): Float32Array {
  const arr = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    arr[i * 3] = q(p.x);
    arr[i * 3 + 1] = q(p.y);
    arr[i * 3 + 2] = qp(pressures ? (pressures[i] ?? 0.5) : 0.5);
  });
  return arr;
}

/** Points of a linear element (line, arrow, freedraw), absolute. */
function linearPoints(el: ExEl): Pt[] {
  const x = num(el.x);
  const y = num(el.y);
  const out: Pt[] = [];
  if (!Array.isArray(el.points)) return out;
  for (const p of el.points) {
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push({ x: x + (p[0] as number), y: y + (p[1] as number) });
  }
  return out;
}

function centerOf(pts: ReadonlyArray<Pt>): Pt {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/** Excalidraw's stroke widths (1, 2, 4) on the page. */
function widthOf(el: ExEl): number {
  return Math.max(1, Math.round(num(el.strokeWidth, 1) * 1.25 * 10) / 10);
}

const BOUND_TEXT_PADDING = 5;

/** Items converted from Excalidraw elements, moved so that they start at (0, 0). */
export function excalidrawToItems(elements: ReadonlyArray<ExEl>): Items & { skipped: number } {
  const strokes: Stroke[] = [];
  const texts: TextBox[] = [];
  const ids = new Map<string, string>();
  const byExId = new Map<string, Stroke>();
  let skipped = 0;
  const bindings: Array<{ stroke: Stroke; from?: string; to?: string }> = [];

  for (const el of elements) {
    const type = el.type as string;
    const opacity = num(el.opacity, 100);
    const line = parseColor(el.strokeColor ?? "#1e1e1e", opacity);
    const fill = parseColor(el.backgroundColor, opacity);
    const fillStyle = fillStyleOf(el.fillStyle);
    const exId = str(el.id) ?? newId();
    const id = newId();
    const angle = num(el.angle);
    const dash = el.strokeStyle === "dashed";
    const dot = el.strokeStyle === "dotted";
    const width = widthOf(el);
    const push = (s: Stroke) => {
      strokes.push(s);
      ids.set(exId, s.id);
      byExId.set(exId, s);
      return s;
    };
    const closedShape = (pts: Pt[]) => {
      if (!line && !fill) return null;
      return push(
        makeStroke({
          id,
          pen: "ballpoint",
          color: line ?? fill ?? "#000000",
          width: line ? width : 0.5,
          pts: toPts(pts),
          poly: true,
          closed: true,
          dash,
          dot,
          area: !line,
          fill: fill ?? undefined,
          fillStyle: fill ? fillStyle : undefined,
        }),
      );
    };
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.width);
    const h = num(el.height);
    const c = { x: x + w / 2, y: y + h / 2 };
    switch (type) {
      case "rectangle":
        closedShape(rotate(roundRectPoints(x, y, w, h, cornerRadius(Math.min(Math.abs(w), Math.abs(h)), el.roundness)), angle, c));
        break;
      case "diamond":
        closedShape(
          rotate(
            [
              { x: x + w / 2, y },
              { x: x + w, y: y + h / 2 },
              { x: x + w / 2, y: y + h },
              { x, y: y + h / 2 },
            ],
            angle,
            c,
          ),
        );
        break;
      case "ellipse":
        closedShape(ellipsePoints(c.x, c.y, Math.abs(w) / 2, Math.abs(h) / 2, angle));
        break;
      case "line":
      case "arrow": {
        let pts = linearPoints(el);
        if (pts.length === 0) break;
        pts = rotate(pts, angle, centerOf(pts));
        const elbow = el.elbowed === true;
        const first = pts[0];
        const last = pts[pts.length - 1];
        const loop = pts.length >= 3 && (el.polygon === true || (type === "line" && Math.hypot(last.x - first.x, last.y - first.y) <= 8));
        if (loop && Math.hypot(last.x - first.x, last.y - first.y) <= 8) pts = pts.slice(0, -1);
        if (isObj(el.roundness) && !elbow && pts.length >= 3) pts = loop ? curveThrough([...pts, pts[0]]).slice(0, -1) : curveThrough(pts);
        if (loop) {
          closedShape(pts);
          break;
        }
        if (!line) break;
        const s = push(
          makeStroke({
            id,
            pen: "ballpoint",
            color: line,
            width,
            pts: toPts(pts),
            poly: true,
            dash,
            dot,
            // an arrow without the property has the default head at its end
            arrow: type === "arrow" ? el.endArrowhead !== null : !!el.endArrowhead,
            arrowStart: !!el.startArrowhead,
            elbow,
          }),
        );
        const from = isObj(el.startBinding) ? str(el.startBinding.elementId) : undefined;
        const to = isObj(el.endBinding) ? str(el.endBinding.elementId) : undefined;
        if (from || to) bindings.push({ stroke: s, from, to });
        break;
      }
      case "freedraw": {
        let pts = linearPoints(el);
        if (pts.length === 0 || !line) break;
        pts = rotate(pts, angle, centerOf(pts));
        const pressures = el.simulatePressure === false && Array.isArray(el.pressures) && el.pressures.length === pts.length ? (el.pressures as number[]) : null;
        push(
          makeStroke({
            id,
            pen: pressures ? "fountain" : "ballpoint",
            color: line,
            width,
            pts: toPts(pts, pressures),
            fill: fill && pts.length >= 3 ? fill : undefined,
            fillStyle: fill ? fillStyle : undefined,
          }),
        );
        break;
      }
      case "text":
        break;
      default:
        // images (a library has no files for them), frames, embedded pages
        skipped++;
    }
  }

  // text, after the shapes they may be the label of
  const elById = new Map(elements.map((e) => [str(e.id) ?? "", e] as const));
  for (const el of elements) {
    if (el.type !== "text") continue;
    const text = (str(el.originalText) ?? str(el.text) ?? str(el.rawText) ?? "").replace(/\r\n/g, "\n");
    if (!text.trim()) continue;
    const color = parseColor(el.strokeColor ?? "#1e1e1e", num(el.opacity, 100)) ?? "#000000";
    const size = Math.max(4, num(el.fontSize, 20));
    const align: TextAlign = el.textAlign === "center" || el.textAlign === "right" ? el.textAlign : "left";
    const x = num(el.x);
    const y = num(el.y);
    const w = Math.max(10, num(el.width, 100));
    const h = Math.max(4, num(el.height, size * 1.25));
    const containerId = str(el.containerId);
    const shape = containerId ? byExId.get(containerId) : undefined;
    const containerEl = containerId ? elById.get(containerId) : undefined;
    if (shape && containerEl && isConnectable(shape)) {
      const cx = num(containerEl.x);
      const cw = Math.abs(num(containerEl.width));
      const inner = Math.max(20, cw - 2 * BOUND_TEXT_PADDING);
      texts.push({ id: newId(), x: q(cx + (cw - inner) / 2), y: q(y), w: q(inner), h: q(h), text, size, color, align: align === "left" ? "center" : align, container: shape.id });
      continue;
    }
    // our font is not Excalidraw's: a little more room, so that lines do not wrap differently
    const slack = w * 0.12 + 8;
    const dx = align === "center" ? slack / 2 : align === "right" ? slack : 0;
    const box: TextBox = { id: newId(), x: q(x - dx), y: q(y), w: q(w + slack), h: q(h), text, size, color };
    texts.push(align === "left" ? box : { ...box, align });
  }

  // arrows attached to shapes
  const final = strokes.map((s) => {
    const b = bindings.find((x) => x.stroke === s);
    if (!b) return s;
    const target = (exId?: string) => {
      const sid = exId ? ids.get(exId) : undefined;
      const sh = sid ? strokes.find((t) => t.id === sid) : undefined;
      return sh && sh !== s && isConnectable(sh) ? sh.id : undefined;
    };
    return makeStroke({ ...s, from: target(b.from), to: target(b.to) });
  });

  const items: Items = { strokes: final, texts, images: [], links: [], figures: [] };
  const box = itemsBounds(items);
  const moved = box ? transformItems(items, translation(-box.x, -box.y)) : items;
  return { ...moved, skipped };
}

/** The items of a library as ink (items that become empty are left out). */
export function libraryItems(raw: ReadonlyArray<RawLibraryItem>): LibraryItem[] {
  const out: LibraryItem[] = [];
  for (const r of raw) {
    const items = excalidrawToItems(r.elements);
    if (items.strokes.length + items.texts.length === 0) continue;
    out.push({ id: r.id, name: r.name, items: { strokes: items.strokes, texts: items.texts, images: [], links: [], figures: [] } });
  }
  return out;
}

// ------------------------------------------------------------------ ink → Excalidraw

let seedCounter = 1;

function seed(): number {
  return (Math.floor(Math.random() * 2 ** 30) + seedCounter++) % 2 ** 31;
}

const EX_FILL: Record<FillStyle, string> = { solid: "solid", hatch: "hachure", cross: "cross-hatch" };

/** Points of a stroke as Excalidraw's relative points. */
function relPoints(s: Stroke): { x: number; y: number; points: Array<[number, number]>; pressures: number[]; w: number; h: number } {
  const n = Math.floor(s.pts.length / 3);
  const x0 = s.pts[0];
  const y0 = s.pts[1];
  const points: Array<[number, number]> = [];
  const pressures: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = s.pts[i * 3] - x0;
    const py = s.pts[i * 3 + 1] - y0;
    points.push([Math.round(px * 10) / 10, Math.round(py * 10) / 10]);
    pressures.push(Math.round(s.pts[i * 3 + 2] * 1000) / 1000);
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { x: x0, y: y0, points, pressures, w: maxX - minX, h: maxY - minY };
}

/** A closed four-point stroke that is an upright rectangle or a diamond (Excalidraw has element types for them). */
function boxKind(s: Stroke): { kind: "rectangle" | "diamond"; x: number; y: number; w: number; h: number } | null {
  if (!s.closed || Math.floor(s.pts.length / 3) !== 4) return null;
  const p = [0, 1, 2, 3].map((i) => ({ x: s.pts[i * 3], y: s.pts[i * 3 + 1] }));
  const xs = p.map((v) => v.x);
  const ys = p.map((v) => v.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.2;
  const corners = p.every((v) => (eq(v.x, x) || eq(v.x, x + w)) && (eq(v.y, y) || eq(v.y, y + h)));
  if (corners) return { kind: "rectangle", x, y, w, h };
  const mids = p.every((v) => (eq(v.x, x + w / 2) && (eq(v.y, y) || eq(v.y, y + h))) || (eq(v.y, y + h / 2) && (eq(v.x, x) || eq(v.x, x + w))));
  return mids ? { kind: "diamond", x, y, w, h } : null;
}

/**
 * Items as Excalidraw elements (one group, so that they stay together).
 * `wrap` breaks text into the lines it shows (Excalidraw keeps them so).
 */
export function itemsToExcalidraw(items: Pick<Items, "strokes" | "texts">, opts: { wrap?: (t: TextBox) => string[]; now?: number } = {}): ExEl[] {
  const group = newId(12);
  const now = opts.now ?? Date.now();
  const out: ExEl[] = [];
  const bound = new Map<string, Array<{ id: string; type: string }>>();
  const bind = (shapeId: string, id: string, type: string) => {
    const list = bound.get(shapeId) ?? [];
    list.push({ id, type });
    bound.set(shapeId, list);
  };
  const base = (id: string, type: string, x: number, y: number, w: number, h: number): ExEl => ({
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [group],
    frameId: null,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
  });
  const exported = new Map<string, string>();
  for (const s of items.strokes) {
    if (Math.floor(s.pts.length / 3) === 0) continue;
    const strokeWidth = Math.max(0.5, Math.round((s.width / 1.25) * 10) / 10);
    const common = {
      strokeColor: s.area ? "transparent" : s.color,
      backgroundColor: s.fill ?? "transparent",
      fillStyle: EX_FILL[s.fillStyle ?? "solid"],
      strokeWidth,
      strokeStyle: s.dot ? "dotted" : s.dash ? "dashed" : "solid",
      opacity: s.pen === "marker" ? 50 : 100,
    };
    const box = boxKind(s);
    if (box) {
      out.push({ ...base(s.id, box.kind, box.x, box.y, box.w, box.h), ...common });
      exported.set(s.id, box.kind);
      continue;
    }
    const r = relPoints(s);
    if (!s.poly) {
      out.push({ ...base(s.id, "freedraw", r.x, r.y, r.w, r.h), ...common, points: r.points, pressures: r.pressures, simulatePressure: false, lastCommittedPoint: null });
      exported.set(s.id, "freedraw");
      continue;
    }
    const closed = !!(s.closed || s.area || (s.fill && closedOutline(s)));
    const points = closed ? [...r.points, [0, 0] as [number, number]] : r.points;
    const arrow = s.arrow || s.arrowStart;
    const el: ExEl = {
      ...base(s.id, arrow ? "arrow" : "line", r.x, r.y, r.w, r.h),
      ...common,
      points,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: s.arrowStart ? "arrow" : null,
      endArrowhead: s.arrow ? "arrow" : null,
    };
    if (closed) el.polygon = true;
    if (arrow && s.from) {
      el.startBinding = { elementId: s.from, focus: 0, gap: 2 };
      bind(s.from, s.id, "arrow");
    }
    if (arrow && s.to) {
      el.endBinding = { elementId: s.to, focus: 0, gap: 2 };
      bind(s.to, s.id, "arrow");
    }
    out.push(el);
    exported.set(s.id, el.type as string);
  }
  for (const t of items.texts) {
    const lines = opts.wrap ? opts.wrap(t) : t.text.split("\n");
    // Excalidraw can only put text into rectangles, diamonds and ellipses
    const kind = t.container ? exported.get(t.container) : undefined;
    const container = kind === "rectangle" || kind === "diamond" ? t.container : undefined;
    out.push({
      ...base(t.id, "text", t.x, t.y, t.w, t.h),
      strokeColor: t.color,
      text: lines.join("\n"),
      originalText: t.text,
      fontSize: t.size,
      fontFamily: 2,
      textAlign: t.align ?? "left",
      verticalAlign: container ? "middle" : "top",
      containerId: container ?? null,
      lineHeight: 1.3,
      autoResize: !container,
      baseline: Math.round(t.size * 0.9),
    });
    if (container) bind(container, t.id, "text");
  }
  for (const el of out) {
    const list = bound.get(el.id as string);
    if (list) el.boundElements = list;
  }
  // drop attachments to shapes that are not part of the item
  const present = new Set(out.map((e) => e.id as string));
  for (const el of out) {
    for (const k of ["startBinding", "endBinding"]) {
      const b = el[k];
      if (isObj(b) && !present.has(b.elementId as string)) el[k] = null;
    }
  }
  return out;
}

export const LIBRARY_SOURCE = "https://github.com/stefanmayer06/Obsidian-writing-for-eink";

/**
 * A library file (version 2) with an item added. `existing` is the file's
 * text (null: a new library); items it has are kept as they are.
 */
export function addToLibraryFile(existing: string | null, item: { name: string; elements: ExEl[]; id?: string; created?: number }): string {
  let libraryItems: unknown[] = [];
  if (existing && existing.trim()) {
    let v: unknown;
    try {
      v = JSON.parse(existing);
    } catch {
      throw new LibraryError("The library file could not be read, so nothing was added to it.");
    }
    if (isObj(v) && Array.isArray(v.libraryItems)) libraryItems = v.libraryItems;
    else if (isObj(v) && Array.isArray(v.library)) libraryItems = v.library.map((els: unknown) => ({ id: newId(), status: "unpublished", elements: els, created: Date.now() }));
    else throw new LibraryError("The library file could not be read, so nothing was added to it.");
  }
  libraryItems = [...libraryItems, { id: item.id ?? newId(), status: "unpublished", elements: item.elements, name: item.name, created: item.created ?? Date.now() }];
  return JSON.stringify({ type: "excalidrawlib", version: 2, source: LIBRARY_SOURCE, libraryItems }, null, 2);
}

/** A library file without one of its items. */
export function removeFromLibraryFile(existing: string, itemId: string): string {
  let v: unknown;
  try {
    v = JSON.parse(existing);
  } catch {
    throw new LibraryError("The library file could not be read.");
  }
  if (!isObj(v) || !Array.isArray(v.libraryItems)) throw new LibraryError("Only items of version 2 libraries can be removed.");
  return JSON.stringify({ ...v, libraryItems: v.libraryItems.filter((it) => !(isObj(it) && it.id === itemId)) }, null, 2);
}

/**
 * Where to download a library from, for what was pasted: a link to an
 * `.excalidrawlib` file, or an "Add to Excalidraw" link of
 * libraries.excalidraw.com (excalidraw.com/#addLibrary=…). Null otherwise.
 */
export function libraryUrlFrom(text: string): string | null {
  const t = text.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  const m = /[#&?]addLibrary=([^&#]+)/.exec(t);
  if (m) {
    let inner: string;
    try {
      inner = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    return /^https:\/\//i.test(inner) ? inner : null;
  }
  return t;
}

/** A file name for a library downloaded from a link. */
export function libraryNameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  const last = decodeURIComponent(path.split("/").pop() ?? "").replace(/\.excalidrawlib$/i, "").replace(/\.json$/i, "");
  const clean = last.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return clean || "Library";
}
