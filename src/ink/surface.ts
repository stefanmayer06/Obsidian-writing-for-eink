import { inflate, type Pt, type Rect } from "../core/geometry";
import { History } from "../core/ink/history";
import { pageContentBounds, StrokeIndex, strokeBounds, unionRect } from "../core/ink/geom";
import {
  addItems,
  cloneItems,
  duplicatePage,
  EMPTY_META,
  EMPTY_SELECTION,
  emptyPage,
  insertPage,
  itemsSelection,
  movePage,
  newId,
  paperPage,
  pickItems,
  removeItems,
  removePage,
  replacePage,
  selectionSize,
  type InkDoc,
  type InkFile,
  type InkMeta,
  type Items,
  type Page,
  type PageBackground,
  type Selection,
  type Stroke,
  replaceItems,
  withStroke,
  type FillStyle,
} from "../core/ink/model";
import { areaStroke, closedOutline, fillTargetAt } from "../core/ink/fill";
import { withLabels } from "../core/ink/connectors";
import { DEFAULT_PAPER, type PaperSpec } from "../core/paper";
import { itemsBounds, scaling, transformItems } from "../core/ink/transform";
import { drawPage, drawSegments, measureTextHeight, type ImageSource } from "./render";
import type { Segment } from "../core/ink/pens";
import { InputRouter } from "./input";
import { SelectionOverlay } from "./selection";
import { TextEditor } from "./textEditor";
import {
  DEFAULT_SURFACE_SETTINGS,
  DEFAULT_TOOL_STATE,
  type SurfaceHost,
  type SurfaceSettings,
  type ToolState,
} from "./types";

/**
 * The writing surface: one page of the notebook on screen, like the Boox
 * Notes app.
 *
 * Speed matters most while writing, so the surface keeps one opaque canvas
 * with the page as it looks now. A new stroke is drawn onto it piece by piece
 * as the pen moves (nothing else is redrawn); erasing and moving redraw only
 * the area that changed. A second, transparent canvas shows previews (the
 * highlighter while it is drawn, the lasso, shapes, moved selections).
 */

interface ViewTransform {
  /** CSS pixels per page unit. */
  scale: number;
  /** Position of the page's top-left corner in CSS pixels. */
  ox: number;
  oy: number;
}

interface CachedPage {
  page: Page;
  key: string;
  canvas: HTMLCanvasElement;
}

const PAGE_MARGIN = 12;

/** An item of an object library, ready to be placed with the "stamp" tool. */
export interface Stamp {
  id: string;
  name: string;
  items: Items;
  /** Drawn in the current pen colour, thickness and shape fill (the built-in flowchart shapes). */
  restyle: boolean;
  /** A whole diagram (Mermaid): it may fill most of the page. */
  fitPage?: boolean;
}

export class InkSurface {
  readonly el: HTMLElement;
  /** Holds the canvases and overlays; transformed with CSS while pinching/panning. */
  readonly stage: HTMLElement;
  base: HTMLCanvasElement;
  bctx: CanvasRenderingContext2D;
  readonly wet: HTMLCanvasElement;
  readonly wctx: CanvasRenderingContext2D;
  readonly overlay: HTMLElement;

  private doc: InkDoc = { pages: [paperPage()] };
  private _meta: InkMeta = EMPTY_META;
  private pageIdx = 0;
  readonly history = new History<InkDoc>();
  view: ViewTransform = { scale: 1, ox: 0, oy: 0 };
  /** Scale at which the page fits (the zoom level 100 %). */
  fitScale = 1;
  width = 0;
  height = 0;
  dpr = 1;

  tools: ToolState = structuredClone(DEFAULT_TOOL_STATE);
  settings: SurfaceSettings = { ...DEFAULT_SURFACE_SETTINGS };

  selection: Selection = EMPTY_SELECTION;
  /** The library item the "stamp" tool places (see setStamp). */
  stamp: Stamp | null = null;
  /** Page being changed by a running gesture (eraser), not yet in the document. */
  private work: Page | null = null;
  private indexCache: { page: Page; index: StrokeIndex } | null = null;
  private cache = new Map<string, CachedPage>();
  private preloadTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private renderQueued = false;
  private destroyed = false;
  /** Items hidden from the canvas (being moved or edited). */
  hidden: Set<string> = new Set();
  private clipboard: Items | null = null;
  private backdrop = "#e8e8e8";
  /** Something was drawn on the preview canvas since it was cleared. */
  private wetUsed = false;
  /** The preview canvas is on screen. */
  private wetShown = true;

  readonly input: InputRouter;
  readonly selectionOverlay: SelectionOverlay;
  readonly textEditor: TextEditor;

