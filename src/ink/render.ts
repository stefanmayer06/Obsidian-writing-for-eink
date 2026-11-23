import { intersects, type Rect } from "../core/geometry";
import { paperDrawing } from "../core/paper";
import { figureBounds, imageBounds, LINK_CHIP_HEIGHT, linkBounds, linkChipWidth, linkLabel, strokeBounds, strokePointBounds, textBounds } from "../core/ink/geom";
import { isMarker, linePattern, strokeRuns, type Segment } from "../core/ink/pens";
import { fillGeometry } from "../core/ink/fill";
import type { Figure, ImageItem, Items, LinkItem, Page, Stroke, TextBox } from "../core/ink/model";
import type { TextMeasure } from "../core/ink/fromMermaid";
import type { PdfLink } from "../core/pdfLinks";

/**
 * Drawing pages on a canvas. Used by the ink view, page thumbnails, figures on
 * the text page and exports, so everything looks the same everywhere.
 */

/** Where pictures come from (the vault, in Obsidian). */
export interface ImageSource {
  /** A loaded picture, or null while it is loading (call `onReady` when it arrived). */
  image(path: string): CanvasImageSource | null;
  /** The PDF page rendered at least `pixelWidth` wide, or null while it is rendering. */
  pdfPage(path: string, page: number, pixelWidth: number): CanvasImageSource | null;
  /** The links on a PDF page, or null while they are loading. */
  pdfLinks?(path: string, page: number): readonly PdfLink[] | null;
}

export const NO_IMAGES: ImageSource = { image: () => null, pdfPage: () => null };

export const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const TEXT_LINE_HEIGHT = 1.3;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ------------------------------------------------------------------ strokes

interface CachedRun {
  w: number;
  color: string;
  path: Path2D;
  head?: boolean;
}

const runCache = new WeakMap<Stroke, CachedRun[]>();

function cachedRuns(s: Stroke): CachedRun[] {
  let runs = runCache.get(s);
  if (!runs) {
    runs = strokeRuns(s).map((r) => ({ w: r.w, color: r.color, path: new Path2D(r.d), head: r.head }));
    runCache.set(s, runs);
  }
  return runs;
}

interface CachedFill {
  color: string;
  area: Path2D | null;
  lines: Path2D | null;
  lineWidth: number;
}

const fillCache = new WeakMap<Stroke, CachedFill | null>();

/** Draw the fill of a stroke (nothing for strokes without one). */
export function drawStrokeFill(ctx: Ctx, s: Stroke): void {
  if (!s.fill) return;
  let c = fillCache.get(s);
  if (c === undefined) {
    const g = fillGeometry(s);
    c = g ? { color: g.color, area: g.area ? new Path2D(g.area) : null, lines: g.lines ? new Path2D(g.lines) : null, lineWidth: g.lineWidth } : null;
    fillCache.set(s, c);
  }
  if (!c) return;
  ctx.save();
  if (c.area) {
    ctx.fillStyle = c.color;
    ctx.fill(c.area);
  }
  if (c.lines) {
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.lineWidth;
    ctx.lineCap = "round";
    ctx.setLineDash([]);
    ctx.stroke(c.lines);
  }
  ctx.restore();
}

/** Draw one stroke with its fill (the transform maps page units to pixels). */
export function drawStroke(ctx: Ctx, s: Stroke): void {
  drawStrokeFill(ctx, s);
  drawStrokeLine(ctx, s);
}

/** Draw the line of a stroke (not its fill; nothing for areas, which are only a fill). */
export function drawStrokeLine(ctx: Ctx, s: Stroke): void {
  if (s.area) return;
  const marker = isMarker(s);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (marker) ctx.globalCompositeOperation = "multiply";
  for (const run of cachedRuns(s)) {
    // arrow heads stay solid on a dashed line
    ctx.setLineDash(run.head ? [] : linePattern(s));
    ctx.strokeStyle = run.color;
    ctx.lineWidth = run.w;
    ctx.stroke(run.path);
  }
  ctx.restore();
}

