import { describe, expect, it } from "vitest";
import { parseInkFile, serializeInkFile } from "../src/core/ink/codec";
import { cloneItems, EMPTY_META, EMPTY_SELECTION, makeStroke, paperPage, q, withStroke, type Items, type Page, type Stroke, type TextBox } from "../src/core/ink/model";
import { areaStroke, closedOutline, enclosedArea, fillGeometry, fillTargetAt, hatchLines, traceOutline } from "../src/core/ink/fill";
import { eraseFromStroke, strokeErase } from "../src/core/ink/erase";
import { pointInPolygon, StrokeIndex, strokePointBounds } from "../src/core/ink/geom";
import { shapeFromDrag } from "../src/core/ink/shapes";
import { arrowHead, parseColor, strokeSegments } from "../src/core/ink/pens";
import { connectorPath, elbowPath, followMoves, labelBox, makeConnector, shapeAt, smoothPath, withLabels } from "../src/core/ink/connectors";
import { itemsBounds, transformItems, translation } from "../src/core/ink/transform";
import {
  addToLibraryFile,
  curveThrough,
  excalidrawToItems,
  itemsToExcalidraw,
  LibraryError,
  libraryItems,
  libraryNameFromUrl,
  libraryUrlFrom,
  parseExcalidrawLibrary,
  removeFromLibraryFile,
} from "../src/core/ink/excalidrawLib";
import { flowchartLibrary } from "../src/core/ink/flowchart";
import { excalidrawToInk } from "../src/core/ink/fromExcalidraw";
import { isConnectable } from "../src/core/ink/connectors";
import { inkScene } from "../src/core/ink/scene";
import { loadSettings } from "../src/settings";

const style = { pen: "ballpoint" as const, color: "#000000", width: 2 };

function rect(x: number, y: number, w: number, h: number, extra: Partial<Stroke> = {}): Stroke {
  return withStroke(shapeFromDrag("rect", { x, y }, { x: x + w, y: y + h }, style), extra);
}

function line(a: [number, number], b: [number, number]): Stroke {
  return shapeFromDrag("line", { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, style);
}

function pageWith(strokes: Stroke[], texts: TextBox[] = []): Page {
  return { ...paperPage(), strokes, texts };
}

function near(page: Page) {
  const idx = new StrokeIndex(page.strokes);
  return (r: { x: number; y: number; w: number; h: number }) => idx.query(r);
}

/** A hand-drawn loop (a circle drawn with the pen). */
function loop(cx: number, cy: number, r: number): Stroke {
  const n = 60;
  const pts = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts[i * 3] = q(cx + r * Math.cos(a));
    pts[i * 3 + 1] = q(cy + r * Math.sin(a));
    pts[i * 3 + 2] = 0.5;
  }
  return makeStroke({ pen: "fountain", color: "#000000", width: 2, pts });
}

