import { describe, expect, it } from "vitest";
import { addColor, colorName, DEFAULT_PEN_PALETTE, loadPalette, MAX_PALETTE, normalizeColor, removeColor } from "../src/core/palette";
import { PENS, spreadPresets } from "../src/core/ink/pens";
import { loadSettings } from "../src/settings";

describe("pen colours", () => {
  it("reads colour codes as lower-case #rrggbb", () => {
    expect(normalizeColor("#3A7BD5")).toBe("#3a7bd5");
    expect(normalizeColor(" #abc ")).toBe("#aabbcc");
    expect(normalizeColor("red")).toBeNull();
    expect(normalizeColor("#12345")).toBeNull();
    expect(normalizeColor(42)).toBeNull();
  });

  it("adds a picked colour at the end, once", () => {
    const p = addColor(["#000000", "#d32f2f"], "#3A7BD5");
    expect(p).toEqual(["#000000", "#d32f2f", "#3a7bd5"]);
    expect(addColor(p, "#3a7bd5")).toEqual(p);
    expect(addColor(p, "not a colour")).toEqual(p);
  });

  it("stops adding when the palette is full", () => {
    const full = Array.from({ length: MAX_PALETTE }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    expect(addColor(full, "#ffffff")).toHaveLength(MAX_PALETTE);
  });

  it("removes a colour, but never the last one", () => {
    expect(removeColor(["#000000", "#d32f2f"], "#D32F2F")).toEqual(["#000000"]);
    expect(removeColor(["#000000"], "#000000")).toEqual(["#000000"]);
    expect(removeColor(["#000000"], "#123456")).toEqual(["#000000"]);
  });

  it("loads stored colours, falling back to the original ones", () => {
    expect(loadPalette(undefined)).toEqual([...DEFAULT_PEN_PALETTE]);
    expect(loadPalette([])).toEqual([...DEFAULT_PEN_PALETTE]);
    expect(loadPalette(["#FFF", "#ffffff", "blue", 3, "#00897b"])).toEqual(["#ffffff", "#00897b"]);
    expect(loadSettings({}).penColors).toEqual([...DEFAULT_PEN_PALETTE]);
    expect(loadSettings({ penColors: ["#3a7bd5"] }).penColors).toEqual(["#3a7bd5"]);
  });

  it("names the built-in colours and shows the code of others", () => {
    expect(colorName("#00897B")).toBe("Teal");
    expect(colorName("#3a7bd5")).toBe("#3a7bd5");
  });
});

describe("thicknesses in the pen bar", () => {
  const p = PENS.fountain.presets;

  it("spreads the chosen number from thin to thick", () => {
    expect(spreadPresets(p, 5)).toEqual([...p]);
    expect(spreadPresets(p, 3)).toEqual([p[0], p[2], p[4]]);
    expect(spreadPresets(p, 2)).toEqual([p[0], p[4]]);
    expect(spreadPresets(p, 1)).toEqual([p[2]]);
    expect(spreadPresets(p, 4)).toHaveLength(4);
    expect(spreadPresets(p, 4)[0]).toBe(p[0]);
    expect(spreadPresets(p, 4)[3]).toBe(p[4]);
  });

  it("keeps the count between 1 and 5", () => {
    expect(spreadPresets(p, 0)).toEqual([p[2]]);
    expect(spreadPresets(p, 9)).toEqual([...p]);
    expect(loadSettings({}).penBarSizes).toBe(5);
    expect(loadSettings({ penBarSizes: 3 }).penBarSizes).toBe(3);
    expect(loadSettings({ penBarSizes: 0 }).penBarSizes).toBe(1);
    expect(loadSettings({ penBarSizes: 12 }).penBarSizes).toBe(5);
  });
});
