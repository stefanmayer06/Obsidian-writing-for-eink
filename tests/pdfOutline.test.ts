import { describe, expect, it } from "vitest";
import { currentOutlineEntry, flattenOutline, outlineTitle, type PdfOutlineNode } from "../src/core/pdfOutline";

const node = (title: string, page?: number, items: PdfOutlineNode[] = []): PdfOutlineNode => ({ title, page, items });

describe("outlineTitle", () => {
  it("puts the title on one line and drops control characters", () => {
    expect(outlineTitle("  1\u0009Introduction\r\n and  motivation\u0000 ")).toBe("1 Introduction and motivation");
    expect(outlineTitle("﻿Abstract")).toBe("Abstract");
  });

  it("names entries without a title", () => {
    expect(outlineTitle("")).toBe("Untitled");
    expect(outlineTitle("  \u0000 ")).toBe("Untitled");
    expect(outlineTitle(undefined)).toBe("Untitled");
  });
});

describe("flattenOutline", () => {
  const outline = [
    node("1 Introduction", 1),
    node("2 Method", 3, [node("2.1 Data", 3), node("2.2 Model", 4, [node("Attention", 5)])]),
    { title: "Project page", url: "https://example.com", items: [] },
    node("References", 9),
  ];

  it("lists entries depth first with their depth", () => {
    expect(flattenOutline(outline)).toEqual([
      { title: "1 Introduction", depth: 0, page: 1 },
      { title: "2 Method", depth: 0, page: 3 },
      { title: "2.1 Data", depth: 1, page: 3 },
      { title: "2.2 Model", depth: 1, page: 4 },
      { title: "Attention", depth: 2, page: 5 },
      { title: "Project page", depth: 0, url: "https://example.com" },
      { title: "References", depth: 0, page: 9 },
    ]);
  });

  it("stops at the limit", () => {
    expect(flattenOutline(outline, 3).map((e) => e.title)).toEqual(["1 Introduction", "2 Method", "2.1 Data"]);
  });

  it("is empty for a PDF without an outline", () => {
    expect(flattenOutline([])).toEqual([]);
  });
});

describe("currentOutlineEntry", () => {
  const entries = flattenOutline([
    node("Cover", undefined),
    node("1 Introduction", 2),
    node("2 Method", 3, [node("2.1 Data", 3), node("2.2 Model", 4)]),
    node("References", 9),
  ]);

  it("is the section the page is in", () => {
    expect(entries[currentOutlineEntry(entries, 2)].title).toBe("1 Introduction");
    expect(entries[currentOutlineEntry(entries, 6)].title).toBe("2.2 Model");
    expect(entries[currentOutlineEntry(entries, 12)].title).toBe("References");
  });

  it("prefers the more specific entry when several start on the page", () => {
    expect(entries[currentOutlineEntry(entries, 3)].title).toBe("2.1 Data");
  });

  it("is -1 before the first section", () => {
    expect(currentOutlineEntry(entries, 1)).toBe(-1);
  });
});
