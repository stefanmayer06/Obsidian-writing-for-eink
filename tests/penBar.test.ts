import { describe, expect, it } from "vitest";
import { dockFor, dragDock, isVerticalDock, PANEL_MARGIN, panelFraction, panelPixels, type DragDock } from "../src/core/panelPosition";
import { dashPattern, dotPattern, linePattern, lineStyleFields, patternWidth, shownPens, strokeRuns, WRITING_PEN_TYPES } from "../src/core/ink/pens";
import { addItems, EMPTY_META, makeStroke, newDoc, q, qp, type Stroke } from "../src/core/ink/model";
import { parseInkFile, serializeInkFile } from "../src/core/ink/codec";
import { eraseFromStroke } from "../src/core/ink/erase";
import { loadSettings } from "../src/settings";

/** A pen stroke along a line with the pressure rising, so its width changes. */
function pressured(extra: Partial<Stroke> = {}): Stroke {
  const n = 40;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = q(10 + i * 6);
    pts[i * 3 + 1] = q(50 + Math.sin(i / 4) * 10);
    pts[i * 3 + 2] = qp(0.1 + (0.9 * i) / n);
  }
  return makeStroke({ pen: "fountain", color: "#1565c0", width: 2.6, pts, ...extra });
}

describe("pen bar position", () => {
  // the view is 1000 × 800; the page area under a 50 px toolbar
  const area = { x: 0, y: 50, w: 1000, h: 750 };

  it("starts centred at the top of the page area (under the toolbar)", () => {
    expect(panelPixels(null, 400, 60, 1000, 800, area)).toEqual({ left: 300, top: 50 + PANEL_MARGIN });
  });

  it("is stored as fractions of the view and comes back in the same place", () => {
    const pos = panelFraction(250, 400, 400, 60, 1000, 800, area);
    expect(pos).toEqual({ x: 0.25, y: 0.5 });
    expect(panelPixels(pos, 400, 60, 1000, 800, area)).toEqual({ left: 250, top: 400 });
  });

  it("stays inside the page area, also after the view got smaller", () => {
    // never over the toolbar
    expect(panelFraction(-50, 0, 400, 60, 1000, 800, area)).toEqual({ x: PANEL_MARGIN / 1000, y: (50 + PANEL_MARGIN) / 800 });
    // moved to the right edge on a wide screen, then the tablet turned
    const p = panelPixels({ x: 0.6, y: 0.1 }, 400, 60, 600, 900, { x: 0, y: 50, w: 600, h: 850 });
    expect(p.left).toBe(600 - 400 - PANEL_MARGIN);
  });

  it("keeps its start in sight when it is wider than the page area", () => {
    expect(panelPixels({ x: 0.5, y: 0.5 }, 700, 60, 500, 800, { x: 0, y: 0, w: 500, h: 800 }).left).toBe(PANEL_MARGIN);
  });
});

describe("docking the bar at an edge", () => {
  const area = { x: 60, y: 0, w: 940, h: 800 }; // a toolbar on the left, 60 px wide

  it("docks at the edge the pointer is near", () => {
    expect(dockFor(80, 400, area)).toBe("left");
    expect(dockFor(990, 400, area)).toBe("right");
    expect(dockFor(500, 20, area)).toBe("top");
    expect(dockFor(500, 790, area)).toBe("bottom");
    expect(dockFor(500, 400, area)).toBeNull();
  });

  it("picks the nearer edge in a corner", () => {
    expect(dockFor(70, 30, area)).toBe("left");
    expect(dockFor(100, 5, area)).toBe("top");
  });

  it("in a corner, docks at the edge the drag is heading for", () => {
    // the bar starts at the top of the page; dragged left along the top it ends near both edges
    expect(dockFor(90, 20, area)).toBe("top");
    expect(dockFor(90, 20, area, undefined, { dx: -400, dy: 5 })).toBe("left");
    // dragged up into the same corner: the top
    expect(dockFor(90, 20, area, undefined, { dx: -3, dy: -300 })).toBe("top");
    // to the right along the bottom
    expect(dockFor(990, 790, area, undefined, { dx: 500, dy: 0 })).toBe("right");
    expect(dockFor(990, 790, area, undefined, { dx: 0, dy: 400 })).toBe("bottom");
    // near one edge only, the direction does not matter
    expect(dockFor(80, 400, area, undefined, { dx: 0, dy: -200 })).toBe("left");
  });

  it("lies flat against its edge, keeping its place along it", () => {
    // upright on the left: 56 wide, 500 tall
    const left = panelPixels({ x: 0.5, y: 0.2, dock: "left" }, 56, 500, 1000, 800, area);
    expect(left).toEqual({ left: 60 + PANEL_MARGIN, top: 160 });
    const right = panelPixels({ x: 0.1, y: 0.2, dock: "right" }, 56, 500, 1000, 800, area);
    expect(right.left).toBe(1000 - 56 - PANEL_MARGIN);
    const bottom = panelPixels({ x: 0.3, y: 0.1, dock: "bottom" }, 600, 56, 1000, 800, area);
    expect(bottom).toEqual({ left: 300, top: 800 - 56 - PANEL_MARGIN });
    const top = panelPixels({ x: 0.3, y: 0.9, dock: "top" }, 600, 56, 1000, 800, area);
    expect(top.top).toBe(PANEL_MARGIN);
  });

  it("stands upright on the left and right only", () => {
    expect(isVerticalDock("left")).toBe(true);
    expect(isVerticalDock("right")).toBe(true);
    expect(isVerticalDock("top")).toBe(false);
    expect(isVerticalDock(null)).toBe(false);
  });

  it("remembers the edge", () => {
    expect(panelFraction(68, 160, 56, 500, 1000, 800, area, "left")).toEqual({ x: 0.068, y: 0.2, dock: "left" });
    expect(loadSettings({ penBarPos: { x: 0.1, y: 0.2, dock: "left" } }).penBarPos).toEqual({ x: 0.1, y: 0.2, dock: "left" });
    expect(loadSettings({ penBarPos: { x: 0.1, y: 0.2, dock: "sideways" } }).penBarPos).toEqual({ x: 0.1, y: 0.2 });
  });
});