/** Add a piece of a stroke to a path (that is already at `seg.a`). */
export function segmentPath(path: CanvasPath, seg: Segment): void {
  if (seg.kind === "dot") path.lineTo(seg.a.x + 0.01, seg.a.y);
  else if (seg.kind === "quad" && seg.c) path.quadraticCurveTo(seg.c.x, seg.c.y, seg.b.x, seg.b.y);
  else path.lineTo(seg.b.x, seg.b.y);
}

/**
 * Draw pieces of a stroke while it is being written. Pieces of the same width
 * and colour go into one path, so a pen move that brings several points costs
 * one draw call, not one per point.
 */
export function drawSegments(ctx: Ctx, segs: ReadonlyArray<Segment>): void {
  let i = 0;
  while (i < segs.length) {
    const first = segs[i];
    ctx.strokeStyle = first.color;
    ctx.lineWidth = first.w;
    ctx.beginPath();
    ctx.moveTo(first.a.x, first.a.y);
    let j = i;
    for (; j < segs.length; j++) {
      const seg = segs[j];
      if (j > i) {
        if (seg.w !== first.w || seg.color !== first.color) break;
        const prev = segs[j - 1];
        if (seg.a.x !== prev.b.x || seg.a.y !== prev.b.y) ctx.moveTo(seg.a.x, seg.a.y);
      }
      segmentPath(ctx, seg);
    }
    ctx.stroke();
    i = j;
  }
}

// ------------------------------------------------------------------ paper

interface PaperCache {
  fill: string;
  paths: Array<{ path: Path2D; stroke: string; width: number; gap?: number }>;
}

const paperCache = new Map<string, PaperCache>();

function paperFor(page: Page): PaperCache | null {
  if (page.bg.kind !== "paper") return null;
  const key = `${JSON.stringify(page.bg.paper)}|${page.w}x${page.h}`;
  let c = paperCache.get(key);
  if (!c) {
    const d = paperDrawing(page.bg.paper, { width: page.w, height: page.h });
    c = { fill: d.fill, paths: d.paths.map((p) => ({ path: new Path2D(p.d), stroke: p.stroke, width: p.width, gap: p.dots?.gap })) };
    if (paperCache.size > 40) paperCache.clear();
    paperCache.set(key, c);
  }
  return c;
}

export interface BackgroundOptions {
  /** Pixels per page unit (for picking the PDF resolution). */
  pixelScale: number;
  images: ImageSource;
  /** Draw the paper lines (off for OCR-like exports of only the ink). */
  lines?: boolean;
}

