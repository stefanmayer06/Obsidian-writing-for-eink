/**
 * Mermaid flowcharts (`flowchart TD` / `graph LR`, as written in Markdown
 * notes and on mermaid.live): the text is read into nodes with their shapes
 * and labels, links with their arrows and labels, subgraphs (nested), and the
 * styles given with `classDef`, `class`, `:::`, `style` and `linkStyle`.
 * fromMermaid.ts turns the result into ink.
 */

export type FlowDir = "TB" | "BT" | "LR" | "RL";

export type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "double-circle"
  | "small-circle"
  | "asymmetric"
  | "diamond"
  | "hexagon"
  | "lean-right"
  | "lean-left"
  | "trapezoid"
  | "trapezoid-top"
  | "document"
  | "delay";

/** CSS-like properties of `classDef`, `style` and `linkStyle` (colours as written). */
export interface MermaidStyle {
  fill?: string;
  stroke?: string;
  /** Text colour. */
  color?: string;
  /** In px. */
  strokeWidth?: number;
  dash?: boolean;
  /** In px. */
  fontSize?: number;
}

export interface MermaidNode {
  id: string;
  label: string;
  shape: NodeShape;
  classes: string[];
  style: MermaidStyle;
}

export type LinkStroke = "normal" | "dotted" | "thick" | "invisible";

/**
 * How links are drawn – Mermaid's `curve`: smooth curves (`basis`, Mermaid's
 * default, and its other curves), right angles (`step`, `stepBefore`,
 * `stepAfter`) or straight lines between the bends (`linear`).
 */
export type LinkCurve = "curve" | "step" | "linear";

/** Mermaid's name of a curve as a LinkCurve (null when it is not one). */
export function linkCurve(name: string | undefined): LinkCurve | null {
  const n = name?.trim().replace(/^curve/i, "").toLowerCase();
  if (!n || !/^[a-z]+$/.test(n)) return null;
  if (n === "linear") return "linear";
  if (n.startsWith("step")) return "step";
  return "curve";
}

export interface MermaidEdge {
  from: string;
  to: string;
  label: string;
  /** Arrow head at the start / at the end. */
  start: boolean;
  end: boolean;
  stroke: LinkStroke;
  /** Ranks the link spans at least (longer links: `--->`). */
  minlen: number;
  style: MermaidStyle;
  /** Its own curve (`linkStyle … interpolate …`), when it has one. */
  curve?: LinkCurve;
}

export interface MermaidSubgraph {
  id: string;
  title: string;
  parent: string | null;
  dir: FlowDir | null;
  /** Nodes and subgraphs in it, in the order they were written. */
  children: string[];
  classes: string[];
  style: MermaidStyle;
}

export interface MermaidFlowchart {
  dir: FlowDir;
  /** The title of the frontmatter. */
  title: string | null;
  /** How the links are drawn (`curve` of the frontmatter's config or of an init directive; curves when not given). */
  curve: LinkCurve;
  /** In the order they first appear. */
  nodes: Map<string, MermaidNode>;
  edges: MermaidEdge[];
  subgraphs: Map<string, MermaidSubgraph>;
  /** Nodes and subgraphs in no subgraph, in the order they first appear. */
  root: string[];
  classDefs: Map<string, MermaidStyle>;
}

export class MermaidError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "MermaidError";
  }
}

const OTHER_DIAGRAMS: Record<string, string> = {
  sequencediagram: "a sequence diagram",
  classdiagram: "a class diagram",
  "classdiagram-v2": "a class diagram",
  statediagram: "a state diagram",
  "statediagram-v2": "a state diagram",
  erdiagram: "an entity relationship diagram",
  journey: "a user journey",
  gantt: "a Gantt chart",
  pie: "a pie chart",
  quadrantchart: "a quadrant chart",
  requirementdiagram: "a requirement diagram",
  gitgraph: "a Git graph",
  mindmap: "a mind map",
  timeline: "a timeline",
  "sankey-beta": "a Sankey diagram",
  "xychart-beta": "an XY chart",
  "block-beta": "a block diagram",
  "packet-beta": "a packet diagram",
  "architecture-beta": "an architecture diagram",
  kanban: "a Kanban board",
  c4context: "a C4 diagram",
  zenuml: "a ZenUML diagram",
};