describe("dashed and dotted lines", () => {
  it("has a pattern for each style", () => {
    expect(linePattern({ width: 2 })).toEqual([]);
    expect(linePattern({ width: 2, dash: true })).toEqual(dashPattern(2));
    expect(linePattern({ width: 2, dot: true })).toEqual(dotPattern(2));
    // dotted wins (an Excalidraw "dotted" line is never both)
    expect(linePattern({ width: 2, dash: true, dot: true })).toEqual(dotPattern(2));
    expect(dotPattern(3)[0]).toBeLessThan(0.1);
  });

  it("maps line styles to stroke fields", () => {
    expect(lineStyleFields("solid")).toEqual({});
    expect(lineStyleFields("dashed")).toEqual({ dash: true });
    expect(lineStyleFields("dotted")).toEqual({ dot: true });
  });

  it("draws a dashed or dotted pen line at one width, so the pattern runs evenly", () => {
    const solid = strokeRuns(pressured());
    expect(new Set(solid.map((r) => r.w)).size).toBeGreaterThan(1);
    const dashed = strokeRuns(pressured({ dash: true }));
    expect(dashed).toHaveLength(1);
    expect(dashed[0].w).toBe(patternWidth(2.6));
    // dots are a little wider than the pen's line, so a thin pen's dots still show
    const dotted = strokeRuns(pressured({ dot: true }));
    expect(dotted).toHaveLength(1);
    expect(dotted[0].w).toBe(patternWidth(2.6, true));
    expect(dotted[0].w).toBeGreaterThan(dashed[0].w);
  });

  it("keeps a dashed or dotted pencil line patterned all along (its shade follows the pressure)", () => {
    for (const extra of [{ dash: true }, { dot: true }]) {
      const runs = strokeRuns(pressured({ pen: "pencil", ...extra }));
      // one path: a pattern starts again with every piece, and short pieces came out solid
      expect(runs).toHaveLength(1);
      expect(runs[0].color).toBe("#1565c0");
    }
    // a solid pencil line still shades with the pressure
    expect(new Set(strokeRuns(pressured({ pen: "pencil" })).map((r) => r.color)).size).toBeGreaterThan(1);
  });

  it("keeps the dotted style through saving and loading", () => {
    const dotted = pressured({ dot: true });
    const dashed = pressured({ dash: true });
    const doc = newDoc();
    const page = addItems(doc.pages[0], { strokes: [dotted, dashed] });
    const text = serializeInkFile("", { doc: { pages: [page] }, meta: EMPTY_META });
    const back = parseInkFile(text).doc.pages[0].strokes;
    expect(back.map((s) => [!!s.dot, !!s.dash])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("keeps the style on the pieces the eraser leaves", () => {
    const s = pressured({ dot: true });
    // the eraser moved straight down across the middle of the line
    const pieces = eraseFromStroke(s, { x: 130, y: 0 }, { x: 130, y: 100 }, 8);
    expect(pieces?.length).toBeGreaterThan(1);
    for (const p of pieces ?? []) expect(p.dot).toBe(true);
  });
});

describe("pen bar settings", () => {
  it("is off by default and remembers where it was moved to", () => {
    const d = loadSettings({});
    expect(d.penBar).toBe(false);
    expect(d.penBarPos).toBeNull();
    expect(loadSettings({ penBar: true, penBarPos: { x: 0.2, y: 0.7 } }).penBarPos).toEqual({ x: 0.2, y: 0.7 });
    expect(loadSettings({ penBarPos: { x: 3, y: -1 } }).penBarPos).toEqual({ x: 1, y: 0 });
    expect(loadSettings({ penBarPos: { x: "a", y: 1 } }).penBarPos).toBeNull();
  });

  it("remembers the line style", () => {
    expect(loadSettings({}).tools.lineStyle).toBe("solid");
    expect(loadSettings({ tools: { lineStyle: "dotted" } }).tools.lineStyle).toBe("dotted");
    expect(loadSettings({ tools: { lineStyle: "wavy" } }).tools.lineStyle).toBe("solid");
  });
});

describe("hidden pens", () => {
  it("offers every pen but the hidden ones, in their usual order", () => {
    expect(shownPens([])).toEqual(["fountain", "ballpoint", "pencil", "brush", "calligraphy"]);
    expect(shownPens(["brush", "calligraphy"])).toEqual(["fountain", "ballpoint", "pencil"]);
  });

  it("never offers no pen at all", () => {
    expect(shownPens([...WRITING_PEN_TYPES])).toEqual([...WRITING_PEN_TYPES]);
  });

  it("keeps only known pens, each once, and never all of them", () => {
    expect(loadSettings({}).hiddenPens).toEqual([]);
    expect(loadSettings({ hiddenPens: ["calligraphy", "brush", "brush", "marker", "crayon", 3] }).hiddenPens).toEqual(["brush", "calligraphy"]);
    expect(loadSettings({ hiddenPens: [...WRITING_PEN_TYPES] }).hiddenPens).toEqual([]);
    expect(loadSettings({ hiddenPens: "brush" }).hiddenPens).toEqual([]);
  });
});

describe("docking while dragging", () => {
  // toolbar on the right: the page area is x 0–1207, y 0–800
  const area = { x: 0, y: 0, w: 1207, h: 800 };
  const W = 918; // a long lying bar, its handle at its left end
  const H = 56;

  /** Drag the handle along a path of pointer positions; the bar follows, kept inside. */
  function drag(start: DragDock, path: Array<[number, number]>, grip = { dx: 13, dy: 28 }): DragDock[] {
    let s = start;
    const out: DragDock[] = [];
    for (const [px, py] of path) {
      const vertical = isVerticalDock(s.dock);
      const want = vertical ? { x: px - 28, y: py - 13, w: 56, h: 780 } : { x: px - grip.dx, y: py - grip.dy, w: W, h: H };
      s = dragDock(s, px, py, want, vertical, area);
      out.push(s);
    }
    return out;
  }
  const line = (x0: number, y0: number, x1: number, y1: number, n = 20): Array<[number, number]> =>
    Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * (i + 1)) / n, y0 + ((y1 - y0) * (i + 1)) / n]);

  it("docks on the right when a long bar is pushed against it (the pointer stays far from that edge)", () => {
    // the bar starts at the top, centred: its handle at x 157; pushed right, it stops at the edge when
    // the handle is at 1207 - 8 - 918 + 13 = 294; the pointer goes a little further and stops
    const steps = drag({ dock: null, ax: 157, ay: 36 }, line(157, 36, 340, 40));
    expect(steps.at(-1)?.dock).toBe("right");
  });

  it("docks on the left when dragged left along the top", () => {
    const steps = drag({ dock: null, ax: 600, ay: 36 }, line(600, 36, 20, 30));
    expect(steps.at(-1)?.dock).toBe("left");
  });

  it("docks at the top when dragged up to it, and at the bottom when dragged down", () => {
    expect(drag({ dock: null, ax: 300, ay: 400 }, line(300, 400, 300, 20)).at(-1)?.dock).toBe("top");
    expect(drag({ dock: null, ax: 300, ay: 400 }, line(300, 400, 300, 785)).at(-1)?.dock).toBe("bottom");
  });

  it("stays docked while the pointer wanders a little, and does not flicker between edges", () => {
    const docked: DragDock = { dock: "right", ax: 340, ay: 40 };
    // upright on the right it spans the page's height: moving up and down must not dock it at the top or bottom
    const steps = drag(docked, [...line(340, 40, 330, 300, 10), ...line(330, 300, 345, 120, 10)]);
    expect(steps.every((s) => s.dock === "right")).toBe(true);
  });

  it("undocks when pulled away, and does not dock again while moving away", () => {
    const steps = drag({ dock: "right", ax: 340, ay: 300 }, line(340, 300, 200, 320, 14));
    expect(steps.at(-1)?.dock).toBeNull();
    const after = drag(steps.at(-1) as DragDock, line(200, 320, 150, 330, 5));
    expect(after.every((s) => s.dock === null)).toBe(true);
  });

  it("moves from one edge to another when the drag heads there", () => {
    const steps = drag({ dock: "top", ax: 600, ay: 30 }, line(600, 30, 20, 30));
    expect(steps.at(-1)?.dock).toBe("left");
  });
});