describe("file format", () => {
  it("keeps fills, areas, two-headed and elbow arrows, connectors and labels", () => {
    const box = rect(10, 10, 100, 60, { fill: "#c4dfff", fillStyle: "hatch" });
    const area = areaStroke(
      [
        { x: 200, y: 200 },
        { x: 300, y: 200 },
        { x: 300, y: 260 },
      ],
      "#fff3bf",
      "cross",
    );
    const arrow = withStroke(makeConnector({ x: 0, y: 0 }, { x: 400, y: 50 }, box, null, { color: "#d32f2f", width: 2, elbow: true }), { arrowStart: true });
    const label: TextBox = { id: "lbl", x: 20, y: 30, w: 80, h: 20, text: "Start", size: 16, color: "#000000", align: "center", container: box.id };
    const page = pageWith([box, area, arrow], [label]);
    const text = serializeInkFile("", { doc: { pages: [page] }, meta: EMPTY_META });
    expect(text).toMatch(/ f:c4dfff s:h/);
    expect(text).toMatch(new RegExp(` a:${box.id}`));
    const back = parseInkFile(text).doc.pages[0];
    const [b, a, c] = back.strokes;
    expect(b.fill).toBe("#c4dfff");
    expect(b.fillStyle).toBe("hatch");
    expect(a.area).toBe(true);
    expect(a.fillStyle).toBe("cross");
    expect(c.arrow && c.arrowStart && c.elbow).toBe(true);
    expect(c.curve).toBeUndefined();
    expect(c.from).toBe(box.id);
    expect(c.to).toBeUndefined();
    expect(back.texts[0]).toMatchObject({ align: "center", container: box.id });
    // a second round gives the same file
    expect(serializeInkFile("", { doc: { pages: [back] }, meta: EMPTY_META })).toBe(text);
  });

  it("keeps curved connectors", () => {
    const a = rect(0, 0, 100, 50);
    const b = rect(300, 200, 100, 50);
    const c = makeConnector({ x: 50, y: 25 }, { x: 350, y: 225 }, a, b, { color: "#000000", width: 2, elbow: true, curve: true });
    expect(c.curve && c.elbow).toBe(true);
    const back = parseInkFile(serializeInkFile("", { doc: { pages: [pageWith([a, b, c])] }, meta: EMPTY_META })).doc.pages[0].strokes[2];
    expect(back.curve && back.elbow).toBe(true);
    expect(back.from).toBe(a.id);
    expect(back.to).toBe(b.id);
  });

  it("ignores stroke fields it does not know (written by a later version)", () => {
    const text = serializeInkFile("", { doc: { pages: [pageWith([rect(0, 0, 10, 10)])] }, meta: EMPTY_META }).replace(/(\nS [^\n]+)/, "$1 z:whatever f:nothex");
    const s = parseInkFile(text).doc.pages[0].strokes[0];
    expect(s.fill).toBeUndefined();
    expect(s.closed).toBe(true);
  });

  it("drops the solid style and empty fields", () => {
    const s = rect(0, 0, 10, 10, { fill: "#ffffff", fillStyle: "solid" });
    expect("fillStyle" in s).toBe(false);
    const plain = withStroke(s, { fill: undefined, fillStyle: "hatch" });
    expect("fill" in plain || "fillStyle" in plain).toBe(false);
  });
});

describe("copies", () => {
  it("keeps connectors and labels on the copies of their shapes", () => {
    const a = rect(0, 0, 100, 50);
    const b = rect(300, 0, 100, 50);
    const c = makeConnector({ x: 50, y: 25 }, { x: 350, y: 25 }, a, b, { color: "#000000", width: 2, elbow: false });
    const t: TextBox = { id: "t1", x: 0, y: 0, w: 100, h: 20, text: "A", size: 16, color: "#000000", container: a.id };
    const copy = cloneItems({ strokes: [a, b, c], texts: [t], images: [], links: [], figures: [] });
    const [a2, b2, c2] = copy.strokes;
    expect(a2.id).not.toBe(a.id);
    expect(c2.from).toBe(a2.id);
    expect(c2.to).toBe(b2.id);
    expect(copy.texts[0].container).toBe(a2.id);
    // copied without its shapes, the connector lets go of them
    const alone = cloneItems({ strokes: [c], texts: [t], images: [], links: [], figures: [] });
    expect(alone.strokes[0].from).toBeUndefined();
    expect(alone.texts[0].container).toBeUndefined();
  });
});

