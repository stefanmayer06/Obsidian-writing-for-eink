import { loadPdfJs, TFile, type App } from "obsidian";
import { pdfLinkRect, safePdfUrl, type PdfLink } from "../core/pdfLinks";
import { flattenOutline, MAX_OUTLINE_ENTRIES, type PdfOutlineEntry, type PdfOutlineNode } from "../core/pdfOutline";
import type { ImageSource } from "../ink/render";

/**
 * Pictures for the ink pages, from the vault: inserted images, annotated
 * images and PDF pages (rendered with Obsidian's PDF.js at the resolution the
 * page is shown at). Loading is asynchronous; listeners are told when
 * something arrived so the pages can be redrawn.
 */

interface PdfEntry {
  doc: Promise<PdfDoc>;
  used: number;
}

/** The part of PDF.js (as loaded by Obsidian's loadPdfJs) that is used here. */
interface PdfViewport {
  width: number;
  height: number;
  convertToViewportRectangle(rect: number[]): number[];
}

/** A PDF.js annotation; only Link annotations (with `url` or `dest`) are used. */
interface PdfAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: string | unknown[] | null;
}

interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
  getAnnotations?(params?: { intent?: string }): Promise<PdfAnnotation[]>;
  cleanup?(): void;
}

interface PdfDoc {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getDestination?(name: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
  getOutline?(): Promise<PdfJsOutlineItem[] | null>;
}

interface PdfJsOutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items?: PdfJsOutlineItem[];
}

interface PdfJs {
  getDocument(params: { data: Uint8Array }): { promise: Promise<PdfDoc> };
}

interface RenderedPage {
  canvas: HTMLCanvasElement;
  width: number;
  used: number;
}

const MAX_PDF_PAGES = 14;
const MAX_PDF_WIDTH = 3200;

export class VaultImages implements ImageSource {
  private images = new Map<string, HTMLImageElement | "loading" | "error">();
  private pdfs = new Map<string, PdfEntry>();
  private pages = new Map<string, RenderedPage>();
  /** Links per PDF page ("path#page"); "loading" while PDF.js reads them. */
  private links = new Map<string, readonly PdfLink[] | "loading">();
  /** Outlines per PDF path. */
  private outlines = new Map<string, Promise<PdfOutlineEntry[]>>();
  private rendering = new Set<string>();
  private queue: Array<() => Promise<void>> = [];
  private busy = false;
  private listeners = new Set<() => void>();

  constructor(private app: App) {}

  /** Call `fn` whenever a picture finished loading. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private ready(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Forget a file (it changed or was deleted). */
  invalidate(path: string): void {
    this.images.delete(path);
    this.outlines.delete(path);
    if (this.pdfs.delete(path)) {
      for (const key of [...this.pages.keys()]) if (key.startsWith(`${path}#`)) this.pages.delete(key);
      for (const key of [...this.links.keys()]) if (key.startsWith(`${path}#`)) this.links.delete(key);
    }
  }

  clear(): void {
    this.images.clear();
    this.pdfs.clear();
    this.pages.clear();
    this.links.clear();
    this.outlines.clear();
  }

  /** The PDF's outline (table of contents) as a list; empty when it has none. */
  pdfOutline(path: string): Promise<PdfOutlineEntry[]> {
    let hit = this.outlines.get(path);
    if (!hit) {
      hit = this.loadOutline(path);
      this.outlines.set(path, hit);
      hit.catch(() => this.outlines.delete(path));
    }
    return hit;
  }

  private async loadOutline(path: string): Promise<PdfOutlineEntry[]> {
    const doc = await this.pdf(path);
    const items = (await doc.getOutline?.()) ?? [];
    let count = 0;
    const convert = async (list: PdfJsOutlineItem[]): Promise<PdfOutlineNode[]> => {
      const out: PdfOutlineNode[] = [];
      for (const it of list) {
        if (++count > MAX_OUTLINE_ENTRIES) break;
        const url = safePdfUrl(it.url) ?? undefined;
        const page = !url && it.dest ? ((await this.destPage(doc, it.dest)) ?? undefined) : undefined;
        out.push({ title: it.title ?? "", page, url, items: it.items?.length ? await convert(it.items) : [] });
      }
      return out;
    };
    return flattenOutline(await convert(items));
  }

  pdfLinks(path: string, page: number): readonly PdfLink[] | null {
    const key = `${path}#${page}`;
    const hit = this.links.get(key);
    if (hit === "loading") return null;
    if (hit) return hit;
    this.links.set(key, "loading");
    void this.loadLinks(path, page).then(
      (links) => {
        if (this.links.get(key) === "loading") this.links.set(key, links);
      },
      (e) => {
        console.warn("Ink Notebook: could not read the links of a PDF page", e);
        if (this.links.get(key) === "loading") this.links.set(key, []);
      },
    );
    return null;
  }

