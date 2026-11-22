import { Notice, normalizePath, TFile, type WorkspaceLeaf } from "obsidian";
import { BlendMode, degrees, LineCapStyle, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type InkNotebookPlugin from "../main";
import { normalizeRotation, parsePageRange, type PdfRotation } from "../core/pdfMath";
import { cleanSubfolder, homeFolder, joinPath } from "../core/folders";
import { emptyPage, insertPage, type InkDoc, type Page, type TextBox } from "../core/ink/model";
import { isMarker, linePattern, strokeRuns } from "../core/ink/pens";
import { fillGeometry } from "../core/ink/fill";
import { paperDrawing } from "../core/paper";
import { renderPageCanvas, TEXT_LINE_HEIGHT, wrapText, measuringContext, drawText } from "../ink/render";
import { FilePickModal, PdfImportModal } from "./modals";
import { FM_PDF } from "./pairs";
import type { InkView } from "./inkView";
import { IMAGE_EXTENSIONS } from "./inkView";

/**
 * PDFs and pictures, like in the Boox Notes app:
 *  - "Annotate PDF" makes a notebook whose pages are the PDF's pages (linked, not copied)
 *  - "Export annotated PDF" writes the original PDF with the ink drawn on top (as vectors;
 *    the PDF's text stays selectable)
 *  - "Export as PDF" writes the whole notebook, paper and all, as a PDF
 */

/** Width of a PDF/image page on the ink page, in page units (A4 paper is 1000 wide). */
const PAGE_W = 1000;
/** PDF points per page unit for paper pages (A4: 1000 units = 595 pt). */
const PT_PER_UNIT = 595.28 / 1000;

/** Exports go next to the text page (not into the ink subfolder). */
function exportFolder(plugin: InkNotebookPlugin, drawing: TFile): string {
  const text = plugin.pairs.textFor(drawing);
  if (text) return joinPath(text.parent?.path ?? "");
  return homeFolder(joinPath(drawing.parent?.path ?? ""), cleanSubfolder(plugin.settings.inkSubfolder));
}

async function writeBinary(plugin: InkNotebookPlugin, path: string, data: ArrayBuffer): Promise<TFile> {
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await plugin.app.vault.modifyBinary(existing, data);
    return existing;
  }
  return plugin.app.vault.createBinary(path, data);
}