describe("fills", () => {
  it("draws arrow heads at both ends", () => {
    const s = withStroke(shapeFromDrag("arrow", { x: 0, y: 0 }, { x: 100, y: 0 }, style), { arrowStart: true });
    const start = arrowHead(s, true);
    expect(start.every((seg) => seg.b.x === 0 && seg.a.x > 0)).toBe(true);
    expect(strokeSegments(s).length).toBe(1 + 4);
  });

  it("knows which strokes enclose an area", () => {
    expect(closedOutline(rect(0, 0, 50, 50))).toHaveLength(4);
    expect(closedOutline(loop(100, 100, 40))).not.toBeNull();
    expect(closedOutline(line([0, 0], [100, 100]))).toBeNull();
    expect(closedOutline(makeStroke({ pen: "marker", color: "#ffe14d", width: 16, pts: loop(0, 0, 40).pts }))).toBeNull();
  });

  it("hatches the inside of a shape", () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const lines = hatchLines(sq, 10, -Math.PI / 4);
    expect(lines.length).toBeGreaterThan(10);
    for (const [a, b] of lines) {
      for (const p of [a, b]) {
        expect(p.x).toBeGreaterThan(-0.01);
        expect(p.x).toBeLessThan(100.01);
        expect(p.y).toBeGreaterThan(-0.01);
        expect(p.y).toBeLessThan(100.01);
      }
      // at -45°: going right goes up
      expect(Math.sign(b.x - a.x)).toBe(-Math.sign(b.y - a.y));
    }
    const g = fillGeometry(rect(0, 0, 100, 100, { fill: "#000000", fillStyle: "cross" }));
    expect(g?.area).toBeNull();
    expect(g?.lines?.split("M").length).toBeGreaterThan(20);
    expect(fillGeometry(rect(0, 0, 100, 100, { fill: "#ff0000" }))?.area).toMatch(/^M0 0L100 0L100 100L0 100Z$/);
  });

  it("traces the outline of filled cells", () => {
    const W = 6;
    const mask = new Uint8Array(W * 5);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 4; x++) mask[y * W + x] = 1;
    const out = traceOutline(mask, W, 5);
    expect(out[0]).toEqual([1, 1]);
    expect(new Set(out.map(([x, y]) => `${x},${y}`)).size).toBe(10);
  });

  it("finds the area enclosed by separate lines, and nothing where it is open", () => {
    const box = [line([100, 100], [300, 100]), line([300, 100], [300, 250]), line([300, 250], [100, 250]), line([100, 250], [100, 100])];
    const page = pageWith(box);
    const area = enclosedArea(near(page), { x: 200, y: 170 }, page);
    expect(area).not.toBeNull();
    expect(area?.area).toBeGreaterThan(180 * 130);
    expect(area?.area).toBeLessThan(200 * 150);
    expect(pointInPolygon(200, 170, area?.pts ?? [])).toBe(true);
    // the outline reaches under the lines
    expect(area?.bounds.x).toBeLessThan(102);
    // a gap that is too wide: open
    const open = pageWith(box.slice(0, 3));
    expect(enclosedArea(near(open), { x: 200, y: 170 }, open)).toBeNull();
    // on a line
    expect(enclosedArea(near(page), { x: 200, y: 100 }, page)).toBeNull();
    // a small gap still closes
    const gappy = pageWith([line([100, 100], [300, 100]), line([300, 100], [300, 250]), line([300, 250], [100, 250]), line([100, 247], [100, 104])]);
    expect(enclosedArea(near(gappy), { x: 200, y: 170 }, gappy)).not.toBeNull();
  });

  it("fills the shape that was tapped, or the part of it a line divides off", () => {
    const box = rect(100, 100, 200, 100);
    const page = pageWith([box]);
    const t = fillTargetAt(page, { x: 150, y: 150 }, near(page));
    expect(t?.kind).toBe("stroke");
    // handwriting inside the box does not change that
    const written = pageWith([box, loop(200, 150, 10), line([130, 130], [170, 135])]);
    expect(fillTargetAt(written, { x: 150, y: 170 }, near(written))?.kind).toBe("stroke");
    // a line across the box: only the half that was tapped
    const halves = pageWith([box, line([200, 100], [200, 200])]);
    const half = fillTargetAt(halves, { x: 150, y: 150 }, near(halves));
    expect(half?.kind).toBe("area");
    if (half?.kind === "area") {
      const xs = half.pts.map((p) => p.x);
      expect(Math.max(...xs)).toBeLessThan(206);
      expect(half.existing).toBeNull();
      // filled once, tapping again finds that area
      const filled = { ...halves, strokes: [...halves.strokes, areaStroke(half.pts, "#ff0000", "solid")] };
      const again = fillTargetAt(filled, { x: 150, y: 150 }, near(filled));
      expect(again?.kind === "area" && again.existing?.area).toBe(true);
    }
    // a pen loop is filled itself
    const ring = loop(500, 500, 60);
    const loopPage = pageWith([ring]);
    const lt = fillTargetAt(loopPage, { x: 500, y: 500 }, near(loopPage));
    expect(lt?.kind === "stroke" && lt.stroke.id).toBe(ring.id);
    // nothing around
    expect(fillTargetAt(pageWith([]), { x: 500, y: 500 }, near(pageWith([])))).toBeNull();
  });

  it("keeps fills when the line around them is erased", () => {
    const box = rect(0, 0, 100, 100, { fill: "#ff0000" });
    const pieces = eraseFromStroke(box, { x: 50, y: -5 }, { x: 50, y: 5 }, 4) as Stroke[];
    expect(pieces.some((p) => p.area && p.fill === "#ff0000")).toBe(true);
    expect(pieces.filter((p) => !p.area).every((p) => !p.fill)).toBe(true);
    const area = pieces.find((p) => p.area) as Stroke;
    // erasers pass over areas
    expect(eraseFromStroke(area, { x: 0, y: 50 }, { x: 100, y: 50 }, 10)).toBeNull();
    expect(strokeErase([area], { x: 0, y: 0 }, { x: 100, y: 0 }, 10).size).toBe(0);
  });

  it("leaves areas out of the handwriting", () => {
    const area = areaStroke(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 50 },
      ],
      "#ff0000",
      "solid",
    );
    const box = rect(100, 100, 50, 50, { fill: "#00ff00" });
    const { elements } = inkScene({ pages: [pageWith([area, box])] }, EMPTY_META);
    expect(elements.some((e) => e.id === area.id)).toBe(false);
    expect(elements.find((e) => e.id === box.id)?.type).toBe("rectangle");
  });
});