/** Is this text Mermaid (its first line names a diagram)? */
export function looksLikeMermaid(text: string): boolean {
  const first = stripFrontmatter(text)
    .text.split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("%%"));
  if (!first) return false;
  const word = first.split(/[\s;]/)[0].toLowerCase();
  return word === "flowchart" || word === "graph" || word === "flowchart-elk" || word in OTHER_DIAGRAMS;
}

/**
 * The Mermaid diagrams in a text: the ```mermaid code blocks of a Markdown
 * note, or the whole text when it is Mermaid itself.
 */
export function mermaidBlocks(text: string): string[] {
  const src = text.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  for (let m = fence.exec(src); m; m = fence.exec(src)) if (m[2].trim()) out.push(m[2].replace(/\s+$/, ""));
  if (out.length === 0 && looksLikeMermaid(src)) out.push(src.trim());
  return out;
}

/** The ```mermaid block of a Markdown text that the position `offset` is in (its code), or null. */
export function mermaidBlockAt(text: string, offset: number): string | null {
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[2].trim() ? m[2].replace(/\s+$/, "") : null;
  }
  return null;
}

/** A note holding one diagram. */
export function mermaidNote(code: string): string {
  return "```mermaid\n" + code.replace(/\r\n?/g, "\n").trim() + "\n```\n";
}

/** A note without its `index`-th ```mermaid block (null when it has no such block). */
export function removeMermaidBlock(text: string, index: number): string | null {
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$\n?/gm;
  let n = 0;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (!m[2].trim()) continue;
    if (n++ === index) return (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n");
  }
  return null;
}

