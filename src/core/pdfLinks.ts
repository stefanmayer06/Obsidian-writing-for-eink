import { containsPoint, type Pt, type Rect } from "./geometry";

/**
 * Links inside a PDF page (its Link annotations), so a tap on a PDF page in the
 * ink view can follow them. PDF pages are drawn as pictures; the link areas are
 * kept separately, as fractions of the page (0–1), which fit an ink page of any
 * size the PDF page was imported at.
 */

export interface PdfLink {
  /** The link area as fractions of the page's width and height. */
  readonly rect: Rect;
  /** A web or mail address. */
  readonly url?: string;
  /** A page of the same PDF (1-based). */
  readonly page?: number;
}

/** Only addresses that are safe to hand to the system (no javascript:, file: …). */
export function safePdfUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

/**
 * A link area from PDF.js viewport coordinates ([x1, y1, x2, y2] at any corner order,
 * from `viewport.convertToViewportRectangle`) as fractions of the viewport's size.
 * Null for an empty or broken area.
 */
export function pdfLinkRect(r: ArrayLike<number>, viewW: number, viewH: number): Rect | null {
  if (r.length < 4 || !(viewW > 0) || !(viewH > 0)) return null;
  const [a, b, c, d] = [r[0], r[1], r[2], r[3]];
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const x1 = Math.max(0, Math.min(a, c) / viewW);
  const y1 = Math.max(0, Math.min(b, d) / viewH);
  const x2 = Math.min(1, Math.max(a, c) / viewW);
  const y2 = Math.min(1, Math.max(b, d) / viewH);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * The link under a point of an ink page `w` × `h` (page units) showing the PDF page.
 * `slack` (page units) makes small links easier to hit; when areas overlap, the
 * smallest one wins (it is the more specific link).
 */
export function pdfLinkAt(links: readonly PdfLink[], w: number, h: number, p: Pt, slack = 0): PdfLink | null {
  let best: PdfLink | null = null;
  let bestArea = Infinity;
  for (const l of links) {
    const r = { x: l.rect.x * w - slack, y: l.rect.y * h - slack, w: l.rect.w * w + 2 * slack, h: l.rect.h * h + 2 * slack };
    if (!containsPoint(r, p)) continue;
    const area = r.w * r.h;
    if (area < bestArea) {
      best = l;
      bestArea = area;
    }
  }
  return best;
}

/** The index of the ink page that shows page `n` of the PDF at `path`, or -1. */
export function inkPageForPdfPage(pages: ReadonlyArray<{ readonly bg: { readonly kind: string; readonly path?: string; readonly page?: number } }>, path: string, n: number): number {
  return pages.findIndex((p) => p.bg.kind === "pdf" && p.bg.path === path && p.bg.page === n);
}