  constructor(
    parent: HTMLElement,
    readonly host: SurfaceHost,
  ) {
    this.el = parent.createDiv({ cls: "ink-surface" });
    this.el.tabIndex = -1;
    this.stage = this.div(this.el, "ink-stage");
    this.base = this.canvas("ink-base");
    this.wet = this.canvas("ink-wet");
    this.overlay = this.div(this.stage, "ink-overlay");
    this.bctx = this.context(this.base, true);
    this.wctx = this.context(this.wet, false);
    this.clearWet();
    this.input = new InputRouter(this);
    this.selectionOverlay = new SelectionOverlay(this);
    this.textEditor = new TextEditor(this);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.el);
    }
    this.resize();
  }

  private div(parent: HTMLElement, cls: string): HTMLElement {
    return parent.createDiv({ cls });
  }

  private canvas(cls: string): HTMLCanvasElement {
    return this.stage.createEl("canvas", { cls });
  }

  private context(c: HTMLCanvasElement, opaque: boolean): CanvasRenderingContext2D {
    const opts: CanvasRenderingContext2DSettings & { desynchronized?: boolean } = { alpha: !opaque };
    if (opaque && this.settings.lowLatency) opts.desynchronized = true;
    const ctx = c.getContext("2d", opts) ?? c.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    return ctx;
  }

  destroy(): void {
    this.destroyed = true;
    this.input.destroy();
    this.textEditor.commit();
    this.resizeObserver?.disconnect();
    if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
    this.cache.clear();
    this.el.remove();
  }

  // ------------------------------------------------------------------ document

  get file(): InkFile {
    return { doc: this.doc, meta: this._meta };
  }

  get document(): InkDoc {
    return this.doc;
  }

  get meta(): InkMeta {
    return this._meta;
  }

  get pageCount(): number {
    return this.doc.pages.length;
  }

  get pageIndex(): number {
    return this.pageIdx;
  }

  /** The page on screen (including changes of a running gesture). */
  get page(): Page {
    return this.work ?? this.doc.pages[this.pageIdx] ?? this.doc.pages[0];
  }

  /** Show a notebook. `keepHistory` for reloads of the same file (e.g. after sync). */
  load(file: InkFile, opts: { page?: number; keepHistory?: boolean } = {}): void {
    this.input.cancel();
    this.textEditor.cancel();
    this.doc = file.doc.pages.length > 0 ? file.doc : { pages: [paperPage()] };
    this._meta = file.meta;
    if (!opts.keepHistory) this.history.clear();
    this.selection = EMPTY_SELECTION;
    this.work = null;
    this.cache.clear();
    this.pageIdx = Math.max(0, Math.min(this.doc.pages.length - 1, opts.page ?? this.pageIdx));
    this.fit();
    this.renderAll();
    this.emitPage();
    this.emitHistory();
    this.selectionOverlay.update();
  }

  /** Replace the plugin metadata (diagram areas, handwritten links); not undoable. */
  setMeta(meta: InkMeta): void {
    const linksChanged = JSON.stringify(meta.handLinks) !== JSON.stringify(this._meta.handLinks);
    this._meta = meta;
    if (linksChanged) {
      this.cache.clear();
      this.renderAll();
    }
  }

  /** Make an edit: remember the old version for undo, redraw what changed. */
  commit(next: InkDoc, dirty: Rect | null | "all", opts: { keepSelection?: boolean } = {}): void {
    if (next === this.doc) return;
    this.history.record(this.doc);
    this.applyDoc(next, dirty, opts.keepSelection);
  }

  /** Commit a new version of the page on screen. */
  commitPage(page: Page, dirty: Rect | null | "all", opts: { keepSelection?: boolean } = {}): void {
    this.work = null;
    this.commit(replacePage(this.doc, page), dirty, opts);
  }

  private applyDoc(next: InkDoc, dirty: Rect | null | "all", keepSelection = false): void {
    const old = this.doc;
    this.doc = next;
    this.work = null;
    if (this.pageIdx >= next.pages.length) this.pageIdx = next.pages.length - 1;
    if (!keepSelection) this.setSelection(EMPTY_SELECTION);
    const pageChanged = old.pages[this.pageIdx]?.id !== next.pages[this.pageIdx]?.id || old.pages.length !== next.pages.length;
    if (dirty === "all" || pageChanged) {
      this.fitIfNeeded();
      this.renderAll();
    } else if (dirty) this.renderRect(dirty);
    this.emitPage();
    this.emitHistory();
    this.host.changed();
  }

  undo(): void {
    this.input.cancel();
    this.textEditor.commit();
    const prev = this.history.undo(this.doc);
    if (prev) this.restore(prev);
  }

  redo(): void {
    this.input.cancel();
    this.textEditor.commit();
    const next = this.history.redo(this.doc);
    if (next) this.restore(next);
  }

  /** Show an earlier/later version, going to the page where something changed. */
  private restore(target: InkDoc): void {
    const before = this.doc;
    const cur = before.pages[this.pageIdx];
    // the page on screen changed? stay. Otherwise go to the first page that differs.
    let idx = target.pages.findIndex((p) => p.id === cur?.id);
    const same = idx >= 0 && target.pages[idx] === cur;
    if (same) {
      const changed = target.pages.findIndex((p, i) => p !== before.pages[i]);
      if (changed >= 0) idx = changed;
    }
    if (idx >= 0) this.pageIdx = idx;
    const dirty = idx >= 0 && cur && target.pages[idx]?.id === cur.id ? diffBounds(cur, target.pages[idx]) : "all";
    this.applyDoc(target, dirty);
  }

  // ------------------------------------------------------------------ gestures in progress

  /** Start changing the page on screen without committing (eraser). */
  beginWork(): void {
    this.work = this.doc.pages[this.pageIdx];
  }

  /** Update the page being changed and redraw `dirty`. */
  setWork(page: Page, dirty: Rect | null): void {
    this.work = page;
    if (dirty) this.renderRect(dirty);
  }

  /** Finish the change: commit it (one undo step) or throw it away. */
  endWork(commit: boolean): void {
    const page = this.work;
    this.work = null;
    if (!page) return;
    const original = this.doc.pages[this.pageIdx];
    if (commit && page !== original) this.commit(replacePage(this.doc, page), null);
    else if (page !== original) this.renderAll();
  }

  /** Spatial index of the strokes of a page (kept while the page does not change). */
  strokeIndex(page: Page): StrokeIndex {
    if (this.indexCache?.page !== page) {
      // reuse the old index when only strokes were replaced by the running gesture
      this.indexCache = { page, index: new StrokeIndex(page.strokes) };
    }
    return this.indexCache.index;
  }

  /** Tell the index cache that `page` follows from the indexed page by these edits. */
  updateIndex(from: Page, to: Page, removed: Iterable<Stroke>, added: Iterable<Stroke>): void {
    if (this.indexCache?.page !== from) {
      this.indexCache = null;
      return;
    }
    const idx = this.indexCache.index;
    for (const s of removed) idx.remove(s);
    for (const s of added) idx.insert(s);
    this.indexCache = { page: to, index: idx };
  }

  // ------------------------------------------------------------------ coordinates

  /** Client (screen) coordinates to page coordinates. */
  toPage(clientX: number, clientY: number, rect = this.el.getBoundingClientRect()): Pt {
    return { x: (clientX - rect.left - this.view.ox) / this.view.scale, y: (clientY - rect.top - this.view.oy) / this.view.scale };
  }

  /** Page coordinates to CSS pixels inside the surface. */
  toScreen(p: Pt): Pt {
    return { x: p.x * this.view.scale + this.view.ox, y: p.y * this.view.scale + this.view.oy };
  }

  /** Set a context's transform so that it draws in page units. */
  pageTransform(ctx: CanvasRenderingContext2D): void {
    const k = this.view.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, this.view.ox * this.dpr, this.view.oy * this.dpr);
  }

  // ------------------------------------------------------------------ size, zoom

  resize(): void {
    if (this.destroyed) return;
    const w = Math.max(1, Math.round(this.el.clientWidth));
    const h = Math.max(1, Math.round(this.el.clientHeight));
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    const wasFit = Math.abs(this.view.scale - this.fitScale) < 1e-6 || this.width === 0;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    for (const c of [this.base, this.wet]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.cache.clear();
    if (wasFit) this.fit();
    else this.clampView();
    this.renderAll();
    this.selectionOverlay.update();
    this.textEditor.position();
  }

  private computeFit(page: Page): ViewTransform {
    const availW = Math.max(50, this.width - 2 * PAGE_MARGIN);
    const availH = Math.max(50, this.height - 2 * PAGE_MARGIN);
    const scale = this.settings.fit === "width" ? availW / page.w : Math.min(availW / page.w, availH / page.h);
    const ox = (this.width - page.w * scale) / 2;
    const oy = page.h * scale <= availH ? (this.height - page.h * scale) / 2 : PAGE_MARGIN;
    return { scale, ox, oy };
  }

  /** Show the whole page (or its width, see settings). */
  fit(): void {
    const t = this.computeFit(this.page);
    this.fitScale = t.scale;
    this.view = t;
  }

  private fitIfNeeded(): void {
    const t = this.computeFit(this.page);
    if (Math.abs(this.view.scale - this.fitScale) < 1e-6) this.view = t;
    this.fitScale = t.scale;
    this.clampView();
  }

  get zoomed(): boolean {
    return this.view.scale > this.fitScale * 1.02;
  }

  /** Keep the page on screen. */
  clampView(): void {
    const p = this.page;
    const { scale } = this.view;
    const pw = p.w * scale;
    const ph = p.h * scale;
    const clamp = (o: number, size: number, avail: number) =>
      size + 2 * PAGE_MARGIN <= avail ? (avail - size) / 2 : Math.min(PAGE_MARGIN, Math.max(avail - size - PAGE_MARGIN, o));
    this.view = { scale, ox: clamp(this.view.ox, pw, this.width), oy: clamp(this.view.oy, ph, this.height) };
  }

  /** Zoom by `k` around a point (CSS pixels in the surface). */
  setView(t: ViewTransform): void {
    const min = this.fitScale * 0.5;
    const max = this.fitScale * 8;
    const scale = Math.min(max, Math.max(min, t.scale));
    const k = scale / t.scale;
    this.view = { scale, ox: t.ox * k + (1 - k) * (this.width / 2), oy: t.oy * k + (1 - k) * (this.height / 2) };
    this.clampView();
    this.cache.clear();
    this.renderAll();
    this.selectionOverlay.update();
    this.textEditor.position();
  }

  zoomAt(k: number, cx: number, cy: number): void {
    const v = this.view;
    this.setView({ scale: v.scale * k, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k });
  }

  resetZoom(): void {
    this.fit();
    this.cache.clear();
    this.renderAll();
    this.selectionOverlay.update();
    this.textEditor.position();
  }

  /** Toggle between the whole page and its width. */
  toggleFit(): void {
    this.settings.fit = this.settings.fit === "page" ? "width" : "page";
    this.resetZoom();
  }

  // ------------------------------------------------------------------ rendering

  /** Colour around the page (white on e-ink). */
  setBackdrop(color: string): void {
    if (color === this.backdrop) return;
    this.backdrop = color;
    this.cache.clear();
    this.renderAll();
  }

  private renderKey(page: Page): string {
    const v = this.view;
    return `${this.width}x${this.height}@${this.dpr}|${v.scale.toFixed(5)},${v.ox.toFixed(2)},${v.oy.toFixed(2)}|${this.backdrop}|${page.id}`;
  }

  private paint(ctx: CanvasRenderingContext2D, page: Page, clip: Rect | null): void {
    const k = this.view.scale * this.dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (clip) {
      const x0 = Math.floor((clip.x * this.view.scale + this.view.ox) * this.dpr) - 1;
      const y0 = Math.floor((clip.y * this.view.scale + this.view.oy) * this.dpr) - 1;
      const x1 = Math.ceil(((clip.x + clip.w) * this.view.scale + this.view.ox) * this.dpr) + 1;
      const y1 = Math.ceil(((clip.y + clip.h) * this.view.scale + this.view.oy) * this.dpr) + 1;
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.fillStyle = this.backdrop;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      ctx.fillStyle = this.backdrop;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.setTransform(k, 0, 0, k, this.view.ox * this.dpr, this.view.oy * this.dpr);
    // the page's edge
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, page.w, page.h);
    ctx.clip();
    drawPage(ctx, page, {
      images: this.host.images,
      pixelScale: k,
      clip,
      hide: this.hidden.size > 0 ? this.hidden : undefined,
      handLinks: this._meta.handLinks,
    });
    ctx.restore();
    ctx.lineWidth = 1 / this.view.scale;
    ctx.strokeStyle = this.settings.eink ? "#000000" : "#b0b0b0";
    ctx.strokeRect(0, 0, page.w, page.h);
    ctx.restore();
  }

  /** Redraw everything (uses the page cache when possible). */
  renderAll(): void {
    if (this.width === 0) return;
    const page = this.page;
    const cached = this.cache.get(page.id);
    if (cached && cached.page === page && cached.key === this.renderKey(page) && this.hidden.size === 0) {
      this.bctx.save();
      this.bctx.setTransform(1, 0, 0, 1, 0, 0);
      this.bctx.drawImage(cached.canvas, 0, 0);
      this.bctx.restore();
    } else {
      this.paint(this.bctx, page, null);
    }
    this.schedulePreload();
    this.host.viewChanged?.();
  }

  /** Redraw a part of the page (page units). */
  renderRect(r: Rect): void {
    if (this.width === 0) return;
    this.paint(this.bctx, this.page, inflate(r, 2));
  }

  /** Redraw soon (e.g. after an image finished loading). */
  queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.destroyed) return;
      this.cache.clear();
      if (!this.input.busy) this.renderAll();
    });
  }

  /** Draw pieces of a stroke being written, right onto the page. */
  drawLive(segs: ReadonlyArray<Segment>): void {
    if (segs.length > 0) drawSegments(this.bctx, segs);
  }

  /** Prepare the main canvas for live strokes (transform and caps). */
  beginLive(): void {
    this.pageTransform(this.bctx);
    this.bctx.lineCap = "round";
    this.bctx.lineJoin = "round";
    this.bctx.globalCompositeOperation = "source-over";
    this.bctx.setLineDash([]);
  }

  /**
   * Clear the preview canvas and take it off the screen: while it is not
   * needed, the page canvas is the only layer and nothing has to be blended
   * over the ink as it is written.
   */
  clearWet(): void {
    if (this.wetUsed) {
      this.wctx.setTransform(1, 0, 0, 1, 0, 0);
      this.wctx.clearRect(0, 0, this.wet.width, this.wet.height);
      this.wetUsed = false;
    }
    if (this.wetShown) {
      this.wet.hidden = true;
      this.wetShown = false;
    }
  }

  /** The preview canvas, cleared, drawing in page units. */
  wetContext(): CanvasRenderingContext2D {
    if (this.wetUsed) {
      this.wctx.setTransform(1, 0, 0, 1, 0, 0);
      this.wctx.clearRect(0, 0, this.wet.width, this.wet.height);
    }
    if (!this.wetShown) {
      this.wet.hidden = false;
      this.wetShown = true;
    }
    this.wetUsed = true;
    this.pageTransform(this.wctx);
    this.wctx.lineCap = "round";
    this.wctx.lineJoin = "round";
    return this.wctx;
  }

  /** Render neighbouring pages in the background so that turning pages is instant. */
  private schedulePreload(): void {
    if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
    this.preloadTimer = window.setTimeout(() => {
      this.preloadTimer = null;
      if (this.destroyed || this.input.busy) return;
      for (const i of [this.pageIdx + 1, this.pageIdx - 1]) {
        const page = this.doc.pages[i];
        if (!page) continue;
        const saved = this.view;
        this.view = this.computeFit(page);
        const key = this.renderKey(page);
        const hit = this.cache.get(page.id);
        if (!hit || hit.page !== page || hit.key !== key) {
          const canvas = hit?.canvas ?? createEl("canvas");
          canvas.width = this.base.width;
          canvas.height = this.base.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            this.paint(ctx, page, null);
            this.cache.set(page.id, { page, key, canvas });
          }
        }
        this.view = saved;
      }
      // drop pages far away
      for (const id of [...this.cache.keys()]) {
        const i = this.doc.pages.findIndex((p) => p.id === id);
        if (i < 0 || Math.abs(i - this.pageIdx) > 1) this.cache.delete(id);
      }
    }, 250);
  }

  // ------------------------------------------------------------------ pages

  private emitPage(): void {
    this.host.pageChanged?.(this.pageIdx, this.doc.pages.length);
  }

  emitHistory(): void {
    this.host.historyChanged?.(this.history.canUndo, this.history.canRedo);
  }

  goTo(index: number): void {
    const i = Math.max(0, Math.min(this.doc.pages.length - 1, index));
    if (i === this.pageIdx) return;
    this.input.cancel();
    this.textEditor.commit();
    this.setSelection(EMPTY_SELECTION);
    // keep the page we leave, for turning back quickly
    const leaving = this.page;
    if (!this.zoomed && this.hidden.size === 0) {
      const canvas = this.cache.get(leaving.id)?.canvas ?? createEl("canvas");
      canvas.width = this.base.width;
      canvas.height = this.base.height;
      canvas.getContext("2d")?.drawImage(this.base, 0, 0);
      this.cache.set(leaving.id, { page: leaving, key: this.renderKey(leaving), canvas });
    }
    this.pageIdx = i;
    this.fit();
    this.renderAll();
    this.emitPage();
  }

  next(): void {
    this.goTo(this.pageIdx + 1);
  }

  prev(): void {
    this.goTo(this.pageIdx - 1);
  }

  /** Add a page after/before the current one or at the end (paper like the current page unless given). */
  addPage(where: "after" | "before" | "end", bg?: PageBackground, size?: { w: number; h: number }): void {
    const cur = this.page;
    const background: PageBackground = bg ?? (cur.bg.kind === "paper" ? cur.bg : { kind: "paper", paper: lastPaper(this.doc) });
    const page = background.kind === "paper" && !size ? paperPage(background.paper) : emptyPage(background, size?.w ?? cur.w, size?.h ?? cur.h);
    const at = where === "end" ? this.doc.pages.length : where === "after" ? this.pageIdx + 1 : this.pageIdx;
    this.input.cancel();
    this.textEditor.commit();
    this.history.record(this.doc);
    this.pageIdx = at;
    this.applyDoc(insertPage(this.doc, page, at), "all");
    this.fit();
    this.renderAll();
  }

  deletePage(index = this.pageIdx): void {
    const page = this.doc.pages[index];
    if (!page) return;
    if (this.doc.pages.length <= 1) {
      // the last page is cleared instead
      this.commit(replacePage(this.doc, { ...page, strokes: [], texts: [], images: [], links: [], figures: [] }), "all");
      return;
    }
    this.commit(removePage(this.doc, page.id), "all");
    if (this.pageIdx >= this.doc.pages.length) this.pageIdx = this.doc.pages.length - 1;
    this.fit();
    this.renderAll();
    this.emitPage();
  }

  duplicatePage(index = this.pageIdx): void {
    const page = this.doc.pages[index];
    if (!page) return;
    this.commit(insertPage(this.doc, duplicatePage(page), index + 1), "all");
    this.goTo(index + 1);
  }

  movePage(from: number, to: number): void {
    const page = this.doc.pages[from];
    if (!page) return;
    const current = this.page.id;
    this.commit(movePage(this.doc, page.id, to), "all");
    this.pageIdx = Math.max(0, this.doc.pages.findIndex((p) => p.id === current));
    this.emitPage();
  }

  /** Change the background of a page (its content stays). */
  setBackground(bg: PageBackground, size?: { w: number; h: number }, index = this.pageIdx): void {
    const page = this.doc.pages[index];
    if (!page) return;
    const next: Page = { ...page, bg, w: size?.w ?? page.w, h: size?.h ?? page.h };
    this.commit(replacePage(this.doc, next), "all");
    if (index === this.pageIdx) {
      this.fit();
      this.renderAll();
    }
  }

  clearPage(): void {
    const page = this.page;
    this.commitPage({ ...page, strokes: [], texts: [], images: [], links: [], figures: [] }, "all");
  }

  // ------------------------------------------------------------------ tools

  setTools(patch: Partial<ToolState>): void {
    this.textEditor.commit();
    const changedTool = patch.tool !== undefined && patch.tool !== this.tools.tool;
    this.tools = { ...this.tools, ...patch, widths: { ...this.tools.widths, ...(patch.widths ?? {}) } };
    // nothing to place: back to the pen
    if (this.tools.tool === "stamp" && !this.stamp) this.tools = { ...this.tools, tool: "pen" };
    if (changedTool && this.tools.tool !== "stamp") this.stamp = null;
    if (changedTool && this.tools.tool !== "lasso") this.setSelection(EMPTY_SELECTION);
    this.host.toolChanged?.(this.tools);
  }

  // ------------------------------------------------------------------ fills

  /** The fill tool: fill what encloses `p` with the fill colour (or remove its fill). */
  fillAt(p: Pt): void {
    const page = this.page;
    const { fillColor: color, fillStyle } = this.tools;
    const target = fillTargetAt(page, p, (r) => this.strokeIndex(page).query(r));
    if (!target) {
      this.host.notice?.("Tap inside a shape or a closed area to fill it.");
      return;
    }
    if (target.kind === "stroke") {
      const st = target.stroke;
      if ((st.fill ?? "") === color && (!color || (st.fillStyle ?? "solid") === fillStyle)) return;
      const next = withStroke(st, color ? { fill: color, fillStyle } : { fill: undefined, fillStyle: undefined });
      this.commitPage(replaceItems(page, { strokes: [next] }), strokeBounds(st));
      return;
    }
    const old = target.existing;
    if (old) {
      if (!color) this.commitPage({ ...page, strokes: page.strokes.filter((st) => st.id !== old.id) }, strokeBounds(old));
      else if (old.fill !== color || (old.fillStyle ?? "solid") !== fillStyle) this.commitPage(replaceItems(page, { strokes: [withStroke(old, { fill: color, color, fillStyle })] }), strokeBounds(old));
      return;
    }
    if (!color) {
      this.host.notice?.("There is no fill here.");
      return;
    }
    const area = areaStroke(target.pts, color, fillStyle);
    this.commitPage(addItems(page, { strokes: [area] }), strokeBounds(area));
  }

  /** Fill the selected shapes ("" removes their fill; selected areas are removed then). */
  fillSelection(color: string, fillStyle: FillStyle): void {
    const sel = this.selection;
    const page = this.page;
    const strokes: Stroke[] = [];
    for (const st of page.strokes) {
      if (!sel.strokes.has(st.id) || st.pen === "marker" || !closedOutline(st)) strokes.push(st);
      else if (st.area) {
        if (color) strokes.push(withStroke(st, { fill: color, color, fillStyle }));
      } else strokes.push(withStroke(st, color ? { fill: color, fillStyle } : { fill: undefined, fillStyle: undefined }));
    }
    this.commitPage({ ...page, strokes }, this.selectionBounds(), { keepSelection: true });
  }

  /** Can the selection be filled (does it hold shapes or closed strokes)? */
  get selectionFillable(): boolean {
    return this.page.strokes.some((st) => this.selection.strokes.has(st.id) && st.pen !== "marker" && closedOutline(st) !== null);
  }

  // ------------------------------------------------------------------ object libraries

  /** Choose a library item to place: every tap on the page puts one there (until another tool is chosen). */
  setStamp(stamp: Stamp | null): void {
    if (!stamp) {
      this.stamp = null;
      if (this.tools.tool === "stamp") this.setTools({ tool: "pen" });
      return;
    }
    // items bigger than most of the page are made smaller (a whole diagram may fill nearly all of it)
    const box = itemsBounds(stamp.items);
    const page = this.page;
    let items = stamp.items;
    if (box) {
      const [fw, fh] = stamp.fitPage ? [0.94, 0.94] : [0.8, 0.6];
      const k = Math.min(1, (page.w * fw) / Math.max(1, box.w), (page.h * fh) / Math.max(1, box.h));
      if (k < 0.999) items = transformItems(items, scaling(k, { x: box.x, y: box.y }));
    }
    this.textEditor.commit();
    this.setSelection(EMPTY_SELECTION);
    this.stamp = { ...stamp, items };
    this.tools = { ...this.tools, tool: "stamp" };
    this.host.toolChanged?.(this.tools);
  }

  /** The items being placed, as they will look (in the pen colour and thickness, for the built-in shapes). */
  stampItems(): Items | null {
    const st = this.stamp;
    if (!st) return null;
    if (!st.restyle) return st.items;
    const t = this.tools;
    const width = Math.max(1, t.widths[t.pen]);
    return {
      ...st.items,
      strokes: st.items.strokes.map((it) =>
        withStroke(it, { color: t.color, width, ...(closedOutline(it) && !it.area ? { fill: t.shapeFill || undefined, fillStyle: t.fillStyle } : {}) }),
      ),
      texts: st.items.texts.map((it) => ({ ...it, color: t.color })),
    };
  }

  /** Put the library item being placed on the page, centred at `at`. */
  placeStamp(at: Pt): void {
    const look = this.stampItems();
    if (!look) return;
    const items = cloneItems(look);
    const box = itemsBounds(items);
    if (!box) return;
    const page = this.page;
    const cx = Math.max(box.w / 2, Math.min(page.w - box.w / 2, at.x));
    const cy = Math.max(box.h / 2, Math.min(page.h - box.h / 2, at.y));
    const moved = shiftItems(items, cx - (box.x + box.w / 2), cy - (box.y + box.h / 2));
    this.commitPage(addItems(page, moved), itemsBounds(moved));
  }

  setSettings(patch: Partial<SurfaceSettings>): void {
    const fitChanged = patch.fit !== undefined && patch.fit !== this.settings.fit;
    const latencyChanged = patch.lowLatency !== undefined && patch.lowLatency !== this.settings.lowLatency;
    this.settings = { ...this.settings, ...patch };
    if (latencyChanged) {
      // a canvas cannot change its mode: put a new one in its place
      const fresh = createEl("canvas", { cls: this.base.className });
      fresh.width = this.base.width;
      fresh.height = this.base.height;
      fresh.style.cssText = this.base.style.cssText;
      this.base.replaceWith(fresh);
      this.base = fresh;
      this.bctx = this.context(fresh, true);
      this.renderAll();
    }
    if (fitChanged) this.resetZoom();
  }

  // ------------------------------------------------------------------ selection

  setSelection(sel: Selection): void {
    const wasEmpty = selectionSize(this.selection) === 0;
    // labels go with their shapes
    sel = withLabels(this.page, sel);
    this.selection = sel;
    // nothing was selected and nothing is: leave the page alone (this runs after every stroke)
    if (wasEmpty && selectionSize(sel) === 0) return;
    this.selectionOverlay.update();
    this.host.selectionChanged?.(selectionSize(sel));
  }

  selectedItems(): Items {
    return pickItems(this.page, this.selection);
  }

  selectionBounds(): Rect | null {
    return selectionSize(this.selection) > 0 ? itemsBounds(this.selectedItems()) : null;
  }

  deleteSelection(): void {
    const box = this.selectionBounds();
    if (!box) return;
    this.commitPage(removeItems(this.page, this.selection), box);
  }

  copySelection(): void {
    if (selectionSize(this.selection) === 0) return;
    this.clipboard = this.selectedItems();
    this.host.notice?.("Copied.");
  }

  cutSelection(): void {
    if (selectionSize(this.selection) === 0) return;
    this.clipboard = this.selectedItems();
    this.deleteSelection();
  }

  get canPaste(): boolean {
    return !!this.clipboard;
  }

  /** Paste the copied items (a little offset when pasted onto the page they came from). */
  paste(): void {
    if (!this.clipboard) return;
    const items = cloneItems(this.clipboard);
    const box = itemsBounds(items);
    const page = this.page;
    let dx = 0;
    let dy = 0;
    if (box) {
      const onPage = page.strokes.some((s) => this.clipboard?.strokes.some((c) => c.pts === s.pts));
      if (onPage) {
        dx = 24;
        dy = 24;
      }
      // keep it on the page
      dx = Math.max(-box.x, Math.min(page.w - box.x - box.w, dx));
      dy = Math.max(-box.y, Math.min(page.h - box.y - box.h, dy));
    }
    const moved = dx || dy ? shiftItems(items, dx, dy) : items;
    const next = addItems(page, moved);
    const nb = itemsBounds(moved);
    this.commitPage(next, nb, { keepSelection: true });
    this.setTools({ tool: "lasso" });
    this.setSelection(itemsSelection(moved));
  }

  duplicateSelection(): void {
    if (selectionSize(this.selection) === 0) return;
    const items = shiftItems(cloneItems(this.selectedItems()), 24, 24);
    this.commitPage(addItems(this.page, items), itemsBounds(items), { keepSelection: true });
    this.setSelection(itemsSelection(items));
  }

  selectAll(): void {
    const p = this.page;
    this.setTools({ tool: "lasso" });
    this.setSelection(itemsSelection({ strokes: [...p.strokes], texts: [...p.texts], images: [...p.images], links: [...p.links], figures: [...p.figures] }));
  }

  /** Change the colour of the selected strokes and text. */
  recolorSelection(color: string): void {
    const sel = this.selection;
    const page = this.page;
    const next: Page = {
      ...page,
      strokes: page.strokes.map((s) => (sel.strokes.has(s.id) && s.pen !== "marker" && !s.area ? { ...s, color } : s)),
      texts: page.texts.map((t) => (sel.texts.has(t.id) ? { ...t, color } : t)),
    };
    this.commitPage(next, this.selectionBounds(), { keepSelection: true });
  }

  /** Mark the selection as a figure (embedded as a picture on the text page). */
  makeFigure(): void {
    const box = this.selectionBounds();
    if (!box) return;
    const pad = 12;
    const fig = { id: newId(), x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
    this.commitPage(addItems(this.page, { figures: [fig] }), inflate(box, pad + 20));
  }

  // ------------------------------------------------------------------ inserting

  /** Place items in the middle of the visible part of the page and select them. */
  insert(items: Partial<Items>): void {
    const full: Items = { strokes: [], texts: [], images: [], links: [], figures: [], ...items };
    const box = itemsBounds(full);
    const page = this.page;
    let moved = full;
    if (box) {
      // the middle of what is visible
      const vx = (this.width / 2 - this.view.ox) / this.view.scale;
      const vy = (this.height / 2 - this.view.oy) / this.view.scale;
      const cx = Math.max(box.w / 2, Math.min(page.w - box.w / 2, vx));
      const cy = Math.max(box.h / 2, Math.min(page.h - box.h / 2, vy));
      moved = shiftItems(full, cx - (box.x + box.w / 2), cy - (box.y + box.h / 2));
    }
    this.commitPage(addItems(page, moved), itemsBounds(moved), { keepSelection: true });
    this.setTools({ tool: "lasso" });
    this.setSelection(itemsSelection(moved));
  }

  insertImage(src: string, naturalW: number, naturalH: number): void {
    const page = this.page;
    const maxW = page.w * 0.6;
    const maxH = page.h * 0.5;
    const k = Math.min(1, maxW / Math.max(1, naturalW), maxH / Math.max(1, naturalH));
    this.insert({ images: [{ id: newId(), x: 0, y: 0, w: Math.round(naturalW * k), h: Math.round(naturalH * k), src }] });
  }

  insertLink(target: string): void {
    this.insert({ links: [{ id: newId(), x: 0, y: 0, target }] });
  }

  insertText(text: string, at?: Pt): void {
    const size = this.tools.textSize;
    const w = Math.min(this.page.w * 0.7, 520);
    const t = { id: newId(), x: at?.x ?? 0, y: at?.y ?? 0, w, h: measureTextHeight(text, w, size), text, size, color: this.tools.color };
    if (at) this.commitPage(addItems(this.page, { texts: [t] }), { x: t.x, y: t.y, w: t.w, h: t.h });
    else this.insert({ texts: [t] });
  }

  /** Bounds of all content on the page on screen. */
  contentBounds(): Rect | null {
    return pageContentBounds(this.page);
  }

  get images(): ImageSource {
    return this.host.images;
  }
}

