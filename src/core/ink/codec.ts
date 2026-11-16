import { normalizePaperSpec } from "../paper";
import { splitFrontmatter } from "../transcript";
import {
  EMPTY_META,
  FILL_STYLES,
  makeStroke,
  newDoc,
  PEN_TYPES,
  type Figure,
  type ImageItem,
  type InkDoc,
  type InkFile,
  type InkMeta,
  type LinkItem,
  type Page,
  type PageBackground,
  type PenType,
  type Region,
  type Stroke,
  type TextAlign,
  type TextBox,
} from "./model";

/**
 * The ink page file (`Name.ink.md`). It is a Markdown file, so it syncs
 * everywhere, has frontmatter (the link to the text page) and its links show
 * up as backlinks:
 *
 *   ---
 *   ink-notebook: 1
 *   ink-text: "[[Folder/Name]]"
 *   ---
 *   ```ink-notebook               ← shows the pages when the file is embedded or read as Markdown
 *   …
 *   ```
 *   [[Linked note]] · [[photo.png]]   ← links on the pages (for backlinks and rename updates)
 *
 *   %%
 *   ```ink-data
 *   H {"v":1,"regions":[…],"handLinks":{…}}
 *   P {"id":"…","w":1000,"h":1414,"bg":{…}}
 *   S <id> <pen> <colour> <width> <flags> <points> [f:<fill> s:<fill style> a:<from> b:<to>]
 *   T {…text box…}
 *   ```
 *   %%
 *
 * One line per page and per item keeps the file compact and diffs readable.
 * Points are stored as delta-encoded integers (0.1 units, pressure in 1/255)
 * in base64url. Optional stroke fields follow the points as `key:value`
 * words, which earlier versions ignore (they show the stroke without them).
 */

export const INK_FRONTMATTER_KEY = "ink-notebook";
export const INK_DATA_LANG = "ink-data";
export const INK_PREVIEW_LANG = "ink-notebook";
export const FORMAT_VERSION = 1;

const PREVIEW_TEXT = "Handwritten pages – open this note with the Ink Notebook plugin to see and edit them.";

export class InkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InkParseError";
  }
}

const PEN_CODES: Record<PenType, string> = { fountain: "f", ballpoint: "b", pencil: "p", brush: "r", calligraphy: "c", marker: "m" };
const CODE_PENS: Record<string, PenType> = Object.fromEntries(PEN_TYPES.map((p) => [PEN_CODES[p], p]));

const FLAG_POLY = 1;
const FLAG_CLOSED = 2;
const FLAG_ARROW = 4;
const FLAG_DASH = 8;
const FLAG_AREA = 16;
const FLAG_ARROW_START = 32;
const FLAG_ELBOW = 64;
const FLAG_CURVE = 128;

const FILL_STYLE_CODES = { solid: "o", hatch: "h", cross: "x" } as const;

// ------------------------------------------------------------------ base64url

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;
// also accept standard base64
B64_INDEX["+".charCodeAt(0)] = 62;
B64_INDEX["/".charCodeAt(0)] = 63;

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[=\s]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) throw new InkParseError("Invalid point data");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

// ------------------------------------------------------------------ points

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

export function encodePoints(pts: Float32Array): string {
  const n = Math.floor(pts.length / 3);
  const bytes = new Uint8Array(n * 3 * 5 + 1);
  let o = 0;
  const put = (v: number) => {
    let u = zigzag(v);
    while (u >= 128) {
      bytes[o++] = (u % 128) | 128;
      u = Math.floor(u / 128);
    }
    bytes[o++] = u;
  };
  let px = 0;
  let py = 0;
  let pp = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.round(pts[i * 3] * 10);
    const y = Math.round(pts[i * 3 + 1] * 10);
    const p = Math.round(Math.min(1, Math.max(0, pts[i * 3 + 2])) * 255);
    put(x - px);
    put(y - py);
    put(p - pp);
    px = x;
    py = y;
    pp = p;
  }
  return toBase64Url(bytes.subarray(0, o));
}

