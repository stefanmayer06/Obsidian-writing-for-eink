import { describe, expect, it } from "vitest";
import { PANEL_MARGIN, panelFraction, panelPixels } from "../src/core/panelPosition";
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
  it("starts centred under the toolbar", () => {
    expect(panelPixels(null, 400, 60, 1000, 800, 56)).toEqual({ left: 300, top: 56 });
  });

  it("is stored as fractions of the view and comes back in the same place", () => {
    const pos = panelFraction(250, 400, 400, 60, 1000, 800);
    expect(pos).toEqual({ x: 0.25, y: 0.5 });
    expect(panelPixels(pos, 400, 60, 1000, 800, 56)).toEqual({ left: 250, top: 400 });
  });

  it("stays inside the view, also after it got smaller", () => {
    expect(panelFraction(-50, 900, 400, 60, 1000, 800)).toEqual({ x: PANEL_MARGIN / 1000, y: (800 - 60 - PANEL_MARGIN) / 800 });
    // moved to the right edge on a wide screen, then the tablet turned
    const p = panelPixels({ x: 0.6, y: 0.1 }, 400, 60, 600, 900, 56);
    expect(p.left).toBe(600 - 400 - PANEL_MARGIN);
  });

  it("keeps its start in sight when it is wider than the view", () => {
    expect(panelPixels({ x: 0.5, y: 0.5 }, 700, 60, 500, 800, 56).left).toBe(PANEL_MARGIN);
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