describe("connectors", () => {
  const a = rect(100, 100, 120, 60);
  const b = rect(400, 300, 120, 60);
  const page = pageWith([a, b]);

  it("finds the shape under the pen", () => {
    expect(shapeAt(page, { x: 150, y: 120 }, 5)?.id).toBe(a.id);
    expect(shapeAt(page, { x: 97, y: 120 }, 5)?.id).toBe(a.id);
    expect(shapeAt(page, { x: 50, y: 50 }, 5)).toBeNull();
    // the smallest shape around the point
    const inner = rect(120, 110, 30, 20);
    expect(shapeAt(pageWith([a, inner]), { x: 130, y: 120 }, 0)?.id).toBe(inner.id);
  });

  it("runs from outline to outline", () => {
    const pts = connectorPath({ x: 160, y: 130 }, { x: 460, y: 330 }, a, b, false, 2);
    expect(pts).toHaveLength(2);
    // leaves A through its bottom edge toward B's centre (a little outside: half the line width and a gap)
    expect(pts[0].x).toBeCloseTo(205 + 3 * (300 / Math.hypot(300, 200)), 3);
    expect(pts[0].y).toBeCloseTo(160 + 3 * (200 / Math.hypot(300, 200)), 3);
    expect(pointInPolygon(pts[0].x, pts[0].y, closedOutline(a) ?? [])).toBe(false);
    expect(pointInPolygon(pts[1].x, pts[1].y, closedOutline(b) ?? [])).toBe(false);
    expect(pts[1].x).toBeLessThan(460);
  });

  it("routes elbow arrows with right angles", () => {
    const pts = connectorPath({ x: 160, y: 130 }, { x: 460, y: 330 }, a, b, true, 2);
    for (let i = 1; i < pts.length; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y).toBe(true);
    // B is further below than beside A (for A's size): out of A's bottom, into B's top
    expect(pts[0]).toEqual({ x: 160, y: 163 });
    expect(pts[pts.length - 1]).toEqual({ x: 460, y: 297 });
    expect(pts).toHaveLength(4);
    // side by side: out of the right side, into the left side
    const c = rect(400, 90, 120, 60);
    const side = connectorPath({ x: 160, y: 130 }, { x: 460, y: 120 }, a, c, true, 2);
    expect(side[0]).toEqual({ x: 223, y: 130 });
    expect(side[side.length - 1]).toEqual({ x: 397, y: 120 });
    // a free end: one bend
    const l = elbowPath({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 80 }, { x: 0, y: -1 });
    expect(l).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
  });

  it("draws curves through the bends: a B-spline, as Mermaid draws its links", () => {
    // in a line it stays a line
    expect(smoothPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ]);
    expect(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toHaveLength(2);
    const s = smoothPath([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 80 }]);
    // from the first point to the last, leaving and arriving upright, rounding the bends off
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 200, y: 80 });
    const [p0, p1, q1, q0] = [s[0], s[1], s[s.length - 2], s[s.length - 1]];
    expect(Math.abs(p1.x - p0.x)).toBeLessThan(0.1 * Math.abs(p1.y - p0.y));
    expect(Math.abs(q0.x - q1.x)).toBeLessThan(0.1 * Math.abs(q0.y - q1.y));
    expect(s.some((p) => Math.abs(p.x) < 1 && p.y > 39)).toBe(false);
    expect(s.every((p, i) => i === 0 || p.y >= s[i - 1].y - 1e-9)).toBe(true);
    // short pieces
    for (let i = 1; i < s.length; i++) expect(Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y)).toBeLessThan(12);
  });

  it("routes curved arrows like elbow arrows, with the bends rounded off, also when their shapes move", () => {
    const pts = connectorPath({ x: 160, y: 130 }, { x: 460, y: 330 }, a, b, true, 2, true);
    expect(pts[0]).toEqual({ x: 160, y: 163 });
    expect(pts[pts.length - 1]).toEqual({ x: 460, y: 297 });
    expect(pts.length).toBeGreaterThan(10);
    expect(pts.some((p, i) => i > 0 && p.x !== pts[i - 1].x && p.y !== pts[i - 1].y)).toBe(true);
    const c = makeConnector({ x: 160, y: 130 }, { x: 460, y: 330 }, a, b, { color: "#000000", width: 2, elbow: true, curve: true });
    const movedB = transformItems({ strokes: [b], texts: [], images: [], links: [], figures: [] }, translation(-200, 100)).strokes[0];
    const c1 = followMoves(pageWith([a, movedB, c]), new Set([b.id])).strokes[2];
    expect(c1.curve).toBe(true);
    const n = c1.pts.length / 3;
    expect(n).toBeGreaterThan(10);
    expect(c1.pts[(n - 1) * 3]).toBeCloseTo(260, 1);
    expect(c1.pts[(n - 1) * 3 + 1]).toBeCloseTo(397, 1);
  });

  it("follows its shapes and lets go when moved away on its own", () => {
    const c = makeConnector({ x: 160, y: 130 }, { x: 460, y: 330 }, a, b, { color: "#000000", width: 2, elbow: false });
    const p0 = pageWith([a, b, c]);
    const movedB = transformItems({ strokes: [b], texts: [], images: [], links: [], figures: [] }, translation(0, 200)).strokes[0];
    const p1 = followMoves({ ...p0, strokes: [a, movedB, c] }, new Set([b.id]));
    const c1 = p1.strokes[2];
    expect(c1.to).toBe(b.id);
    const n = c1.pts.length / 3;
    expect(c1.pts[(n - 1) * 3 + 1]).toBeGreaterThan(c.pts[(n - 1) * 3 + 1] + 150);
    // moved together with both shapes: nothing to do
    expect(followMoves(p0, new Set([a.id, b.id, c.id]))).toBe(p0);
    // the connector alone
    const p2 = followMoves(p0, new Set([c.id]));
    expect(p2.strokes[2].from).toBeUndefined();
    expect(p2.strokes[2].to).toBeUndefined();
  });

  it("selects and centres labels with their shapes", () => {
    const t: TextBox = { id: "lbl", ...labelBox(a, 20), h: 20, text: "Go", size: 16, color: "#000000", align: "center", container: a.id };
    expect(t.y + t.h / 2).toBeCloseTo(130, 5);
    expect(t.x + t.w / 2).toBeCloseTo(160, 5);
    const sel = withLabels(pageWith([a, b], [t]), { ...EMPTY_SELECTION, strokes: new Set([a.id]) });
    expect(sel.texts.has("lbl")).toBe(true);
  });
});