/** Area that differs between two versions of a page (null: nothing). */
export function diffBounds(a: Page, b: Page): Rect | "all" {
  if (a.bg !== b.bg || a.w !== b.w || a.h !== b.h) return "all";
  let r: Rect | null = null;
  const diff = <T>(xs: readonly T[], ys: readonly T[], bounds: (t: T) => Rect) => {
    if (xs === ys) return;
    const sx = new Set(xs);
    const sy = new Set(ys);
    for (const x of xs) if (!sy.has(x)) r = unionRect(r, bounds(x));
    for (const y of ys) if (!sx.has(y)) r = unionRect(r, bounds(y));
  };
  diff(a.strokes, b.strokes, strokeBounds);
  diff(a.texts, b.texts, (t) => ({ x: t.x, y: t.y, w: t.w, h: t.h }));
  diff(a.images, b.images, (i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  diff(a.links, b.links, (l) => ({ x: l.x - 2, y: l.y - 2, w: 400, h: 40 }));
  diff(a.figures, b.figures, (f) => ({ x: f.x - 4, y: f.y - 24, w: f.w + 8, h: f.h + 28 }));
  return r ?? { x: 0, y: 0, w: 0, h: 0 };
}

function shiftItems(items: Items, dx: number, dy: number): Items {
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    strokes: items.strokes.map((s) => {
      const pts = new Float32Array(s.pts);
      for (let i = 0; i + 2 < pts.length; i += 3) {
        pts[i] = r(pts[i] + dx);
        pts[i + 1] = r(pts[i + 1] + dy);
      }
      return { ...s, pts };
    }),
    texts: items.texts.map((t) => ({ ...t, x: r(t.x + dx), y: r(t.y + dy) })),
    images: items.images.map((i) => ({ ...i, x: r(i.x + dx), y: r(i.y + dy) })),
    links: items.links.map((l) => ({ ...l, x: r(l.x + dx), y: r(l.y + dy) })),
    figures: items.figures.map((f) => ({ ...f, x: r(f.x + dx), y: r(f.y + dy) })),
  };
}

function lastPaper(doc: InkDoc): PaperSpec {
  for (let i = doc.pages.length - 1; i >= 0; i--) {
    const bg = doc.pages[i].bg;
    if (bg.kind === "paper") return bg.paper;
  }
  return DEFAULT_PAPER;
}