/** Paper colour and lines, or the PDF page / image. */
export function drawBackground(ctx: Ctx, page: Page, opts: BackgroundOptions): void {
  const paper = paperFor(page);
  ctx.fillStyle = paper?.fill ?? "#ffffff";
  ctx.fillRect(0, 0, page.w, page.h);
  if (page.bg.kind === "pdf") {
    const img = opts.images.pdfPage(page.bg.path, page.bg.page, Math.ceil(page.w * opts.pixelScale));
    if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
    return;
  }
  if (page.bg.kind === "image") {
    const img = opts.images.image(page.bg.path);
    if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
    return;
  }
  if (!paper || opts.lines === false) return;
  ctx.save();
  for (const p of paper.paths) {
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = p.width;
    if (p.gap) {
      ctx.lineCap = "round";
      ctx.setLineDash([0.01, p.gap - 0.01]);
    } else {
      ctx.lineCap = "butt";
      ctx.setLineDash([]);
    }
    ctx.stroke(p.path);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ text

export function fontFor(size: number): string {
  return `${size}px ${TEXT_FONT}`;
}

/** Break text into lines that fit `width` (in the units of `size`). */
export function wrapText(ctx: Ctx, text: string, width: number, size: number): string[] {
  ctx.font = fontFor(size);
  const out: string[] = [];
  for (const para of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (line && ctx.measureText(next.trimEnd()).width > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
        // a single word longer than the line: break it
        while (ctx.measureText(line).width > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

let measureCtx: Ctx | null = null;

/** A context for measuring text when no canvas is at hand. */
export function measuringContext(): Ctx {
  if (!measureCtx) {
    const ctx = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(4, 4).getContext("2d") : createEl("canvas").getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    measureCtx = ctx;
  }
  return measureCtx;
}

/** Text measured as the ink page draws it (for laying out Mermaid diagrams). */
export function inkTextMeasure(): TextMeasure {
  const ctx = measuringContext();
  return {
    measure: (text, size) => {
      ctx.font = fontFor(size);
      return ctx.measureText(text).width;
    },
    wrap: (text, width, size) => wrapText(ctx, text, width, size),
    lineHeight: TEXT_LINE_HEIGHT,
  };
}

/** Height of a text box's text. */
export function measureTextHeight(text: string, width: number, size: number): number {
  const lines = wrapText(measuringContext(), text, width, size);
  return Math.max(1, lines.length) * size * TEXT_LINE_HEIGHT;
}

export function drawText(ctx: Ctx, t: TextBox): void {
  ctx.save();
  ctx.fillStyle = t.color;
  ctx.textBaseline = "top";
  const lines = wrapText(ctx, t.text, t.w, t.size);
  const lh = t.size * TEXT_LINE_HEIGHT;
  const pad = (lh - t.size) / 2;
  const align = t.align ?? "left";
  ctx.textAlign = align;
  const x = align === "center" ? t.x + t.w / 2 : align === "right" ? t.x + t.w : t.x;
  lines.forEach((l, i) => ctx.fillText(l, x, t.y + i * lh + pad));
  ctx.restore();
}

// ------------------------------------------------------------------ images, links, figures

export function drawImageItem(ctx: Ctx, it: ImageItem, images: ImageSource): void {
  const img = images.image(it.src);
  if (img) {
    ctx.drawImage(img, it.x, it.y, it.w, it.h);
    return;
  }
  ctx.save();
  ctx.strokeStyle = "#9e9e9e";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(it.x, it.y, it.w, it.h);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A tappable link chip: "↗ Note name". */
export function drawLinkChip(ctx: Ctx, x: number, y: number, target: string, small = false): void {
  const h = small ? 24 : LINK_CHIP_HEIGHT;
  const w = small ? h : linkChipWidth(target);
  ctx.save();
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1a1a1a";
  ctx.stroke();
  // arrow icon
  const ix = x + h / 2;
  const iy = y + h / 2;
  const a = h * 0.18;
  ctx.beginPath();
  ctx.moveTo(ix - a, iy + a);
  ctx.lineTo(ix + a, iy - a);
  ctx.moveTo(ix - a * 0.2, iy - a);
  ctx.lineTo(ix + a, iy - a);
  ctx.lineTo(ix + a, iy + a * 0.2);
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
  if (!small) {
    ctx.fillStyle = "#1a1a1a";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(h * 0.5)}px ${TEXT_FONT}`;
    let label = linkLabel(target);
    if (label.length > 32) label = `${label.slice(0, 31)}…`;
    ctx.fillText(label, x + h * 0.95, y + h / 2 + 1, w - h * 1.2);
  }
  ctx.restore();
}

export function drawLink(ctx: Ctx, l: LinkItem): void {
  drawLinkChip(ctx, l.x, l.y, l.target);
}

/** Where the link badge of a handwritten link sits: just right of the stroke's top. */
export function handLinkBadge(s: Stroke): Rect {
  const r = strokePointBounds(s);
  return { x: r.x + r.w + 4, y: r.y - 16, w: 24, h: 24 };
}

export function drawFigure(ctx: Ctx, f: Figure): void {
  ctx.save();
  ctx.strokeStyle = "#7a7a7a";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(f.x, f.y, f.w, f.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#7a7a7a";
  ctx.font = `600 14px ${TEXT_FONT}`;
  ctx.textBaseline = "bottom";
  ctx.fillText("Figure", f.x + 2, f.y - 3);
  ctx.restore();
}

// ------------------------------------------------------------------ pages

export interface PageRenderOptions {
  images: ImageSource;
  /** Pixels per page unit. */
  pixelScale: number;
  /** Only items touching this rectangle (page units) are drawn. */
  clip?: Rect | null;
  /** Items not to draw (being moved or edited). */
  hide?: ReadonlySet<string>;
  /** Handwritten links (stroke id → target) get a small link badge. */
  handLinks?: Readonly<Record<string, string>>;
  /** Draw the background (paper, PDF page, image). */
  background?: boolean;
  /** Draw the paper lines. */
  lines?: boolean;
  /** Draw figure outlines and link chips (not in exports of the ink only). */
  chrome?: boolean;
}

/** Draw a page; the context's transform must map page units to pixels. */
export function drawPage(ctx: Ctx, page: Page, opts: PageRenderOptions): void {
  const clip = opts.clip ?? null;
  const hide = opts.hide;
  const visible = (r: Rect) => !clip || intersects(r, clip);
  if (opts.background !== false) drawBackground(ctx, page, { pixelScale: opts.pixelScale, images: opts.images, lines: opts.lines });
  for (const it of page.images) if (!hide?.has(it.id) && visible(imageBounds(it))) drawImageItem(ctx, it, opts.images);
  // fills underneath everything written, then highlighters, then the ink
  for (const s of page.strokes) if (s.fill && !hide?.has(s.id) && visible(strokeBounds(s))) drawStrokeFill(ctx, s);
  for (const s of page.strokes) if (isMarker(s) && !hide?.has(s.id) && visible(strokeBounds(s))) drawStrokeLine(ctx, s);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of page.strokes) if (!isMarker(s) && !s.area && !hide?.has(s.id) && visible(strokeBounds(s))) drawStrokeLine(ctx, s);
  ctx.restore();
  for (const t of page.texts) if (!hide?.has(t.id) && visible(textBounds(t))) drawText(ctx, t);
  if (opts.chrome !== false) {
    for (const f of page.figures) if (!hide?.has(f.id) && visible(figureBounds(f))) drawFigure(ctx, f);
    for (const l of page.links) if (!hide?.has(l.id) && visible(linkBounds(l))) drawLink(ctx, l);
    if (opts.handLinks) {
      for (const s of page.strokes) {
        const target = opts.handLinks[s.id];
        if (!target || hide?.has(s.id)) continue;
        const b = handLinkBadge(s);
        if (visible(b)) drawLinkChip(ctx, b.x, b.y, target, true);
      }
    }
  }
}

/** Draw loose items (a library item, items being placed) in the order of a page: fills, highlighters, ink, text. */
export function drawItems(ctx: Ctx, items: Pick<Items, "strokes" | "texts">): void {
  for (const s of items.strokes) drawStrokeFill(ctx, s);
  for (const s of items.strokes) if (isMarker(s)) drawStrokeLine(ctx, s);
  for (const s of items.strokes) if (!isMarker(s)) drawStrokeLine(ctx, s);
  for (const t of items.texts) drawText(ctx, t);
}

/** Render a page into a new canvas `pixelWidth` wide (thumbnails, exports). */
export function renderPageCanvas(page: Page, pixelWidth: number, opts: Omit<PageRenderOptions, "pixelScale">): HTMLCanvasElement {
  const k = pixelWidth / page.w;
  const canvas = createEl("canvas");
  canvas.width = Math.max(1, Math.round(page.w * k));
  canvas.height = Math.max(1, Math.round(page.h * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawPage(ctx, page, { ...opts, pixelScale: k });
  return canvas;
}