// ------------------------------------------------------------------ Excalidraw libraries

const el = (fields: Record<string, unknown>) => ({
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  roundness: null,
  isDeleted: false,
  ...fields,
});

const LIB_V2 = {
  type: "excalidrawlib",
  version: 2,
  source: "https://excalidraw.com",
  libraryItems: [
    {
      id: "item1",
      status: "published",
      name: "Process with label",
      created: 1,
      elements: [
        el({ id: "r1", type: "rectangle", x: 500, y: 300, width: 200, height: 100, backgroundColor: "#a5d8ff", fillStyle: "hachure", roundness: { type: 3 }, boundElements: [{ id: "t1", type: "text" }] }),
        el({ id: "t1", type: "text", x: 560, y: 337, width: 80, height: 25, text: "Process", originalText: "Process", fontSize: 20, textAlign: "center", verticalAlign: "middle", containerId: "r1" }),
        el({ id: "e1", type: "ellipse", x: 800, y: 300, width: 120, height: 80, backgroundColor: "#ffc9c9", strokeColor: "transparent" }),
        el({ id: "a1", type: "arrow", x: 700, y: 350, width: 100, height: 0, points: [[0, 0], [100, -10]], startBinding: { elementId: "r1", focus: 0, gap: 4 }, endBinding: { elementId: "e1", focus: 0, gap: 4 }, endArrowhead: "arrow", startArrowhead: null }),
        el({ id: "d1", type: "diamond", x: 500, y: 500, width: 100, height: 100, angle: Math.PI / 4, strokeStyle: "dashed", opacity: 50 }),
        el({ id: "img", type: "image", x: 0, y: 0, width: 10, height: 10, fileId: "abc" }),
        el({ id: "gone", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: true }),
      ],
    },
    {
      id: "item2",
      status: "unpublished",
      elements: [
        el({ id: "l1", type: "line", x: 0, y: 0, width: 100, height: 100, points: [[0, 0], [100, 0], [50, 100], [0, 0]], backgroundColor: "#ffec99", fillStyle: "cross-hatch" }),
        el({ id: "f1", type: "freedraw", x: 200, y: 0, width: 50, height: 20, points: [[0, 0], [10, 5], [20, 10], [50, 20]], pressures: [0.2, 0.5, 0.8, 0.4], simulatePressure: false }),
        el({ id: "c1", type: "line", x: 300, y: 0, width: 100, height: 50, points: [[0, 0], [50, 50], [100, 0]], roundness: { type: 2 } }),
      ],
    },
  ],
};

