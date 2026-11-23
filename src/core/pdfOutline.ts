/**
 * A PDF's outline (its table of contents, "bookmarks"), flattened into a list
 * for the Outlines card of the ink view: each entry has its depth, and the PDF
 * page it points to (or a web address).
 */

export interface PdfOutlineNode {
  readonly title: string;
  /** The PDF page the entry points to (1-based). */
  readonly page?: number;
  readonly url?: string;
  readonly items: readonly PdfOutlineNode[];
}

export interface PdfOutlineEntry {
  readonly title: string;
  readonly depth: number;
  readonly page?: number;
  readonly url?: string;
}

/** Outlines can be huge (a book's every subsection): the card lists at most this many. */
export const MAX_OUTLINE_ENTRIES = 1500;

/** An entry's title on one line, without the control characters some PDFs carry. */
export function outlineTitle(title: unknown): string {
  const t = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f​﻿]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return t || "Untitled";
}

/** The outline as a list, depth first, at most `max` entries. */
export function flattenOutline(nodes: readonly PdfOutlineNode[], max = MAX_OUTLINE_ENTRIES): PdfOutlineEntry[] {
  const out: PdfOutlineEntry[] = [];
  const walk = (list: readonly PdfOutlineNode[], depth: number): void => {
    for (const n of list) {
      if (out.length >= max) return;
      out.push({ title: outlineTitle(n.title), depth, ...(n.page !== undefined ? { page: n.page } : {}), ...(n.url ? { url: n.url } : {}) });
      walk(n.items, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/**
 * The entry of the section that PDF page `page` is in: the last entry, in
 * reading order, that starts on or before it. -1 before the first one.
 */
export function currentOutlineEntry(entries: readonly PdfOutlineEntry[], page: number): number {
  let best = -1;
  let bestPage = -Infinity;
  entries.forEach((e, i) => {
    if (e.page === undefined || e.page > page) return;
    // later entries on the same page win: they are the more specific section
    if (e.page >= bestPage) {
      best = i;
      bestPage = e.page;
    }
  });
  return best;
}