export function decodePoints(text: string): Float32Array {
  const bytes = fromBase64Url(text);
  const values: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let u = 0;
    let mul = 1;
    for (;;) {
      if (i >= bytes.length) throw new InkParseError("Truncated point data");
      const b = bytes[i++];
      u += (b & 127) * mul;
      if (b < 128) break;
      mul *= 128;
      if (mul > 2 ** 35) throw new InkParseError("Invalid point data");
    }
    values.push(unzigzag(u));
  }
  if (values.length % 3 !== 0) throw new InkParseError("Point data has a wrong length");
  const pts = new Float32Array(values.length);
  let x = 0;
  let y = 0;
  let p = 0;
  for (let k = 0; k < values.length; k += 3) {
    x += values[k];
    y += values[k + 1];
    p += values[k + 2];
    pts[k] = x / 10;
    pts[k + 1] = y / 10;
    pts[k + 2] = p / 255;
  }
  return pts;
}

const encodedCache = new WeakMap<Stroke, string>();

function strokeLine(s: Stroke): string {
  let line = encodedCache.get(s);
  if (line === undefined) {
    const flags =
      (s.poly ? FLAG_POLY : 0) |
      (s.closed ? FLAG_CLOSED : 0) |
      (s.arrow ? FLAG_ARROW : 0) |
      (s.dash ? FLAG_DASH : 0) |
      (s.area ? FLAG_AREA : 0) |
      (s.arrowStart ? FLAG_ARROW_START : 0) |
      (s.elbow ? FLAG_ELBOW : 0) |
      (s.curve ? FLAG_CURVE : 0);
    line = `S ${s.id} ${PEN_CODES[s.pen] ?? "b"} ${s.color.replace(/^#/, "")} ${num(s.width)} ${flags} ${encodePoints(s.pts)}`;
    if (s.fill) line += ` f:${s.fill.replace(/^#/, "")}`;
    if (s.fill && s.fillStyle && s.fillStyle !== "solid") line += ` s:${FILL_STYLE_CODES[s.fillStyle]}`;
    if (s.from) line += ` a:${s.from}`;
    if (s.to) line += ` b:${s.to}`;
    encodedCache.set(s, line);
  }
  return line;
}

/** JSON for a data line. "%" is escaped: "%%" would end the Obsidian comment the data sits in. */
function json(v: unknown): string {
  return JSON.stringify(v).replace(/%/g, "\\u0025");
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// ------------------------------------------------------------------ validation helpers

const COLOR_RE = /^#?[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function color(v: unknown, fallback = "#000000"): string {
  return typeof v === "string" && COLOR_RE.test(v) ? (v.startsWith("#") ? v : `#${v}`).toLowerCase() : fallback;
}

function finite(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function id(v: unknown): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new InkParseError("Invalid id");
  return v;
}

function obj(line: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new InkParseError("Invalid line in the ink data");
}

function background(v: unknown): PageBackground {
  const b = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (b.kind === "pdf" && typeof b.path === "string") return { kind: "pdf", path: b.path, page: Math.max(1, Math.round(finite(b.page, 1))) };
  if (b.kind === "image" && typeof b.path === "string") return { kind: "image", path: b.path };
  return { kind: "paper", paper: normalizePaperSpec(b.paper) };
}

function region(v: unknown): Region | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.page !== "string") return null;
  return { id: r.id, page: r.page, x: finite(r.x), y: finite(r.y), w: finite(r.w), h: finite(r.h) };
}

// ------------------------------------------------------------------ parse / serialise

/** Find the ```ink-data block; returns the lines inside it, or null. */
function dataLines(body: string): string[] | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === "```" + INK_DATA_LANG);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === "```");
  if (end < 0) throw new InkParseError("The ink data block is not closed");
  return lines.slice(start + 1, end);
}

export interface ParsedInkFile extends InkFile {
  /** The frontmatter exactly as in the file (with its --- lines), kept on save. */
  frontmatter: string;
}

interface PageDraft {
  page: Omit<Page, "strokes" | "texts" | "images" | "links" | "figures">;
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  links: LinkItem[];
  figures: Figure[];
}

/**
 * Read an ink page file. A file without ink data (e.g. just created) is a new
 * notebook with one page; damaged data throws InkParseError (never guess: the
 * caller must not overwrite the file then).
 */