describe("Excalidraw libraries", () => {
  it("reads version 2, version 1, the Excalidraw plugin's library and drawings", () => {
    const v2 = parseExcalidrawLibrary(JSON.stringify(LIB_V2));
    expect(v2.map((i) => i.name)).toEqual(["Process with label", "Item 2"]);
    expect(v2[0].elements).toHaveLength(6);
    const v1 = parseExcalidrawLibrary({ type: "excalidrawlib", version: 1, library: [[el({ id: "x", type: "rectangle", x: 0, y: 0, width: 5, height: 5 })]] });
    expect(v1).toHaveLength(1);
    const plugin = parseExcalidrawLibrary({ library2: LIB_V2, someSetting: true });
    expect(plugin).toHaveLength(2);
    const pluginOld = parseExcalidrawLibrary({ library: JSON.stringify(LIB_V2) });
    expect(pluginOld).toHaveLength(2);
    const scene = parseExcalidrawLibrary({ type: "excalidraw", elements: LIB_V2.libraryItems[1].elements });
    expect(scene[0].name).toBe("Drawing");
    expect(() => parseExcalidrawLibrary("not json")).toThrow(LibraryError);
    expect(() => parseExcalidrawLibrary({ hello: 1 })).toThrow(LibraryError);
  });

  it("reads colours with transparency", () => {
    expect(parseColor("#1e1e1e")).toBe("#1e1e1e");
    expect(parseColor("#f00")).toBe("#ff0000");
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("#000000", 50)).toBe("#808080");
    expect(parseColor("#00000080")).toBe("#7f7f7f");
    expect(parseColor("red")).toBe("#ff0000");
    expect(parseColor("hsl(0, 0%, 0%)")).toBeNull();
  });

  it("turns library items into ink", () => {
    const [first, second] = libraryItems(parseExcalidrawLibrary(LIB_V2));
    const s = first.items.strokes;
    expect(s).toHaveLength(4);
    const [box, ellipse, arrow, diamond] = s;
    // a rounded rectangle, hatched
    expect(box.closed && box.poly).toBe(true);
    expect(box.pts.length / 3).toBeGreaterThan(20);
    expect(box.fill).toBe("#a5d8ff");
    expect(box.fillStyle).toBe("hatch");
    expect(box.width).toBe(2.5);
    // no line: only its fill
    expect(ellipse.area).toBe(true);
    expect(ellipse.fill).toBe("#ffc9c9");
    // attached to both
    expect(arrow.arrow).toBe(true);
    expect(arrow.arrowStart).toBeFalsy();
    expect(arrow.from).toBe(box.id);
    expect(arrow.to).toBeUndefined(); // an area is not a shape to attach to
    // rotated, dashed, half transparent
    expect(diamond.dash).toBe(true);
    expect(diamond.color).toBe("#8f8f8f");
    const d = strokePointBounds(diamond);
    // a diamond turned by 45° is a square standing on its side: its corners are 50 from the centre
    expect(d.w).toBeCloseTo(100 / Math.SQRT2, 0);
    // starts at the origin
    expect(itemsBounds(first.items)?.x).toBeCloseTo(0, 1);
    expect(itemsBounds(first.items)?.y).toBeCloseTo(0, 1);
    // the label is in its box, centred
    const label = first.items.texts[0];
    expect(label).toMatchObject({ text: "Process", align: "center", container: box.id, size: 20 });
    expect(label.x - strokePointBounds(box).x).toBeCloseTo(5, 1);
    expect(label.w).toBeCloseTo(190, 1);

    const [tri, pen, curve] = second.items.strokes;
    expect(tri.closed).toBe(true);
    expect(tri.pts.length / 3).toBe(3);
    expect(tri.fillStyle).toBe("cross");
    expect(pen.poly).toBeFalsy();
    expect(pen.pen).toBe("fountain");
    expect(pen.pts[2]).toBeCloseTo(0.2, 2);
    expect(curve.pts.length / 3).toBe(17);
  });

  it("draws curved lines through their points", () => {
    const c = curveThrough(
      [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 0 },
      ],
      4,
    );
    expect(c[0]).toEqual({ x: 0, y: 0 });
    expect(c[4]).toEqual({ x: 50, y: 50 });
    expect(c[8]).toEqual({ x: 100, y: 0 });
  });

  it("saves ink as a library Excalidraw can open, and reads it back", () => {
    const a = rect(0, 0, 160, 80, { fill: "#c4dfff" });
    const b = shapeFromDrag("diamond", { x: 300, y: 0 }, { x: 420, y: 100 }, style);
    const c = makeConnector({ x: 80, y: 40 }, { x: 360, y: 50 }, a, b, { color: "#000000", width: 2, elbow: false });
    const t: TextBox = { id: "lab", ...labelBox(a, 26), h: 26, text: "Do it", size: 20, color: "#000000", align: "center", container: a.id };
    const ellipse = shapeFromDrag("ellipse", { x: 0, y: 200 }, { x: 100, y: 260 }, { ...style, fill: "#ffffff", fillStyle: "hatch" });
    const t2: TextBox = { id: "lab2", x: 10, y: 215, w: 80, h: 26, text: "Oval", size: 20, color: "#000000", container: ellipse.id };
    const items: Items = { strokes: [a, b, c, ellipse], texts: [t, t2], images: [], links: [], figures: [] };
    const els = itemsToExcalidraw(items, { now: 1 });
    const byId = new Map(els.map((e) => [e.id as string, e] as const));
    expect(byId.get(a.id)?.type).toBe("rectangle");
    expect(byId.get(a.id)?.backgroundColor).toBe("#c4dfff");
    expect(byId.get(b.id)?.type).toBe("diamond");
    expect(byId.get(c.id)).toMatchObject({ type: "arrow", endArrowhead: "arrow", startBinding: { elementId: a.id }, endBinding: { elementId: b.id } });
    expect(byId.get(a.id)?.boundElements).toEqual([
      { id: c.id, type: "arrow" },
      { id: "lab", type: "text" },
    ]);
    expect(byId.get("lab")).toMatchObject({ containerId: a.id, textAlign: "center", verticalAlign: "middle" });
    // only rectangles, diamonds and ellipses hold text in Excalidraw: the oval's label is loose text
    expect(byId.get(ellipse.id)?.type).toBe("line");
    expect(byId.get(ellipse.id)?.fillStyle).toBe("hachure");
    expect(byId.get("lab2")?.containerId).toBeNull();
    const groups = new Set(els.map((e) => (e.groupIds as string[])[0]));
    expect(groups.size).toBe(1);

    const file = addToLibraryFile(null, { name: "Step", elements: els, id: "mine" });
    const back = libraryItems(parseExcalidrawLibrary(file))[0];
    expect(back.name).toBe("Step");
    const [a2, b2, c2, e2] = back.items.strokes;
    expect(a2.closed && a2.fill === "#c4dfff").toBe(true);
    expect(b2.pts.length / 3).toBe(4);
    expect(c2.from).toBe(a2.id);
    expect(c2.to).toBe(b2.id);
    expect(e2.closed && e2.fillStyle === "hatch").toBe(true);
    expect(back.items.texts.find((x) => x.text === "Do it")?.container).toBe(a2.id);

    // more items go to the end; removing one keeps the others
    const two = addToLibraryFile(file, { name: "Other", elements: els, id: "other" });
    expect(parseExcalidrawLibrary(two).map((i) => i.name)).toEqual(["Step", "Other"]);
    expect(parseExcalidrawLibrary(removeFromLibraryFile(two, "mine")).map((i) => i.name)).toEqual(["Other"]);
    expect(() => addToLibraryFile("{oops", { name: "x", elements: els })).toThrow(LibraryError);
  });

  it("finds the library behind a link", () => {
    expect(libraryUrlFrom("https://libraries.excalidraw.com/libraries/someone/flow.excalidrawlib")).toBe("https://libraries.excalidraw.com/libraries/someone/flow.excalidrawlib");
    expect(libraryUrlFrom("https://excalidraw.com/#addLibrary=https%3A%2F%2Flibraries.excalidraw.com%2Flibraries%2Fx%2Fy.excalidrawlib&token=abc")).toBe(
      "https://libraries.excalidraw.com/libraries/x/y.excalidrawlib",
    );
    expect(libraryUrlFrom("excalidraw.com")).toBeNull();
    expect(libraryUrlFrom("https://excalidraw.com/#addLibrary=javascript%3Aalert(1)")).toBeNull();
    expect(libraryNameFromUrl("https://libraries.excalidraw.com/libraries/someone/basic-flow_chart.excalidrawlib")).toBe("basic flow chart");
  });

  it("ignores images and frames (counted) and reports them", () => {
    const items = excalidrawToItems(LIB_V2.libraryItems[0].elements.filter((e) => !e.isDeleted));
    expect(items.skipped).toBe(1);
  });
});

