import { DEFAULT_PAPER, isPaperStyle, normalizePaperSpec, type PaperSpec } from "./core/paper";
import { cleanSubfolder } from "./core/folders";
import { PENS } from "./core/ink/pens";
import { FILL_STYLES, PEN_TYPES } from "./core/ink/model";
import { SHAPES, type ShapeKind } from "./core/ink/shapes";
import { DEFAULT_TOOL_STATE, type FitMode, type PenButtonAction, type ToolState, type WritingPen } from "./ink/types";
import type { ToolbarPosition } from "./ink/ui/toolbar";

export type AzureApi = "auto" | "v4" | "v3.2";
export type EinkMode = "auto" | "on" | "off";
/** Chrome's low-latency canvas for the ink page; auto: not on e-ink screens. */
export type LowLatencyMode = "auto" | "on" | "off";
/** Instant ink through the Ink Notebook Bridge app; auto: on Boox tablets. */
export type FastInkMode = "auto" | "on" | "off";
export type BookmarkPosition = "top" | "middle" | "bottom";
export type TextViewMode = "reading" | "editing" | "keep";
export type DiagramSensitivity = "low" | "normal" | "high";
/** current: the folder of the note you are in; fixed: always `folder`; ask: choose for every page. */
export type PageLocation = "current" | "fixed" | "ask";
/** What new daily notes get: nothing, an ink page, or an ink page that opens right away. */
export type DailyInk = "off" | "attach" | "open";

export const DAILY_INK_OPTIONS: Record<DailyInk, string> = {
  off: "Without an ink page",
  attach: "With an ink page",
  open: "With an ink page, opened to write on",
};

export interface InkSettings {
  /** Setup wizard completed (or dismissed). */
  setupDone: boolean;

  // ---- pages ----
  pageLocation: PageLocation;
  /** Folder for new pages when pageLocation is "fixed" (and when no note is open). */
  folder: string;
  /** Subfolder (of the text page's folder) for the drawings and paper files; "" = next to the text page. */
  inkSubfolder: string;
  /** Paper for new pages. */
  paper: PaperSpec;
  /** Show the paper picker when creating a page. */
  askForPaper: boolean;
  textViewMode: TextViewMode;
  /** Ask for the name of a new page (the date and time is suggested); otherwise it is named with the date and time. */
  askForPageName: boolean;
  keepNamesInSync: boolean;
  dailyInk: DailyInk;

  // ---- handwriting recognition ----
  azureEndpoint: string;
  azureKey: string;
  azureApi: AzureApi;
  /** API detected by "auto" (remembered so we do not probe every time). */
  azureDetectedApi: "" | "v4" | "v3.2";
  azureLanguage: string;
  requestsPerMinute: number;
  transcribeTimeoutSec: number;
  autoTranscribe: boolean;
  /** Highlight words the recognition is unsure about with ==…== (opt-in). */
  highlightUncertain: boolean;
  uncertainThreshold: number;
  diagramSensitivity: DiagramSensitivity;
  /** Make handwritten [[links]] clickable on the ink page. */
  linkHandwriting: boolean;

  // ---- writing (the ink page) ----
  /** The selected tool, pens, colours and sizes (remembered between sessions). */
  tools: ToolState;
  /** Fingers draw (otherwise they turn pages, pan and zoom). */
  fingerDrawing: boolean;
  /** What holding the pen's side button does. */
  sideButton: PenButtonAction;
  pressure: boolean;
  twoFingerUndo: boolean;
  threeFingerRedo: boolean;
  swipePages: boolean;
  scribbleErase: boolean;
  holdToShape: boolean;
  fit: FitMode;
  toolbarPosition: ToolbarPosition;
  lowLatency: LowLatencyMode;
  /** Instant ink on Boox tablets with the Ink Notebook Bridge app. */
  fastInk: FastInkMode;
  /** How long after lifting the pen the firmware's ink gives way to the page's own drawing (ms). */
  fastInkRefreshMs: number;

  // ---- display ----
  einkMode: EinkMode;
  bookmarkPosition: BookmarkPosition;
  largeTouchTargets: boolean;

  // ---- pdf ----
  pdfMaxPagesWithoutAsking: number;
  /** Folder for papers imported from arXiv (their text pages; PDF and ink page go into its ink subfolder). */
  papersFolder: string;

  // ---- object libraries ----
  /** Folder for imported Excalidraw libraries and "My library". */
  libraryFolder: string;
  /** The library shown last in the library panel. */
  lastLibrary: string;

  // ---- internal ----
  /** Drawing paths waiting for handwriting recognition (offline queue). */
  queue: string[];
  /** Version of the stored settings, for one-time migrations in loadSettings. */
  settingsVersion: number;
}