  /** The Link annotations of a PDF page: web addresses and jumps to its other pages. */
  private async loadLinks(path: string, pageNo: number): Promise<PdfLink[]> {
    const doc = await this.pdf(path);
    const page = await doc.getPage(pageNo);
    if (!page.getAnnotations) return [];
    const viewport = page.getViewport({ scale: 1 });
    const out: PdfLink[] = [];
    for (const a of await page.getAnnotations({ intent: "display" })) {
      if (a.subtype !== "Link" || !a.rect) continue;
      const rect = pdfLinkRect(viewport.convertToViewportRectangle(a.rect), viewport.width, viewport.height);
      if (!rect) continue;
      const url = safePdfUrl(a.url);
      if (url) {
        out.push({ rect, url });
        continue;
      }
      const target = a.dest ? await this.destPage(doc, a.dest) : null;
      if (target) out.push({ rect, page: target });
    }
    return out;
  }

  /** The page (1-based) a PDF destination points to, or null. */
  private async destPage(doc: PdfDoc, dest: string | unknown[]): Promise<number | null> {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination?.(dest) : dest;
      const ref = Array.isArray(explicit) ? explicit[0] : null;
      if (typeof ref === "number") return ref + 1 <= doc.numPages ? ref + 1 : null;
      if (ref && typeof ref === "object" && doc.getPageIndex) return (await doc.getPageIndex(ref)) + 1;
    } catch {
      /* a broken destination: not a link */
    }
    return null;
  }

  image(path: string): CanvasImageSource | null {
    const hit = this.images.get(path);
    if (hit instanceof HTMLImageElement) return hit;
    if (hit) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.images.set(path, "error");
      return null;
    }
    this.images.set(path, "loading");
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.images.set(path, img);
      this.ready();
    };
    img.onerror = () => this.images.set(path, "error");
    img.src = this.app.vault.getResourcePath(file);
    return null;
  }

  /** Natural size of an image in the vault (for inserting it). */
  async imageSize(path: string): Promise<{ w: number; h: number } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const img = new Image();
    img.src = this.app.vault.getResourcePath(file);
    try {
      await img.decode();
      this.images.set(path, img);
      return { w: img.naturalWidth || 400, h: img.naturalHeight || 300 };
    } catch {
      return null;
    }
  }

  pdfPage(path: string, page: number, pixelWidth: number): CanvasImageSource | null {
    const key = `${path}#${page}`;
    const want = Math.min(MAX_PDF_WIDTH, Math.max(200, Math.ceil(pixelWidth)));
    const hit = this.pages.get(key);
    if (hit) hit.used = Date.now();
    // good enough (or already rendering a better one): use what is there
    if ((!hit || hit.width < want * 0.85) && !this.rendering.has(key)) {
      // render at a little more than needed so small zoom changes do not re-render
      this.enqueue(key, () => this.renderPage(path, page, Math.min(MAX_PDF_WIDTH, Math.ceil(want * 1.25))));
    }
    return hit?.canvas ?? null;
  }

  /** PDF page sizes in points, for creating pages. */
  async pdfInfo(file: TFile, pages?: number[]): Promise<{ count: number; sizes: Map<number, { w: number; h: number }> }> {
    const doc = await this.pdf(file.path);
    const sizes = new Map<number, { w: number; h: number }>();
    for (const n of pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      sizes.set(n, { w: vp.width, h: vp.height });
    }
    return { count: doc.numPages, sizes };
  }

  private pdf(path: string): Promise<PdfDoc> {
    let entry = this.pdfs.get(path);
    if (!entry) {
      const doc = (async () => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`PDF not found: ${path}`);
        const pdfjs = (await loadPdfJs()) as PdfJs;
        const data = new Uint8Array(await this.app.vault.readBinary(file));
        return pdfjs.getDocument({ data }).promise;
      })();
      entry = { doc, used: Date.now() };
      this.pdfs.set(path, entry);
      doc.catch(() => this.pdfs.delete(path));
    }
    entry.used = Date.now();
    return entry.doc;
  }

  private enqueue(key: string, job: () => Promise<void>): void {
    this.rendering.add(key);
    this.queue.push(async () => {
      try {
        await job();
      } catch (e) {
        console.warn("Ink Notebook: could not render a PDF page", e);
      } finally {
        this.rendering.delete(key);
      }
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (job) await job();
      }
    } finally {
      this.busy = false;
    }
  }

  private async renderPage(path: string, pageNo: number, width: number): Promise<void> {
    const doc = await this.pdf(path);
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = createEl("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup?.();
    this.pages.set(`${path}#${pageNo}`, { canvas, width: canvas.width, used: Date.now() });
    // read the page's links now, so they are there by the time it is tapped
    this.pdfLinks(path, pageNo);
    // keep memory in check on tablets
    if (this.pages.size > MAX_PDF_PAGES) {
      const oldest = [...this.pages.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.pages.size - MAX_PDF_PAGES);
      for (const [k] of oldest) this.pages.delete(k);
    }
    this.ready();
  }
}