describe("ink pages of earlier versions (Excalidraw)", () => {
  it("keep the fills of their shapes", () => {
    const { doc } = excalidrawToInk(
      [
        { id: "a", type: "rectangle", x: 10, y: 10, width: 100, height: 50, strokeColor: "#000000", backgroundColor: "#ffec99", fillStyle: "solid" },
        { id: "b", type: "ellipse", x: 200, y: 10, width: 100, height: 50, strokeColor: "#000000", backgroundColor: "#a5d8ff", fillStyle: "hachure" },
        { id: "c", type: "diamond", x: 400, y: 10, width: 100, height: 50, strokeColor: "#000000", backgroundColor: "transparent" },
      ],
      new Map(),
    );
    const [a, b, c] = doc.pages[0].strokes;
    expect(a.fill).toBe("#ffec99");
    expect(a.fillStyle).toBeUndefined();
    expect(b.fill).toBe("#a5d8ff");
    expect(b.fillStyle).toBe("hatch");
    expect(c.fill).toBeUndefined();
  });
});

describe("flowchart library", () => {
  it("has the usual shapes, each one a shape arrows attach to", () => {
    const lib = flowchartLibrary();
    expect(lib.map((i) => i.name)).toContain("Decision");
    expect(new Set(lib.map((i) => i.id)).size).toBe(lib.length);
    for (const it of lib) {
      expect(it.restyle).toBe(true);
      const connectable = it.items.strokes.filter(isConnectable);
      if (it.name === "Comment") expect(connectable).toHaveLength(0);
      else expect(connectable).toHaveLength(1);
    }
  });
});

describe("settings", () => {
  it("remember the fill tool and the fills, but not placing a library item", () => {
    const fill = loadSettings({ tools: { tool: "fill", fillColor: "#FFF3BF", shapeFill: "", fillStyle: "cross" }, libraryFolder: "/Libs/" });
    expect(fill.tools).toMatchObject({ tool: "fill", fillColor: "#fff3bf", shapeFill: "", fillStyle: "cross" });
    expect(fill.libraryFolder).toBe("Libs");
    const odd = loadSettings({ tools: { tool: "stamp", fillColor: "blue", fillStyle: "dots" } });
    expect(odd.tools).toMatchObject({ tool: "pen", fillColor: "#c4dfff", shapeFill: "", fillStyle: "solid" });
    expect(odd.libraryFolder).toBe("Ink libraries");
  });
});