export function parseInkFile(text: string): ParsedInkFile {
  const { frontmatter, body } = splitFrontmatter(text.replace(/\r\n/g, "\n"));
  const lines = dataLines(body);
  if (!lines) return { frontmatter, doc: newDoc(), meta: EMPTY_META };
  let meta: InkMeta = EMPTY_META;
  const drafts: PageDraft[] = [];
  const cur = (): PageDraft => {
    const d = drafts[drafts.length - 1];
    if (!d) throw new InkParseError("Ink data without a page");
    return d;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0];
    const rest = line.slice(2);
    switch (kind) {
      case "H": {
        const h = obj(rest);
        if (finite(h.v, 1) > FORMAT_VERSION) throw new InkParseError("This page was saved by a newer version of Ink Notebook – please update the plugin.");
        const handLinks: Record<string, string> = {};
        if (h.handLinks && typeof h.handLinks === "object") {
          for (const [k, v] of Object.entries(h.handLinks as Record<string, unknown>)) if (typeof v === "string") handLinks[k] = v;
        }
        meta = { regions: Array.isArray(h.regions) ? h.regions.map(region).filter((r): r is Region => !!r) : [], handLinks };
        break;
      }
      case "P": {
        const p = obj(rest);
        drafts.push({
          page: { id: id(p.id), w: Math.max(10, finite(p.w, 1000)), h: Math.max(10, finite(p.h, 1414)), bg: background(p.bg) },
          strokes: [],
          texts: [],
          images: [],
          links: [],
          figures: [],
        });
        break;
      }
      case "S": {
        const f = rest.split(" ");
        if (f.length < 6) throw new InkParseError("Invalid stroke");
        const flags = parseInt(f[4], 10) || 0;
        const extra: Record<string, string> = {};
        for (const word of f.slice(6)) {
          const m = /^([a-z]+):(.+)$/.exec(word);
          if (m) extra[m[1]] = m[2];
        }
        const fill = extra.f && COLOR_RE.test(extra.f) ? color(extra.f) : undefined;
        const style = FILL_STYLES.find((st) => FILL_STYLE_CODES[st] === extra.s);
        const ref = (v: string | undefined) => (v && ID_RE.test(v) ? v : undefined);
        cur().strokes.push(
          makeStroke({
            id: id(f[0]),
            pen: CODE_PENS[f[1]] ?? "ballpoint",
            color: color(f[2]),
            width: Math.max(0.1, finite(parseFloat(f[3]), 1.5)),
            pts: decodePoints(f[5]),
            poly: !!(flags & FLAG_POLY),
            closed: !!(flags & FLAG_CLOSED),
            arrow: !!(flags & FLAG_ARROW),
            arrowStart: !!(flags & FLAG_ARROW_START),
            dash: !!(flags & FLAG_DASH),
            // an area is only its fill
            area: !!(flags & FLAG_AREA) && !!fill,
            elbow: !!(flags & FLAG_ELBOW),
            curve: !!(flags & FLAG_CURVE),
            fill,
            fillStyle: style,
            from: ref(extra.a),
            to: ref(extra.b),
          }),
        );
        break;
      }
      case "T": {
        const t = obj(rest);
        const box: TextBox = {
          id: id(t.id),
          x: finite(t.x),
          y: finite(t.y),
          w: Math.max(20, finite(t.w, 400)),
          h: Math.max(4, finite(t.h, 30)),
          text: str(t.text),
          size: Math.max(4, finite(t.size, 24)),
          color: color(t.color),
        };
        const align = (["center", "right"] as const).find((a: TextAlign) => a === t.align);
        const container = typeof t.container === "string" && ID_RE.test(t.container) ? t.container : undefined;
        cur().texts.push(align || container ? { ...box, ...(align ? { align } : {}), ...(container ? { container } : {}) } : box);
        break;
      }
      case "I": {
        const i = obj(rest);
        cur().images.push({ id: id(i.id), x: finite(i.x), y: finite(i.y), w: Math.max(1, finite(i.w, 100)), h: Math.max(1, finite(i.h, 100)), src: str(i.src) });
        break;
      }
      case "L": {
        const l = obj(rest);
        const target = str(l.target).trim();
        if (target) cur().links.push({ id: id(l.id), x: finite(l.x), y: finite(l.y), target });
        break;
      }
      case "F": {
        const g = obj(rest);
        cur().figures.push({ id: id(g.id), x: finite(g.x), y: finite(g.y), w: Math.max(1, finite(g.w)), h: Math.max(1, finite(g.h)) });
        break;
      }
      default:
        // lines of a newer version we do not know: ignore
        break;
    }
  }
  const pages: Page[] = drafts.map((d) => ({ ...d.page, strokes: d.strokes, texts: d.texts, images: d.images, links: d.links, figures: d.figures }));
  if (pages.length === 0) throw new InkParseError("The ink data has no pages");
  return { frontmatter, doc: { pages }, meta };
}