export const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS: InkSettings = {
  setupDone: false,
  pageLocation: "current",
  folder: "Ink",
  inkSubfolder: "Attachments",
  paper: DEFAULT_PAPER,
  askForPaper: true,
  textViewMode: "reading",
  askForPageName: true,
  keepNamesInSync: true,
  dailyInk: "off",

  azureEndpoint: "",
  azureKey: "",
  azureApi: "auto",
  azureDetectedApi: "",
  azureLanguage: "",
  requestsPerMinute: 18,
  transcribeTimeoutSec: 15,
  autoTranscribe: false,
  highlightUncertain: false,
  uncertainThreshold: 0.6,
  diagramSensitivity: "normal",
  linkHandwriting: true,

  tools: DEFAULT_TOOL_STATE,
  fingerDrawing: false,
  sideButton: "eraser",
  pressure: true,
  twoFingerUndo: true,
  threeFingerRedo: true,
  swipePages: true,
  scribbleErase: true,
  holdToShape: true,
  fit: "page",
  toolbarPosition: "top",
  lowLatency: "auto",
  fastInk: "auto",
  fastInkRefreshMs: 800,

  einkMode: "auto",
  bookmarkPosition: "top",
  largeTouchTargets: true,

  pdfMaxPagesWithoutAsking: 30,
  papersFolder: "Papers",

  libraryFolder: "Ink libraries",
  lastLibrary: "",

  queue: [],
  settingsVersion: SETTINGS_VERSION,
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Merge stored data with defaults, validating every field (corrupt data must never break the plugin). */
export function loadSettings(raw: unknown): InkSettings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // data from before version 2 has no settingsVersion
  const version = numberIn(r.settingsVersion, 1, SETTINGS_VERSION, 1);
  return {
    setupDone: bool(r.setupDone, d.setupDone),
    pageLocation: oneOf(r.pageLocation, ["current", "fixed", "ask"] as const, d.pageLocation),
    folder: str(r.folder, d.folder).replace(/^\/+|\/+$/g, ""),
    inkSubfolder: cleanSubfolder(str(r.inkSubfolder, d.inkSubfolder)),
    // older versions stored only the style
    paper: normalizePaperSpec(r.paper ?? (isPaperStyle(r.paperStyle) ? { style: r.paperStyle } : undefined), d.paper),
    askForPaper: bool(r.askForPaper, d.askForPaper),
    textViewMode: oneOf(r.textViewMode, ["reading", "editing", "keep"] as const, d.textViewMode),
    // Before version 4 new pages were named with the date and time unless this was turned on;
    // choosing the name is the default now, so earlier data starts with it on.
    askForPageName: version >= 4 ? bool(r.askForPageName, d.askForPageName) : d.askForPageName,
    keepNamesInSync: bool(r.keepNamesInSync, d.keepNamesInSync),
    dailyInk: oneOf(r.dailyInk, ["off", "attach", "open"] as const, d.dailyInk),

    azureEndpoint: str(r.azureEndpoint, d.azureEndpoint).trim(),
    azureKey: str(r.azureKey, d.azureKey).trim(),
    azureApi: oneOf(r.azureApi, ["auto", "v4", "v3.2"] as const, d.azureApi),
    azureDetectedApi: oneOf(r.azureDetectedApi, ["", "v4", "v3.2"] as const, d.azureDetectedApi),
    azureLanguage: str(r.azureLanguage, d.azureLanguage).trim(),
    requestsPerMinute: numberIn(r.requestsPerMinute, 1, 600, d.requestsPerMinute),
    transcribeTimeoutSec: numberIn(r.transcribeTimeoutSec, 3, 120, d.transcribeTimeoutSec),
    autoTranscribe: bool(r.autoTranscribe, d.autoTranscribe),
    // Version 1 highlighted uncertain words by default, which looked like highlights nobody made;
    // it is opt-in now, so earlier data starts with it off.
    highlightUncertain: version >= 2 && bool(r.highlightUncertain, d.highlightUncertain),
    uncertainThreshold: numberIn(r.uncertainThreshold, 0, 1, d.uncertainThreshold),
    diagramSensitivity: oneOf(r.diagramSensitivity, ["low", "normal", "high"] as const, d.diagramSensitivity),
    linkHandwriting: bool(r.linkHandwriting, d.linkHandwriting),

    tools: loadTools(r.tools),
    fingerDrawing: bool(r.fingerDrawing, d.fingerDrawing),
    sideButton: oneOf(r.sideButton, ["eraser", "lasso", "none"] as const, d.sideButton),
    pressure: bool(r.pressure, d.pressure),
    twoFingerUndo: bool(r.twoFingerUndo, d.twoFingerUndo),
    threeFingerRedo: bool(r.threeFingerRedo, d.threeFingerRedo),
    swipePages: bool(r.swipePages, d.swipePages),
    scribbleErase: bool(r.scribbleErase, d.scribbleErase),
    holdToShape: bool(r.holdToShape, d.holdToShape),
    fit: oneOf(r.fit, ["page", "width"] as const, d.fit),
    toolbarPosition: oneOf(r.toolbarPosition, ["top", "bottom", "left", "right"] as const, d.toolbarPosition),
    // it was a switch, on by default: on becomes automatic (off on e-ink screens)
    lowLatency: r.lowLatency === false ? "off" : oneOf(r.lowLatency, ["auto", "on", "off"] as const, d.lowLatency),
    fastInk: oneOf(r.fastInk, ["auto", "on", "off"] as const, d.fastInk),
    fastInkRefreshMs: numberIn(r.fastInkRefreshMs, 200, 5000, d.fastInkRefreshMs),

    einkMode: oneOf(r.einkMode, ["auto", "on", "off"] as const, d.einkMode),
    bookmarkPosition: oneOf(r.bookmarkPosition, ["top", "middle", "bottom"] as const, d.bookmarkPosition),
    largeTouchTargets: bool(r.largeTouchTargets, d.largeTouchTargets),

    pdfMaxPagesWithoutAsking: numberIn(r.pdfMaxPagesWithoutAsking, 1, 1000, d.pdfMaxPagesWithoutAsking),
    papersFolder: str(r.papersFolder, d.papersFolder).replace(/^\/+|\/+$/g, "") || d.papersFolder,

    libraryFolder: str(r.libraryFolder, d.libraryFolder).replace(/^\/+|\/+$/g, "") || d.libraryFolder,
    lastLibrary: str(r.lastLibrary, d.lastLibrary),

    queue: Array.isArray(r.queue) ? r.queue.filter((q): q is string => typeof q === "string").slice(0, 500) : [],
    settingsVersion: SETTINGS_VERSION,
  };
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const WRITING_PENS = PEN_TYPES.filter((p): p is WritingPen => p !== "marker");

/** Tool state from stored data (anything unknown falls back to the defaults). */
export function loadTools(raw: unknown): ToolState {
  const d = DEFAULT_TOOL_STATE;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const color = (v: unknown, fallback: string) => (typeof v === "string" && COLOR_RE.test(v) ? v.toLowerCase() : fallback);
  const widths = { ...d.widths };
  const rw = (r.widths && typeof r.widths === "object" ? r.widths : {}) as Record<string, unknown>;
  for (const p of PEN_TYPES) widths[p] = numberIn(rw[p], 0.3, PENS[p].presets[4] * 2, d.widths[p]);
  const favs = Array.isArray(r.favorites) ? r.favorites : [];
  const favorites = d.favorites.map((f, i) => {
    const x = (favs[i] && typeof favs[i] === "object" ? favs[i] : {}) as Record<string, unknown>;
    return {
      pen: oneOf(x.pen, WRITING_PENS, f.pen),
      color: color(x.color, f.color),
      width: numberIn(x.width, 0.3, 40, f.width),
    };
  });
  return {
    // "stamp" needs the library item it places, which is not kept: it starts with the default tool
    tool: oneOf(r.tool, ["pen", "marker", "eraser", "lasso", "shape", "text", "fill"] as const, d.tool),
    pen: oneOf(r.pen, WRITING_PENS, d.pen),
    color: color(r.color, d.color),
    widths,
    markerColor: color(r.markerColor, d.markerColor),
    eraser: oneOf(r.eraser, ["partial", "stroke", "lasso"] as const, d.eraser),
    eraserSize: numberIn(r.eraserSize, 2, 80, d.eraserSize),
    shape: oneOf(r.shape, Object.keys(SHAPES) as ShapeKind[], d.shape),
    shapeFill: r.shapeFill === "" ? "" : color(r.shapeFill, d.shapeFill),
    fillColor: r.fillColor === "" ? "" : color(r.fillColor, d.fillColor),
    fillStyle: oneOf(r.fillStyle, FILL_STYLES, d.fillStyle),
    textSize: numberIn(r.textSize, 8, 120, d.textSize),
    favorites,
  };
}

export function isOcrConfigured(s: InkSettings): boolean {
  return !!s.azureEndpoint && !!s.azureKey;
}

export function classifyOptionsFor(s: InkSettings): { diagramGap: number; minDiagramSize: number } {
  switch (s.diagramSensitivity) {
    case "low":
      return { diagramGap: 20, minDiagramSize: 110 };
    case "high":
      return { diagramGap: 45, minDiagramSize: 40 };
    default:
      return { diagramGap: 30, minDiagramSize: 60 };
  }
}