function stripFrontmatter(text: string): { text: string; title: string | null; curve: LinkCurve | null } {
  const m = /^\s*---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { text, title: null, curve: null };
  const t = /^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  const title = t ? t[1].replace(/^(["'])(.*)\1$/, "$2").trim() || null : null;
  // config: / flowchart: / curve: linear
  const c = /^[ \t]*curve[ \t]*:[ \t]*["']?([A-Za-z]+)["']?[ \t]*(?:#.*)?$/m.exec(m[1]);
  // keep the lines, so that errors name the right line
  return { text: m[0].replace(/[^\n]/g, "") + text.slice(m[0].length), title, curve: linkCurve(c?.[1]) };
}

/** The curve of a directive: %%{init: {"flowchart": {"curve": "linear"}}}%% (the last one counts). */
function directiveCurve(text: string): LinkCurve | null {
  let out: LinkCurve | null = null;
  for (const d of text.matchAll(/%%\{([\s\S]*?)\}%%/g)) {
    const c = /["']?curve["']?\s*:\s*["']?([A-Za-z]+)/.exec(d[1]);
    out = linkCurve(c?.[1]) ?? out;
  }
  return out;
}

/**
 * A name for a diagram: the title of its frontmatter, else `fallback` (the
 * name of its note or file), else the title of the subgraph holding the most
 * nodes. Null when there is none.
 */
export function mermaidName(code: string, fallback?: string | null): string | null {
  const fm = stripFrontmatter(code.replace(/\r\n?/g, "\n")).title;
  if (fm) return fm;
  if (fallback?.trim()) return fallback.trim();
  try {
    const g = parseMermaid(code);
    const count = (id: string): number => g.subgraphs.get(id)?.children.reduce((n, c) => n + (g.subgraphs.has(c) ? count(c) : 1), 0) ?? 0;
    let best: { title: string; n: number } | null = null;
    for (const s of g.subgraphs.values()) {
      const title = s.title.replace(/\s+/g, " ").trim();
      const n = count(s.id);
      if (title && (!best || n > best.n)) best = { title, n };
    }
    return best?.title ?? null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ labels

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
  hash: "#",
  num: "#",
  semi: ";",
  colon: ":",
  comma: ",",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  lcub: "{",
  rcub: "}",
  vert: "|",
  times: "×",
  divide: "÷",
  rarr: "→",
  larr: "←",
  harr: "↔",
  uarr: "↑",
  darr: "↓",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  hearts: "♥",
};

function entity(name: string): string | null {
  if (/^x[0-9a-f]+$/i.test(name)) {
    const cp = parseInt(name.slice(1), 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  if (/^\d+$/.test(name)) {
    const cp = parseInt(name, 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  return NAMED_ENTITIES[name.toLowerCase()] ?? null;
}

/**
 * The text of a label as written: quotes removed, `<br/>` as line breaks,
 * other HTML and Markdown marks removed, entities (`#quot;`, `&amp;`, `#9829;`)
 * replaced, Font Awesome icons (`fa:fa-car`) left out.
 */
export function cleanLabel(raw: string): string {
  let t = raw.trim();
  let markdown = false;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  if (t.length >= 2 && t.startsWith("`") && t.endsWith("`")) {
    t = t.slice(1, -1);
    markdown = true;
  }
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/?[a-z][^<>]*>/gi, "");
  if (markdown) t = t.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2");
  t = t.replace(/\bfa[bsrl]?:fa-[\w-]+/g, "");
  t = t.replace(/#(\w+);/g, (m, name: string) => entity(name) ?? m);
  t = t.replace(/&#?(\w+);/g, (m, name: string) => entity(name) ?? m);
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// ------------------------------------------------------------------ styles

function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `fill:#f9f,stroke:#333,stroke-width:4px` as a style. */
export function parseStyle(text: string): MermaidStyle {
  const s: MermaidStyle = {};
  for (const part of splitTop(text.replace(/;+\s*$/, ""), ",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part
      .slice(i + 1)
      .replace(/!important/i, "")
      .trim();
    if (!value) continue;
    if (key === "fill" || key === "background" || key === "background-color") s.fill = value;
    else if (key === "stroke" || key === "border-color") s.stroke = value;
    else if (key === "color") s.color = value;
    else if (key === "stroke-width") {
      const n = parseFloat(value);
      if (Number.isFinite(n) && n >= 0) s.strokeWidth = n;
    } else if (key === "stroke-dasharray") s.dash = !/^(none|0(px)?)$/i.test(value);
    else if (key === "font-size") {
      const n = parseFloat(value);
      if (Number.isFinite(n) && n > 0) s.fontSize = n;
    }
  }
  return s;
}

// ------------------------------------------------------------------ statements

interface Stmt {
  text: string;
  line: number;
}

/** Split into statements: lines and `;`, not inside quotes, brackets or `@{…}`. */
function statements(src: string): Stmt[] {
  const out: Stmt[] = [];
  let cur = "";
  let line = 1;
  let start = 1;
  let quote = false;
  let markdown = false;
  let depth = 0;
  let meta = 0;
  const push = () => {
    if (cur.trim()) out.push({ text: cur.trim(), line: start });
    cur = "";
    depth = 0;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '"') {
        quote = false;
        markdown = false;
      } else if (ch === "\n") {
        line++;
        // a normal string ends with its line; a Markdown string (`"…"`) may go on
        if (!markdown) {
          quote = false;
          push();
          start = line;
          continue;
        }
      }
      cur += ch;
      continue;
    }
    if (ch === "%" && src[i + 1] === "%") {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === '"') {
      quote = true;
      markdown = src[i + 1] === "`";
      cur += ch;
      continue;
    }
    if (ch === "@" && src[i + 1] === "{") meta++;
    else if (ch === "}" && meta > 0) meta--;
    if (ch === "\n") {
      line++;
      if (meta > 0) {
        cur += "\n";
        continue;
      }
      push();
      start = line;
      continue;
    }
    if (ch === ";" && depth === 0 && meta === 0) {
      push();
      start = line;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    cur += ch;
  }
  push();
  return out;
}

const DIRS: Record<string, FlowDir> = { TB: "TB", TD: "TB", BT: "BT", LR: "LR", RL: "RL", ">": "LR", "<": "RL", "^": "BT", V: "TB" };

function dirOf(word: string | undefined): FlowDir | null {
  return word ? (DIRS[word.toUpperCase()] ?? null) : null;
}

// ------------------------------------------------------------------ nodes and links

const ID_RE = /^[\p{L}\p{N}_$](?:[\p{L}\p{N}_$]|-(?=[\p{L}\p{N}_$]))*/u;

const SHAPE_OPENERS: Array<{ open: string; close: Array<[string, NodeShape]> }> = [
  { open: "(((", close: [[")))", "double-circle"]] },
  { open: "((", close: [["))", "circle"]] },
  { open: "([", close: [["])", "stadium"]] },
  { open: "[[", close: [["]]", "subroutine"]] },
  { open: "[(", close: [[")]", "cylinder"]] },
  { open: "{{", close: [["}}", "hexagon"]] },
  {
    open: "[/",
    close: [
      ["/]", "lean-right"],
      ["\\]", "trapezoid"],
    ],
  },
  {
    open: "[\\",
    close: [
      ["\\]", "lean-left"],
      ["/]", "trapezoid-top"],
    ],
  },
  { open: ">", close: [["]", "asymmetric"]] },
  { open: "(", close: [[")", "round"]] },
  { open: "[", close: [["]", "rect"]] },
  { open: "{", close: [["}", "diamond"]] },
];

/** Shape names of the `A@{ shape: … }` syntax. */
const SHAPE_NAMES: Record<string, NodeShape> = {
  rect: "rect",
  rectangle: "rect",
  proc: "rect",
  process: "rect",
  rounded: "round",
  event: "round",
  stadium: "stadium",
  pill: "stadium",
  terminal: "stadium",
  "fr-rect": "subroutine",
  subproc: "subroutine",
  subprocess: "subroutine",
  subroutine: "subroutine",
  "framed-rectangle": "subroutine",
  cyl: "cylinder",
  cylinder: "cylinder",
  database: "cylinder",
  db: "cylinder",
  circle: "circle",
  circ: "circle",
  "dbl-circ": "double-circle",
  "double-circle": "double-circle",
  "fr-circ": "double-circle",
  stop: "double-circle",
  "sm-circ": "small-circle",
  "small-circle": "small-circle",
  start: "small-circle",
  "f-circ": "small-circle",
  junction: "small-circle",
  diam: "diamond",
  diamond: "diamond",
  decision: "diamond",
  question: "diamond",
  hex: "hexagon",
  hexagon: "hexagon",
  prepare: "hexagon",
  "lean-r": "lean-right",
  "lean-right": "lean-right",
  "in-out": "lean-right",
  "lean-l": "lean-left",
  "lean-left": "lean-left",
  "out-in": "lean-left",
  "trap-b": "trapezoid",
  trapezoid: "trapezoid",
  "trapezoid-bottom": "trapezoid",
  priority: "trapezoid",
  "trap-t": "trapezoid-top",
  "trapezoid-top": "trapezoid-top",
  "inv-trapezoid": "trapezoid-top",
  manual: "trapezoid-top",
  odd: "asymmetric",
  doc: "document",
  document: "document",
  delay: "delay",
  "half-rounded-rectangle": "delay",
};

interface NodeRef {
  id: string;
  label?: string;
  shape?: NodeShape;
  classes: string[];
}

interface LinkTok {
  stroke: LinkStroke;
  start: boolean;
  end: boolean;
  minlen: number;
  label: string;
}

class Cursor {
  i = 0;
  constructor(
    readonly s: string,
    readonly line: number,
  ) {}

  get rest(): string {
    return this.s.slice(this.i);
  }

  get done(): boolean {
    return this.i >= this.s.length;
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  fail(what: string): never {
    const near = this.s.slice(this.i, this.i + 24);
    throw new MermaidError(near ? `${what} (at “${near}”)` : what, this.line);
  }
}

/** Read up to one of the closing marks (a quoted text may hold anything). Returns the raw label and the mark found. */
function readLabel(c: Cursor, closers: string[]): { raw: string; close: string } {
  const startAt = c.i;
  let j = c.i;
  while (j < c.s.length && c.s[j] === " ") j++;
  if (c.s[j] === '"') {
    const endQuote = c.s.indexOf('"', j + 1);
    if (endQuote > 0) {
      let k = endQuote + 1;
      while (k < c.s.length && c.s[k] === " ") k++;
      const close = closers.find((cl) => c.s.startsWith(cl, k));
      if (close) {
        c.i = k + close.length;
        return { raw: c.s.slice(j, endQuote + 1), close };
      }
    }
  }
  let best = -1;
  let found = "";
  for (const cl of closers) {
    const k = c.s.indexOf(cl, startAt);
    if (k >= 0 && (best < 0 || k < best)) {
      best = k;
      found = cl;
    }
  }
  if (best < 0) c.fail(`The shape is not closed with ${closers.join(" or ")}`);
  c.i = best + found.length;
  return { raw: c.s.slice(startAt, best), close: found };
}

/** The settings of `A@{ shape: rect, label: "…" }`. */
function readMeta(c: Cursor): Record<string, string> {
  // at "@{"
  let depth = 0;
  let j = c.i + 1;
  let quote = false;
  for (; j < c.s.length; j++) {
    const ch = c.s[j];
    if (quote) {
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  if (j >= c.s.length) c.fail("The settings @{…} are not closed with }");
  const body = c.s.slice(c.i + 2, j);
  c.i = j + 1;
  const out: Record<string, string> = {};
  const re = /([\w-]+)\s*:\s*("(?:[^"])*"|[^,\n}]*)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1].toLowerCase()] = m[2].trim();
  return out;
}

function readClasses(c: Cursor, into: string[]): void {
  while (c.s.startsWith(":::", c.i)) {
    c.i += 3;
    const m = /^[\w-]+/.exec(c.rest);
    if (!m) c.fail("A class name is missing after :::");
    into.push(m[0]);
    c.i += m[0].length;
  }
}

function readNode(c: Cursor): NodeRef {
  c.ws();
  const m = ID_RE.exec(c.rest);
  if (!m) c.fail("A node is expected");
  const ref: NodeRef = { id: m[0], classes: [] };
  c.i += m[0].length;
  readClasses(c, ref.classes);
  if (c.s.startsWith("@{", c.i)) {
    const meta = readMeta(c);
    const shape = meta.shape?.replace(/^["']|["']$/g, "").toLowerCase();
    if (shape) ref.shape = SHAPE_NAMES[shape] ?? "rect";
    if (meta.label !== undefined) ref.label = cleanLabel(meta.label);
  } else {
    // the shape and its label; spaces may come before it
    let j = c.i;
    while (j < c.s.length && c.s[j] === " ") j++;
    const opener = SHAPE_OPENERS.find((o) => c.s.startsWith(o.open, j));
    if (opener && !(opener.open === ">" && j > c.i)) {
      c.i = j + opener.open.length;
      const { raw, close } = readLabel(
        c,
        opener.close.map(([cl]) => cl),
      );
      ref.shape = (opener.close.find(([cl]) => cl === close) as [string, NodeShape])[1];
      ref.label = cleanLabel(raw);
    }
  }
  readClasses(c, ref.classes);
  return ref;
}

function readGroup(c: Cursor): NodeRef[] {
  const out = [readNode(c)];
  for (;;) {
    const save = c.i;
    c.ws();
    if (c.s[c.i] !== "&") {
      c.i = save;
      return out;
    }
    c.i++;
    out.push(readNode(c));
  }
}

/** A link without text in it (`-->`, `-.->`, `==>`, `<-->`, `---`, `~~~`, …). */
function plainLink(rest: string): { len: number; tok: Omit<LinkTok, "label"> } | null {
  let j = 0;
  let start = false;
  if (rest[0] === "<" || /^[xo](?=--|==|-\.)/.test(rest)) {
    start = true;
    j = 1;
  }
  const body = rest.slice(j);
  let m: RegExpExecArray | null;
  if ((m = /^(-{2,})([>xo])/.exec(body))) return { len: j + m[0].length, tok: { stroke: "normal", start, end: true, minlen: m[1].length - 1 } };
  if ((m = /^-{3,}/.exec(body))) return { len: j + m[0].length, tok: { stroke: "normal", start, end: false, minlen: m[0].length - 2 } };
  if ((m = /^(={2,})([>xo])/.exec(body))) return { len: j + m[0].length, tok: { stroke: "thick", start, end: true, minlen: m[1].length - 1 } };
  if ((m = /^={3,}/.exec(body))) return { len: j + m[0].length, tok: { stroke: "thick", start, end: false, minlen: m[0].length - 2 } };
  if ((m = /^-(\.+)-([>xo])?/.exec(body))) return { len: j + m[0].length, tok: { stroke: "dotted", start, end: !!m[2], minlen: m[1].length } };
  if ((m = /^~{3,}/.exec(body))) return { len: j + m[0].length, tok: { stroke: "invisible", start: false, end: false, minlen: m[0].length - 2 } };
  return null;
}

/** A link with its text inside (`-- text -->`, `-. text .->`, `== text ==>`). */
function textLink(c: Cursor): LinkTok | null {
  const rest = c.rest;
  let j = 0;
  let start = false;
  if (rest[0] === "<" || /^[xo](?=--|==|-\.)/.test(rest)) {
    start = true;
    j = 1;
  }
  const m = /^(--|==|-\.)(?![-=>.])/.exec(rest.slice(j));
  if (!m) return null;
  const kind = m[1];
  let k = j + m[0].length;
  // the text may be quoted
  let from = k;
  while (from < rest.length && rest[from] === " ") from++;
  if (rest[from] === '"') {
    const close = rest.indexOf('"', from + 1);
    if (close > 0) from = close + 1;
  }
  const endRe = kind === "--" ? /(-{2,})([>xo])|-{3,}/g : kind === "==" ? /(={2,})([>xo])|={3,}/g : /\.(-+)([>xo])?/g;
  endRe.lastIndex = from;
  const e = endRe.exec(rest);
  if (!e) return null;
  const label = cleanLabel(rest.slice(k, e.index));
  k = e.index + e[0].length;
  c.i += k;
  if (kind === "-.") return { stroke: "dotted", start, end: !!e[2], minlen: Math.max(1, (e[1] ?? "-").length), label };
  const char = kind[0];
  const run = e[0].replace(/[>xo]$/, "");
  const head = e[0] !== run;
  return { stroke: char === "=" ? "thick" : "normal", start, end: head, minlen: Math.max(1, run.length - (head ? 1 : 2)), label };
}

function readLink(c: Cursor): LinkTok | null {
  c.ws();
  // an id of the link: A e1@--> B
  const id = /^[\p{L}\p{N}_]+@(?=[-=.~<xo])/u.exec(c.rest);
  if (id) c.i += id[0].length;
  const plain = plainLink(c.rest);
  let tok: LinkTok | null = null;
  if (plain) {
    c.i += plain.len;
    tok = { ...plain.tok, label: "" };
  } else tok = textLink(c);
  if (!tok) return null;
  // a label between bars: -->|text|
  const save = c.i;
  c.ws();
  if (c.s[c.i] === "|") {
    let j = c.i + 1;
    let quote = false;
    for (; j < c.s.length; j++) {
      if (c.s[j] === '"') quote = !quote;
      else if (c.s[j] === "|" && !quote) break;
    }
    if (j >= c.s.length) c.fail("The text of the link is not closed with |");
    tok.label = cleanLabel(c.s.slice(c.i + 1, j));
    c.i = j + 1;
  } else c.i = save;
  return tok;
}

// ------------------------------------------------------------------ the diagram

interface OpenSubgraph {
  sg: MermaidSubgraph;
  refs: string[];
}

/** Read a Mermaid flowchart. Throws MermaidError (naming the line) for what it cannot read. */
export function parseMermaid(code: string): MermaidFlowchart {
  const fm = stripFrontmatter(code.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
  const stmts = statements(fm.text);
  if (stmts.length === 0) throw new MermaidError("There is no diagram: the text is empty.");
  const head = stmts[0];
  const hm = /^(flowchart|graph|flowchart-elk)\b\s*(\S+)?\s*$/i.exec(head.text);
  if (!hm) {
    const word = head.text.split(/\s/)[0].toLowerCase();
    const kind = OTHER_DIAGRAMS[word];
    if (kind) throw new MermaidError(`This is ${kind}. Only flowcharts (“flowchart TD”, “graph LR”, …) can be turned into ink.`);
    throw new MermaidError("A Mermaid flowchart starts with “flowchart” or “graph” and its direction, e.g. “flowchart TD”.", head.line);
  }
  const g: MermaidFlowchart = {
    dir: dirOf(hm[2]) ?? "TB",
    title: fm.title,
    curve: directiveCurve(fm.text) ?? fm.curve ?? "curve",
    nodes: new Map(),
    edges: [],
    subgraphs: new Map(),
    root: [],
    classDefs: new Map(),
  };
  if (hm[2] && !dirOf(hm[2])) throw new MermaidError(`“${hm[2]}” is not a direction: use TD, TB, BT, LR or RL.`, head.line);

  const order = new Map<string, number>();
  const seen = (id: string) => {
    if (!order.has(id)) order.set(id, order.size);
  };
  const stack: OpenSubgraph[] = [];
  const closed: OpenSubgraph[] = [];
  const nodeStyles: Array<{ id: string; style: MermaidStyle }> = [];
  const classAssign: Array<{ ids: string[]; classes: string[] }> = [];
  const linkStyles: Array<{ which: "default" | number[]; style: MermaidStyle; curve: LinkCurve | null }> = [];
  let autoId = 0;

  const touch = (ref: NodeRef) => {
    seen(ref.id);
    stack[stack.length - 1]?.refs.push(ref.id);
    let n = g.nodes.get(ref.id);
    if (!n) {
      n = { id: ref.id, label: ref.id, shape: "rect", classes: [], style: {} };
      g.nodes.set(ref.id, n);
    }
    if (ref.label !== undefined) n.label = ref.label;
    if (ref.shape) n.shape = ref.shape;
    for (const cl of ref.classes) if (!n.classes.includes(cl)) n.classes.push(cl);
  };

  for (const st of stmts.slice(1)) {
    const t = st.text;
    let m: RegExpExecArray | null;
    if (/^subgraph\b/.test(t)) {
      const rest = t.slice(8).trim();
      let id: string;
      let title: string;
      if ((m = /^"([^"]*)"$/.exec(rest))) {
        id = `subgraph-${++autoId}`;
        title = cleanLabel(m[1]);
      } else if ((m = /^([^\s[]+)\s*\[(.*)\]$/.exec(rest))) {
        id = m[1];
        title = cleanLabel(m[2]);
      } else if (rest) {
        id = rest;
        title = cleanLabel(rest);
      } else {
        id = `subgraph-${++autoId}`;
        title = "";
      }
      if (g.subgraphs.has(id)) throw new MermaidError(`There are two subgraphs “${id}”.`, st.line);
      const parent = stack[stack.length - 1] ?? null;
      const sg: MermaidSubgraph = { id, title, parent: parent?.sg.id ?? null, dir: null, children: [], classes: [], style: {} };
      g.subgraphs.set(id, sg);
      seen(id);
      parent?.refs.push(id);
      stack.push({ sg, refs: [] });
      continue;
    }
    if (t === "end") {
      const open = stack.pop();
      if (!open) throw new MermaidError("“end” without a subgraph to end.", st.line);
      closed.push(open);
      continue;
    }
    if ((m = /^direction\s+(\S+)$/i.exec(t))) {
      const d = dirOf(m[1]);
      if (!d) throw new MermaidError(`“${m[1]}” is not a direction: use TB, BT, LR or RL.`, st.line);
      const top = stack[stack.length - 1];
      if (top) top.sg.dir = d;
      else g.dir = d;
      continue;
    }
    if ((m = /^classDef\s+(\S+)\s+(.+)$/.exec(t))) {
      const style = parseStyle(m[2]);
      for (const name of m[1].split(",")) if (name.trim()) g.classDefs.set(name.trim(), { ...g.classDefs.get(name.trim()), ...style });
      continue;
    }
    if ((m = /^class\s+(\S+)\s+(\S+)$/.exec(t))) {
      classAssign.push({ ids: m[1].split(",").filter(Boolean), classes: m[2].split(",").filter(Boolean) });
      continue;
    }
    if ((m = /^style\s+(\S+)\s+(.+)$/.exec(t))) {
      nodeStyles.push({ id: m[1], style: parseStyle(m[2]) });
      continue;
    }
    if ((m = /^linkStyle\s+(\S+)\s+(.+)$/.exec(t))) {
      const interpolate = /^interpolate\s+(\S+)\s*/.exec(m[2]);
      const style = parseStyle(interpolate ? m[2].slice(interpolate[0].length) : m[2]);
      const which = m[1] === "default" ? ("default" as const) : m[1].split(",").map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x >= 0);
      linkStyles.push({ which, style, curve: linkCurve(interpolate?.[1]) });
      continue;
    }
    if (/^(click|accTitle|accDescr|title)\b/.test(t)) continue;
    // settings of a link: e1@{ animate: true }
    if (/^[\p{L}\p{N}_]+@\{[\s\S]*\}$/u.test(t) && /\b(animate|animation|curve)\s*:/.test(t) && !/\b(shape|label)\s*:/.test(t)) continue;

    const c: Cursor = new Cursor(t, st.line);
    let left = readGroup(c);
    for (const r of left) touch(r);
    for (;;) {
      c.ws();
      if (c.done) break;
      const link = readLink(c);
      if (!link) c.fail("A link (like -->) or the end of the line is expected");
      c.ws();
      if (c.done) c.fail("The link has no node at its end");
      const right = readGroup(c);
      for (const r of right) touch(r);
      for (const a of left)
        for (const b of right)
          g.edges.push({ from: a.id, to: b.id, label: link.label, start: link.start, end: link.end, stroke: link.stroke, minlen: Math.max(1, link.minlen), style: {} });
      left = right;
    }
  }
  while (stack.length) closed.push(stack.pop() as OpenSubgraph);

  // ids of subgraphs used in links are the subgraphs, not nodes
  for (const id of g.subgraphs.keys()) g.nodes.delete(id);

  // a node belongs to the innermost subgraph it was written in (the first one to end)
  const claimed = new Set<string>();
  for (const open of closed) {
    const kids: string[] = [];
    for (const id of open.refs) {
      if (kids.includes(id) || id === open.sg.id) continue;
      const sub = g.subgraphs.get(id);
      if (sub) {
        if (sub.parent === open.sg.id) kids.push(id);
        continue;
      }
      if (claimed.has(id) || !g.nodes.has(id)) continue;
      claimed.add(id);
      kids.push(id);
    }
    open.sg.children = kids;
  }
  const top: string[] = [];
  for (const id of g.nodes.keys()) if (!claimed.has(id)) top.push(id);
  for (const sg of g.subgraphs.values()) if (!sg.parent) top.push(sg.id);
  g.root = top.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  for (const a of classAssign) {
    for (const id of a.ids) {
      const target = g.nodes.get(id) ?? g.subgraphs.get(id);
      if (target) for (const cl of a.classes) if (!target.classes.includes(cl)) target.classes.push(cl);
    }
  }
  for (const s of nodeStyles) {
    const target = g.nodes.get(s.id) ?? g.subgraphs.get(s.id);
    if (target) target.style = { ...target.style, ...s.style };
  }
  for (const l of linkStyles) {
    if (l.which === "default") {
      for (const e of g.edges) {
        e.style = { ...l.style, ...e.style };
        if (l.curve && !e.curve) e.curve = l.curve;
      }
    } else
      for (const i of l.which) {
        const e = g.edges[i];
        if (!e) continue;
        e.style = { ...e.style, ...l.style };
        if (l.curve) e.curve = l.curve;
      }
  }
  return g;
}
