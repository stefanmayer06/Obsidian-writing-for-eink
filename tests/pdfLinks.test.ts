import { describe, expect, it } from "vitest";
import { inkPageForPdfPage, pdfLinkAt, pdfLinkRect, safePdfUrl, type PdfLink } from "../src/core/pdfLinks";

describe("safePdfUrl", () => {
  it("keeps web and mail addresses", () => {
    expect(safePdfUrl("https://arxiv.org/abs/1706.03762")).toBe("https://arxiv.org/abs/1706.03762");
    expect(safePdfUrl(" http://example.com ")).toBe("http://example.com");
    expect(safePdfUrl("MAILTO:someone@example.com")).toBe("MAILTO:someone@example.com");
  });

  it("drops anything else", () => {
    expect(safePdfUrl("javascript:alert(1)")).toBeNull();
    expect(safePdfUrl("file:///etc/passwd")).toBeNull();
    expect(safePdfUrl("www.example.com")).toBeNull();
    expect(safePdfUrl(undefined)).toBeNull();
    expect(safePdfUrl(42)).toBeNull();
  });
});

describe("pdfLinkRect", () => {
  it("turns viewport corners in any order into fractions of the page", () => {
    // PDF.js gives [x1, y1, x2, y2] with y flipped, so y1 can be the larger one
    const r = pdfLinkRect([60, 400, 300, 380], 600, 800);
    expect(r?.x).toBeCloseTo(0.1);
    expect(r?.y).toBeCloseTo(0.475);
    expect(r?.w).toBeCloseTo(0.4);
    expect(r?.h).toBeCloseTo(0.025);
  });

  it("clips to the page and rejects empty or broken areas", () => {
    expect(pdfLinkRect([-60, 0, 300, 80], 600, 800)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.1 });
    expect(pdfLinkRect([10, 10, 10, 50], 600, 800)).toBeNull();
    expect(pdfLinkRect([10, Number.NaN, 20, 50], 600, 800)).toBeNull();
    expect(pdfLinkRect([10, 10, 20], 600, 800)).toBeNull();
    expect(pdfLinkRect([10, 10, 20, 20], 0, 800)).toBeNull();
  });
});

describe("pdfLinkAt", () => {
  const big: PdfLink = { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, url: "https://a.example" };
  const small: PdfLink = { rect: { x: 0.2, y: 0.15, w: 0.1, h: 0.05 }, page: 3 };

  it("scales the areas to the ink page", () => {
    // ink page 1000 × 2000: big covers x 100–600, y 200–600
    expect(pdfLinkAt([big], 1000, 2000, { x: 150, y: 250 })).toBe(big);
    expect(pdfLinkAt([big], 1000, 2000, { x: 650, y: 250 })).toBeNull();
  });

  it("picks the smallest of overlapping links", () => {
    expect(pdfLinkAt([big, small], 1000, 2000, { x: 250, y: 320 })).toBe(small);
  });

  it("makes links a little easier to hit with slack", () => {
    expect(pdfLinkAt([big], 1000, 2000, { x: 603, y: 250 })).toBeNull();
    expect(pdfLinkAt([big], 1000, 2000, { x: 603, y: 250 }, 4)).toBe(big);
  });
});

describe("inkPageForPdfPage", () => {
  const pages = [
    { bg: { kind: "paper" } },
    { bg: { kind: "pdf", path: "a.pdf", page: 1 } },
    { bg: { kind: "pdf", path: "b.pdf", page: 3 } },
    { bg: { kind: "pdf", path: "a.pdf", page: 3 } },
  ];

  it("finds the ink page showing that page of that PDF", () => {
    expect(inkPageForPdfPage(pages, "a.pdf", 3)).toBe(3);
    expect(inkPageForPdfPage(pages, "a.pdf", 1)).toBe(1);
  });

  it("returns -1 when that page was not imported", () => {
    expect(inkPageForPdfPage(pages, "a.pdf", 2)).toBe(-1);
  });
});