function bytes(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** The pages of a PDF to use (asks for a range when it has many) and their sizes; null if cancelled. */
export async function pickPages(plugin: InkNotebookPlugin, pdf: TFile): Promise<{ pages: number[]; sizes: Map<number, { w: number; h: number }> } | null> {
  const info = await plugin.images.pdfInfo(pdf, []);
  const limit = plugin.settings.pdfMaxPagesWithoutAsking;
  let range = "all";
  if (info.count > limit) {
    const answer = await PdfImportModal.ask(plugin.app, pdf.basename, info.count, `1-${limit}`);
    if (answer === null) return null;
    range = answer;
  }
  const pages = parsePageRange(range, info.count);
  if (pages.length === 0) {
    new Notice("No pages selected.");
    return null;
  }
  const sizes = (await plugin.images.pdfInfo(pdf, pages)).sizes;
  return { pages, sizes };
}

/** Ink pages showing pages of a PDF. */
export function pdfPages(pdf: TFile, pages: number[], sizes: Map<number, { w: number; h: number }>): Page[] {
  return pages.map((n) => {
    const size = sizes.get(n) ?? { w: 595, h: 842 };
    return emptyPage({ kind: "pdf", path: pdf.path, page: n }, PAGE_W, Math.round((PAGE_W * size.h) / size.w));
  });
}

export async function annotatePdf(plugin: InkNotebookPlugin, file?: TFile | null, leaf?: WorkspaceLeaf): Promise<void> {
  const pdf = file ?? (await FilePickModal.pick(plugin.app, ["pdf"], "Choose a PDF to annotate…"));
  if (!pdf) return;
  const notice = new Notice(`Opening "${pdf.basename}"…`, 0);
  try {
    const picked = await pickPages(plugin, pdf);
    if (!picked) return;
    const doc: InkDoc = { pages: pdfPages(pdf, picked.pages, picked.sizes) };
    const created = await plugin.switcher.createPage({
      suggestedName: `${pdf.basename} (annotated)`,
      leaf,
      // the annotated notebook goes next to the PDF (when new pages go into the current folder)
      context: pdf,
      doc,
      extraTextFrontmatter: { [FM_PDF]: `[[${pdf.path}]]` },
    });
    if (created) new Notice(`Ready – write on the pages. "Export annotated PDF" saves a copy with your notes.`, 6000);
  } catch (e) {
    plugin.switcher.reportError("Could not open the PDF for annotation", e);
  } finally {
    notice.hide();
  }
}

/** Add pages of a PDF at the end of the open notebook. */
export async function appendPdfPages(plugin: InkNotebookPlugin, view: InkView): Promise<void> {
  const pdf = await FilePickModal.pick(plugin.app, ["pdf"], "Choose a PDF…");
  if (!pdf) return;
  try {
    await addPdfPages(plugin, view, pdf);
  } catch (e) {
    plugin.switcher.reportError("Could not add the PDF pages", e);
  }
}

/** Add the pages of `pdf` (asking which, for big ones) after the last page; false if cancelled. */
export async function addPdfPages(plugin: InkNotebookPlugin, view: InkView, pdf: TFile): Promise<boolean> {
  const picked = await pickPages(plugin, pdf);
  if (!picked) return false;
  const s = view.surface;
  let doc = s.document;
  for (const p of pdfPages(pdf, picked.pages, picked.sizes)) doc = insertPage(doc, p, doc.pages.length);
  const first = s.document.pages.length;
  s.commit(doc, "all");
  s.goTo(first);
  return true;
}

export async function annotateImage(plugin: InkNotebookPlugin, file?: TFile | null, leaf?: WorkspaceLeaf): Promise<void> {
  const img = file ?? (await FilePickModal.pick(plugin.app, IMAGE_EXTENSIONS, "Choose an image to annotate…"));
  if (!img) return;
  try {
    const size = (await plugin.images.imageSize(img.path)) ?? { w: 1000, h: 1414 };
    const h = Math.round((PAGE_W * size.h) / Math.max(1, size.w));
    await plugin.switcher.createPage({
      suggestedName: `${img.basename} (annotated)`,
      leaf,
      context: img,
      doc: { pages: [emptyPage({ kind: "image", path: img.path }, PAGE_W, h)] },
    });
  } catch (e) {
    plugin.switcher.reportError("Could not open the image for annotation", e);
  }
}

// ------------------------------------------------------------------ vector drawing into PDFs

function color(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Where page units go on a PDF page: origin, rotation and scale for drawSvgPath. */
interface Placement {
  x: number;
  y: number;
  rotate: number;
  scale: number;
}

/**
 * The placement that maps page units (top-left origin, y down, as displayed)
 * onto a PDF page with the given crop box and /Rotate.
 */
export function placement(crop: { x: number; y: number; width: number; height: number }, rotation: PdfRotation, scale: number): Placement {
  switch (rotation) {
    case 90:
      return { x: crop.x, y: crop.y, rotate: 90, scale };
    case 180:
      return { x: crop.x + crop.width, y: crop.y, rotate: 180, scale };
    case 270:
      return { x: crop.x + crop.width, y: crop.y + crop.height, rotate: 270, scale };
    default:
      return { x: crop.x, y: crop.y + crop.height, rotate: 0, scale };
  }
}

/** Map a point in page units to PDF user space (for text and images). */
function mapPoint(p: Placement, u: number, v: number): { x: number; y: number } {
  const a = u * p.scale;
  const b = -v * p.scale;
  const r = (p.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(r));
  const sin = Math.round(Math.sin(r));
  return { x: p.x + a * cos - b * sin, y: p.y + a * sin + b * cos };
}

function drawStrokes(out: PDFPage, page: Page, p: Placement): number {
  let n = 0;
  const at = { x: p.x, y: p.y, scale: p.scale, rotate: degrees(p.rotate) };
  // fills underneath everything written, like on the page
  for (const s of page.strokes) {
    const g = fillGeometry(s);
    if (!g) continue;
    if (g.area) out.drawSvgPath(g.area, { ...at, color: color(g.color), borderWidth: 0 });
    if (g.lines) out.drawSvgPath(g.lines, { ...at, borderColor: color(g.color), borderWidth: g.lineWidth, borderLineCap: LineCapStyle.Round });
    n++;
  }
  const strokes = [...page.strokes.filter(isMarker), ...page.strokes.filter((s) => !isMarker(s) && !s.area)];
  for (const s of strokes) {
    const marker = isMarker(s);
    for (const run of strokeRuns(s)) {
      out.drawSvgPath(run.d, {
        x: p.x,
        y: p.y,
        scale: p.scale,
        rotate: degrees(p.rotate),
        borderColor: color(run.color),
        borderWidth: run.w,
        borderLineCap: LineCapStyle.Round,
        borderDashArray: !run.head && (s.dash || s.dot) ? linePattern(s) : undefined,
        blendMode: marker ? BlendMode.Multiply : undefined,
      });
      n++;
    }
  }
  return n;
}

/** A picture of a text box (for text the PDF standard fonts cannot write). */
async function textImage(doc: PDFDocument, t: TextBox): Promise<{ png: Awaited<ReturnType<PDFDocument["embedPng"]>>; w: number; h: number }> {
  const k = 3;
  const canvas = createEl("canvas");
  canvas.width = Math.ceil(t.w * k);
  canvas.height = Math.ceil(t.h * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.setTransform(k, 0, 0, k, -t.x * k, -t.y * k);
  drawText(ctx, t);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Could not encode the text");
  return { png: await doc.embedPng(new Uint8Array(await blob.arrayBuffer())), w: t.w, h: t.h };
}

async function drawTexts(doc: PDFDocument, out: PDFPage, page: Page, p: Placement, font: PDFFont): Promise<void> {
  const ctx = measuringContext();
  for (const t of page.texts) {
    const lines = wrapText(ctx, t.text, t.w, t.size);
    const lh = t.size * TEXT_LINE_HEIGHT;
    try {
      lines.forEach((line, i) => {
        const free = t.w - font.widthOfTextAtSize(line, t.size);
        const dx = t.align === "center" ? free / 2 : t.align === "right" ? free : 0;
        // baseline: the canvas draws text from its top with the em box centred in the line
        const pos = mapPoint(p, t.x + dx, t.y + i * lh + (lh - t.size) / 2 + t.size * 0.8);
        out.drawText(line, { x: pos.x, y: pos.y, size: t.size * p.scale, font, color: color(t.color), rotate: degrees(p.rotate) });
      });
    } catch {
      // characters the standard font cannot encode: draw the text as a picture
      const img = await textImage(doc, t);
      const pos = mapPoint(p, t.x, t.y + t.h);
      out.drawImage(img.png, { x: pos.x, y: pos.y, width: img.w * p.scale, height: img.h * p.scale, rotate: degrees(p.rotate) });
    }
  }
}

async function drawImages(plugin: InkNotebookPlugin, doc: PDFDocument, out: PDFPage, page: Page, p: Placement): Promise<void> {
  for (const it of page.images) {
    const file = plugin.app.vault.getAbstractFileByPath(it.src);
    if (!(file instanceof TFile)) continue;
    let embedded;
    try {
      const data = await plugin.app.vault.readBinary(file);
      const ext = file.extension.toLowerCase();
      if (ext === "png") embedded = await doc.embedPng(data);
      else if (ext === "jpg" || ext === "jpeg") embedded = await doc.embedJpg(data);
    } catch {
      embedded = undefined;
    }
    if (!embedded) {
      // other formats: through a canvas
      const img = plugin.images.image(it.src);
      if (!img) continue;
      const c = createEl("canvas");
      c.width = Math.max(1, Math.round(it.w * 2));
      c.height = Math.max(1, Math.round(it.h * 2));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) continue;
      embedded = await doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
    }
    const pos = mapPoint(p, it.x, it.y + it.h);
    out.drawImage(embedded, { x: pos.x, y: pos.y, width: it.w * p.scale, height: it.h * p.scale, rotate: degrees(p.rotate) });
  }
}

/** Paper colour and lines as vectors. */
function drawPaper(out: PDFPage, page: Page, p: Placement): void {
  if (page.bg.kind !== "paper") return;
  const d = paperDrawing(page.bg.paper, { width: page.w, height: page.h });
  out.drawRectangle({ x: 0, y: 0, width: out.getWidth(), height: out.getHeight(), color: color(d.fill) });
  for (const path of d.paths) {
    out.drawSvgPath(path.d, {
      x: p.x,
      y: p.y,
      scale: p.scale,
      borderColor: color(path.stroke),
      borderWidth: path.width,
      borderLineCap: path.dots ? LineCapStyle.Round : LineCapStyle.Butt,
      borderDashArray: path.dots ? [0.01, path.dots.gap - 0.01] : undefined,
    });
  }
}

function activeView(plugin: InkNotebookPlugin, view?: InkView | null): InkView | null {
  if (view?.inkFile) return view;
  const v = plugin.app.workspace.getMostRecentLeaf()?.view as InkView | undefined;
  return v && "inkFile" in v && v.inkFile ? v : null;
}

/** The original PDF(s) with the ink of the pages drawn on top. */
export async function exportAnnotatedPdf(plugin: InkNotebookPlugin, view?: InkView | null): Promise<void> {
  const v = activeView(plugin, view);
  if (!v?.file) {
    new Notice("Open the annotated ink page first, then run this command again.");
    return;
  }
  const drawing = v.file;
  const pages = v.surface.document.pages;
  const byPdf = new Map<string, Page[]>();
  for (const p of pages) if (p.bg.kind === "pdf") byPdf.set(p.bg.path, [...(byPdf.get(p.bg.path) ?? []), p]);
  if (byPdf.size === 0) {
    new Notice('This ink page has no PDF pages. Use "Annotate a PDF" to start one.');
    return;
  }
  const notice = new Notice("Exporting annotated PDF…", 0);
  try {
    const written: TFile[] = [];
    for (const [pdfPath, refs] of byPdf) {
      const src = plugin.app.vault.getAbstractFileByPath(pdfPath);
      if (!(src instanceof TFile)) {
        new Notice(`The PDF "${pdfPath}" was not found – skipped.`);
        continue;
      }
      const doc = await PDFDocument.load(await plugin.app.vault.readBinary(src), { ignoreEncryption: true, updateMetadata: false });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      let annotated = 0;
      for (const page of refs) {
        if (page.bg.kind !== "pdf") continue;
        const n = page.bg.page;
        if (n < 1 || n > doc.getPageCount()) continue;
        if (page.strokes.length + page.texts.length + page.images.length === 0) continue;
        const out = doc.getPage(n - 1);
        const crop = out.getCropBox();
        const rotation = normalizeRotation(out.getRotation().angle);
        const displayedW = rotation === 90 || rotation === 270 ? crop.height : crop.width;
        const p = placement(crop, rotation, displayedW / page.w);
        await drawImages(plugin, doc, out, page, p);
        drawStrokes(out, page, p);
        await drawTexts(doc, out, page, p, font);
        annotated++;
      }
      if (annotated === 0) {
        new Notice(`No ink on the pages of "${src.basename}" yet – nothing to export.`);
        continue;
      }
      const path = normalizePath(joinPath(exportFolder(plugin, drawing), `${src.basename} (annotated).pdf`));
      written.push(await writeBinary(plugin, path, bytes(await doc.save())));
    }
    notice.hide();
    if (written.length > 0) {
      new Notice(`Saved ${written.map((f) => f.path).join(", ")}`, 8000);
      await plugin.app.workspace.getLeaf("tab").openFile(written[0]);
    }
  } catch (e) {
    notice.hide();
    plugin.switcher.reportError("Export failed", e);
  }
}

/** The whole notebook as a PDF: paper, PDF pages and pictures with the ink, as vectors. */
export async function exportNotebookPdf(plugin: InkNotebookPlugin, view?: InkView | null): Promise<void> {
  const v = activeView(plugin, view);
  if (!v?.file) return;
  const drawing = v.file;
  const notice = new Notice("Exporting the notebook as PDF…", 0);
  try {
    const out = await PDFDocument.create();
    out.setTitle(drawing.basename.replace(/\.ink$/, ""));
    out.setCreator("Ink Notebook for Obsidian");
    const font = await out.embedFont(StandardFonts.Helvetica);
    const sources = new Map<string, PDFDocument | null>();
    for (const page of v.surface.document.pages) {
      const W = page.w * PT_PER_UNIT;
      const H = page.h * PT_PER_UNIT;
      const pdfPage = out.addPage([W, H]);
      const p = placement({ x: 0, y: 0, width: W, height: H }, 0, PT_PER_UNIT);
      if (page.bg.kind === "paper") drawPaper(pdfPage, page, p);
      else if (page.bg.kind === "pdf") {
        let src = sources.get(page.bg.path);
        if (src === undefined) {
          const f = plugin.app.vault.getAbstractFileByPath(page.bg.path);
          src = f instanceof TFile ? await PDFDocument.load(await plugin.app.vault.readBinary(f), { ignoreEncryption: true }) : null;
          sources.set(page.bg.path, src);
        }
        if (src && page.bg.page <= src.getPageCount()) {
          const srcPage = src.getPage(page.bg.page - 1);
          const rot = normalizeRotation(srcPage.getRotation().angle);
          const [embedded] = await out.embedPages([srcPage]);
          // the embedded page is unrotated: turn it (clockwise by /Rotate) the way it is shown
          const turned = rot === 90 || rot === 270;
          const at = rot === 0 ? { x: 0, y: 0 } : rot === 90 ? { x: 0, y: H } : rot === 180 ? { x: W, y: H } : { x: W, y: 0 };
          pdfPage.drawPage(embedded, { x: at.x, y: at.y, width: turned ? H : W, height: turned ? W : H, rotate: degrees((360 - rot) % 360) });
        }
      } else {
        const f = plugin.app.vault.getAbstractFileByPath(page.bg.path);
        if (f instanceof TFile) {
          await drawImages(plugin, out, pdfPage, { ...page, images: [{ id: "bg", x: 0, y: 0, w: page.w, h: page.h, src: f.path }] }, p);
        }
      }
      await drawImages(plugin, out, pdfPage, page, p);
      drawStrokes(pdfPage, page, p);
      await drawTexts(out, pdfPage, page, p, font);
    }
    const path = normalizePath(joinPath(exportFolder(plugin, drawing), `${drawing.basename.replace(/\.ink$/, "")}.pdf`));
    const file = await writeBinary(plugin, path, bytes(await out.save()));
    notice.hide();
    new Notice(`Saved ${file.path}`, 6000);
    await plugin.app.workspace.getLeaf("tab").openFile(file);
  } catch (e) {
    notice.hide();
    plugin.switcher.reportError("Export failed", e);
  }
}

/** The page on screen as a PNG picture. */
export async function exportPageImage(plugin: InkNotebookPlugin, view?: InkView | null): Promise<void> {
  const v = activeView(plugin, view);
  if (!v?.file) return;
  const drawing = v.file;
  const s = v.surface;
  const page = s.page;
  try {
    let width = 2000;
    if (page.bg.kind === "image") {
      const img = plugin.images.image(page.bg.path) as HTMLImageElement | null;
      if (img?.naturalWidth) width = Math.max(1000, Math.min(4000, img.naturalWidth));
    }
    // make sure PDF/picture backgrounds are loaded at the export size
    if (page.bg.kind === "pdf") {
      for (let i = 0; i < 50 && !plugin.images.pdfPage(page.bg.path, page.bg.page, width); i++) await sleep(100);
    }
    const canvas = renderPageCanvas(page, width, { images: plugin.images, chrome: false });
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("Nothing was exported");
    const base = drawing.basename.replace(/\.ink$/, "");
    const path = normalizePath(joinPath(exportFolder(plugin, drawing), `${base} – page ${s.pageIndex + 1}.png`));
    const file = await writeBinary(plugin, path, await blob.arrayBuffer());
    new Notice(`Saved ${file.path}`);
    await plugin.app.workspace.getLeaf("tab").openFile(file);
  } catch (e) {
    plugin.switcher.reportError("Export failed", e);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