/** Links on the pages, for the Markdown part of the file (backlinks, rename updates). */
export function docLinks(doc: InkDoc, meta: InkMeta): string[] {
  const out = new Set<string>();
  for (const p of doc.pages) {
    if (p.bg.kind !== "paper") out.add(p.bg.path);
    for (const i of p.images) out.add(i.src);
    for (const l of p.links) out.add(l.target);
  }
  for (const v of Object.values(meta.handLinks)) {
    const m = /^\[\[([^\]]+)\]\]$/.exec(v);
    if (m) out.add(m[1]);
  }
  return [...out].filter((l) => l && !/[\n\]]/.test(l));
}

/** Frontmatter with the ink-notebook key (other properties are kept as they are). */
export function withInkFrontmatter(frontmatter: string, extra: Record<string, string> = {}): string {
  const set: Record<string, string> = { [INK_FRONTMATTER_KEY]: String(FORMAT_VERSION), ...extra };
  if (!frontmatter.trim()) {
    return `---\n${Object.entries(set)
      .map(([k, v]) => `${k}: ${v}\n`)
      .join("")}---\n`;
  }
  const lines = frontmatter.replace(/\n$/, "").split("\n");
  const close = lines.length - 1;
  for (const [k, v] of Object.entries(set)) {
    const i = lines.findIndex((l, n) => n > 0 && n < close && new RegExp(`^${k.replace(/[-]/g, "\\-")}\\s*:`).test(l));
    if (i >= 0) {
      if (k === INK_FRONTMATTER_KEY) continue; // keep whatever is there
      lines[i] = `${k}: ${v}`;
    } else lines.splice(lines.length - 1, 0, `${k}: ${v}`);
  }
  return `${lines.join("\n")}\n`;
}

export function serializeInkFile(frontmatter: string, file: InkFile): string {
  const { doc, meta } = file;
  const out: string[] = [];
  out.push(`H ${json({ v: FORMAT_VERSION, regions: meta.regions, handLinks: meta.handLinks })}`);
  for (const p of doc.pages) {
    out.push(`P ${json({ id: p.id, w: p.w, h: p.h, bg: p.bg })}`);
    for (const s of p.strokes) out.push(strokeLine(s));
    for (const t of p.texts) out.push(`T ${json(t)}`);
    for (const i of p.images) out.push(`I ${json(i)}`);
    for (const l of p.links) out.push(`L ${json(l)}`);
    for (const f of p.figures) out.push(`F ${json(f)}`);
  }
  const links = docLinks(doc, meta);
  const linkLine = links.length > 0 ? `${links.map((l) => `[[${l}]]`).join(" · ")}\n\n` : "";
  return (
    `${withInkFrontmatter(frontmatter)}` +
    "```" +
    `${INK_PREVIEW_LANG}\n${PREVIEW_TEXT}\n` +
    "```\n" +
    linkLine +
    "\n%%\n```" +
    `${INK_DATA_LANG}\n${out.join("\n")}\n` +
    "```\n%%\n"
  );
}

/**
 * Text written in a note that has the ink-notebook property but no ink data
 * yet (the property was added to a normal note): saving it as an ink page
 * would replace that text. "" when there is none.
 */
export function typedTextOf(text: string): string {
  const { body } = splitFrontmatter(text.replace(/\r\n/g, "\n"));
  try {
    if (dataLines(body) !== null) return "";
  } catch {
    return "";
  }
  const preview = new RegExp("^```" + INK_PREVIEW_LANG + "\\n[\\s\\S]*?\\n```\\s*$", "m");
  return body.replace(preview, "").trim();
}

/** The ink data part of a file (to tell real changes from frontmatter edits). */
export function inkDataOf(text: string): string {
  const { body } = splitFrontmatter(text.replace(/\r\n/g, "\n"));
  try {
    return (dataLines(body) ?? []).join("\n");
  } catch {
    return body;
  }
}
