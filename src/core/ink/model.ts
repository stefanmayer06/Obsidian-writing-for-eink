import { DEFAULT_PAPER, normalizePaperSpec, paperSize, type PaperSpec } from "../paper";

/**
 * The ink notebook: a list of pages, like a notebook in the Boox Notes app.
 * Every page has a background (paper template, PDF page or image) and holds
 * strokes, text boxes, images, links and figures in page coordinates
 * (A4 portrait is 1000 × 1414 units).
 *
 * Everything is immutable: an edit creates new objects for what changed and
 * shares the rest. That makes undo a matter of keeping old documents, and lets
 * the renderer find what changed by comparing object identity.
 */

export type PenType = "fountain" | "ballpoint" | "pencil" | "brush" | "calligraphy" | "marker";

export const PEN_TYPES: readonly PenType[] = ["fountain", "ballpoint", "pencil", "brush", "calligraphy", "marker"];

/** How a fill is drawn: a solid colour, lines ("hatch") or crossed lines. */
export type FillStyle = "solid" | "hatch" | "cross";

export const FILL_STYLES: readonly FillStyle[] = ["solid", "hatch", "cross"];

export interface Stroke {
  readonly id: string;
  readonly pen: PenType;
  /** #rrggbb */
  readonly color: string;
  /** Base width in page units (the width at medium pressure). */
  readonly width: number;
  /** x, y, pressure (0..1) for every point, in page coordinates. */
  readonly pts: Float32Array;
  /** Straight segments between the points (shapes) instead of a smoothed curve. */
  readonly poly?: boolean;
  /** The outline is closed (rectangle, ellipse, …). */
  readonly closed?: boolean;
  /** An arrow head at the last point. */
  readonly arrow?: boolean;
  /** An arrow head at the first point too. */
  readonly arrowStart?: boolean;
  readonly dash?: boolean;
  /**
   * Fill colour (#rrggbb) of the area the stroke encloses. Fills are drawn
   * underneath all ink, like the highlighter, so they never hide writing.
   */
  readonly fill?: string;
  /** How the fill is drawn (solid when not set). */
  readonly fillStyle?: FillStyle;
  /** Only the fill is drawn, not the line (an area filled with the fill tool). */
  readonly area?: boolean;
  /** A connector: the shapes (stroke ids) its first and its last point are attached to. */
  readonly from?: string;
  readonly to?: string;
  /** A connector with right angles (it is routed that way when its shapes move). */
  readonly elbow?: boolean;
  /**
   * A connector drawn as a smooth curve, as Mermaid draws its links: when its
   * shapes move it is routed like an elbow connector and the bends are rounded
   * into a curve. Set together with `elbow`, so that versions without curves
   * route it with right angles.
   */
  readonly curve?: boolean;
}

export type TextAlign = "left" | "center" | "right";

export interface TextBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Width the text wraps at. */
  readonly w: number;
  /** Height of the laid-out text (measured when the text was edited). */
  readonly h: number;
  readonly text: string;
  /** Font size in page units. */
  readonly size: number;
  readonly color: string;
  /** Left when not set. */
  readonly align?: TextAlign;
  /** The label of a shape (stroke id): centred in it, moves with it. */
  readonly container?: string;
}

export interface ImageItem {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Vault path of the image. */
  readonly src: string;
}

/** A link to a note, shown as a tappable chip on the page. */
export interface LinkItem {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** Link text as in [[…]] (without the brackets). */
  readonly target: string;
}

/** An area the user marked as a figure: always embedded as a picture on the text page. */
export interface Figure {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type PageBackground =
  | { readonly kind: "paper"; readonly paper: PaperSpec }
  | { readonly kind: "pdf"; readonly path: string; readonly page: number }
  | { readonly kind: "image"; readonly path: string };

export interface Page {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly bg: PageBackground;
  readonly strokes: readonly Stroke[];
  readonly texts: readonly TextBox[];
  readonly images: readonly ImageItem[];
  readonly links: readonly LinkItem[];
  readonly figures: readonly Figure[];
}

export interface InkDoc {
  readonly pages: readonly Page[];
}

/** A diagram area used by the text page (`ink-figure` blocks), in page coordinates. */
export interface Region {
  readonly id: string;
  readonly page: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Data the plugin keeps for the text page. It is not part of the undo history:
 * undoing a stroke must not bring back an old diagram area.
 */
export interface InkMeta {
  readonly regions: readonly Region[];
  /** Handwritten links: stroke id → "[[target]]". */
  readonly handLinks: Readonly<Record<string, string>>;
}

export interface InkFile {
  readonly doc: InkDoc;
  readonly meta: InkMeta;
}

export const EMPTY_META: InkMeta = { regions: [], handLinks: {} };

// ------------------------------------------------------------------ ids

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Short random id (7 characters, ~42 bits). */
export function newId(length = 7): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let id = "";
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

// ------------------------------------------------------------------ creation

export function paperPage(paper: PaperSpec = DEFAULT_PAPER): Page {
  const spec = normalizePaperSpec(paper);
  const { width, height } = paperSize(spec);
  return emptyPage({ kind: "paper", paper: spec }, width, height);
}

export function emptyPage(bg: PageBackground, w: number, h: number): Page {
  return { id: newId(), w, h, bg, strokes: [], texts: [], images: [], links: [], figures: [] };
}

export function newDoc(paper: PaperSpec = DEFAULT_PAPER): InkDoc {
  return { pages: [paperPage(paper)] };
}

/** Quantise a coordinate to the stored precision (0.1 units), so what is drawn is what is saved. */
export function q(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Quantise a pressure to the stored precision (1/255). */
export function qp(p: number): number {
  return Math.round(Math.min(1, Math.max(0, p)) * 255) / 255;
}

const OPTIONAL_STROKE_FIELDS = ["poly", "closed", "arrow", "arrowStart", "dash", "fill", "fillStyle", "area", "from", "to", "elbow", "curve"] as const;

export function makeStroke(fields: Omit<Stroke, "id"> & { id?: string }): Stroke {
  const s: Stroke = { ...fields, id: fields.id ?? newId() };
  // drop false/undefined fields so equal strokes serialise equally
  const r = s as unknown as Record<string, unknown>;
  for (const k of OPTIONAL_STROKE_FIELDS) if (!r[k]) delete r[k];
  if (r.fillStyle === "solid" || !r.fill) delete r.fillStyle;
  return s;
}

/** A stroke with some fields changed (fields set to undefined/false are removed). */
export function withStroke(s: Stroke, patch: Partial<Omit<Stroke, "id">>): Stroke {
  return makeStroke({ ...s, ...patch });
}

/** A text box with some fields changed (fields set to undefined are removed). */
export function withText(t: TextBox, patch: Partial<Omit<TextBox, "id">>): TextBox {
  const out = { ...t, ...patch } as Record<string, unknown>;
  for (const k of ["align", "container"]) if (!out[k] || (k === "align" && out[k] === "left")) delete out[k];
  return out as unknown as TextBox;
}

export function pointCount(s: Stroke): number {
  return Math.floor(s.pts.length / 3);
}

// ------------------------------------------------------------------ immutable updates

export function pageIndex(doc: InkDoc, pageId: string): number {
  return doc.pages.findIndex((p) => p.id === pageId);
}

export function getPage(doc: InkDoc, pageId: string): Page | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

export function replacePage(doc: InkDoc, page: Page): InkDoc {
  const i = pageIndex(doc, page.id);
  if (i < 0) return doc;
  const pages = doc.pages.slice();
  pages[i] = page;
  return { ...doc, pages };
}

export function insertPage(doc: InkDoc, page: Page, index: number): InkDoc {
  const pages = doc.pages.slice();
  pages.splice(Math.max(0, Math.min(index, pages.length)), 0, page);
  return { ...doc, pages };
}

export function removePage(doc: InkDoc, pageId: string): InkDoc {
  if (doc.pages.length <= 1) return doc;
  return { ...doc, pages: doc.pages.filter((p) => p.id !== pageId) };
}

export function movePage(doc: InkDoc, pageId: string, to: number): InkDoc {
  const from = pageIndex(doc, pageId);
  if (from < 0) return doc;
  const pages = doc.pages.slice();
  const [p] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(to, pages.length)), 0, p);
  return { ...doc, pages };
}

/** A copy of a page with new ids for the page and everything on it. */
export function duplicatePage(page: Page): Page {
  return { ...page, id: newId(), ...cloneItems(page) };
}

/** Ids of every item on a page. */
export interface Selection {
  strokes: ReadonlySet<string>;
  texts: ReadonlySet<string>;
  images: ReadonlySet<string>;
  links: ReadonlySet<string>;
  figures: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { strokes: new Set(), texts: new Set(), images: new Set(), links: new Set(), figures: new Set() };

export function selectionSize(s: Selection): number {
  return s.strokes.size + s.texts.size + s.images.size + s.links.size + s.figures.size;
}

/** Remove the selected items from a page. */
export function removeItems(page: Page, sel: Selection): Page {
  if (selectionSize(sel) === 0) return page;
  return {
    ...page,
    strokes: sel.strokes.size ? page.strokes.filter((s) => !sel.strokes.has(s.id)) : page.strokes,
    texts: sel.texts.size ? page.texts.filter((t) => !sel.texts.has(t.id)) : page.texts,
    images: sel.images.size ? page.images.filter((i) => !sel.images.has(i.id)) : page.images,
    links: sel.links.size ? page.links.filter((l) => !sel.links.has(l.id)) : page.links,
    figures: sel.figures.size ? page.figures.filter((f) => !sel.figures.has(f.id)) : page.figures,
  };
}

/** The selected items of a page (in page order). */
export interface Items {
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  links: LinkItem[];
  figures: Figure[];
}

/** An item of an object library, as ink. */
export interface LibraryItem {
  id: string;
  name: string;
  items: Items;
  /** Drawn in the current pen colour and thickness when placed (the built-in shapes). */
  restyle?: boolean;
  /** A whole diagram: it may fill most of the page when placed (other items are made smaller sooner). */
  fitPage?: boolean;
}

export function pickItems(page: Page, sel: Selection): Items {
  return {
    strokes: page.strokes.filter((s) => sel.strokes.has(s.id)),
    texts: page.texts.filter((t) => sel.texts.has(t.id)),
    images: page.images.filter((i) => sel.images.has(i.id)),
    links: page.links.filter((l) => sel.links.has(l.id)),
    figures: page.figures.filter((f) => sel.figures.has(f.id)),
  };
}

export function itemsSelection(items: Items): Selection {
  return {
    strokes: new Set(items.strokes.map((s) => s.id)),
    texts: new Set(items.texts.map((t) => t.id)),
    images: new Set(items.images.map((i) => i.id)),
    links: new Set(items.links.map((l) => l.id)),
    figures: new Set(items.figures.map((f) => f.id)),
  };
}

/** Add items on top of a page. */
export function addItems(page: Page, items: Partial<Items>): Page {
  return {
    ...page,
    strokes: items.strokes?.length ? [...page.strokes, ...items.strokes] : page.strokes,
    texts: items.texts?.length ? [...page.texts, ...items.texts] : page.texts,
    images: items.images?.length ? [...page.images, ...items.images] : page.images,
    links: items.links?.length ? [...page.links, ...items.links] : page.links,
    figures: items.figures?.length ? [...page.figures, ...items.figures] : page.figures,
  };
}

/**
 * Replace items in place (same id → new version), keeping the stacking order.
 * Items whose id is not on the page are ignored.
 */
export function replaceItems(page: Page, items: Partial<Items>): Page {
  const swap = <T extends { id: string }>(list: readonly T[], repl: readonly T[] | undefined): readonly T[] => {
    if (!repl || repl.length === 0) return list;
    const byId = new Map(repl.map((r) => [r.id, r] as const));
    return list.map((x) => byId.get(x.id) ?? x);
  };
  return {
    ...page,
    strokes: swap(page.strokes, items.strokes),
    texts: swap(page.texts, items.texts),
    images: swap(page.images, items.images),
    links: swap(page.links, items.links),
    figures: swap(page.figures, items.figures),
  };
}

export type ItemLists = { readonly [K in keyof Items]: readonly Items[K][number][] };

/**
 * Copies of items with new ids (paste, duplicate, library items). Connectors
 * and labels stay attached to the copies of their shapes; attachments to
 * shapes that are not copied are dropped.
 */
export function cloneItems(items: ItemLists): Items {
  const ids = new Map<string, string>();
  for (const s of items.strokes) ids.set(s.id, newId());
  const relink = (id: string | undefined) => (id ? ids.get(id) : undefined);
  return {
    strokes: items.strokes.map((s) => {
      const c: Stroke = { ...s, id: ids.get(s.id) as string };
      return s.from || s.to ? withStroke(c, { from: relink(s.from), to: relink(s.to) }) : c;
    }),
    texts: items.texts.map((t) => (t.container ? withText({ ...t, id: newId() }, { container: relink(t.container) }) : { ...t, id: newId() })),
    images: items.images.map((i) => ({ ...i, id: newId() })),
    links: items.links.map((l) => ({ ...l, id: newId() })),
    figures: items.figures.map((f) => ({ ...f, id: newId() })),
  };
}
