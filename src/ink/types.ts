import type { FillStyle, PenType } from "../core/ink/model";
import type { ShapeKind } from "../core/ink/shapes";
import type { LineStyle } from "../core/ink/pens";
import { DEFAULT_PEN_PALETTE } from "../core/palette";
import type { ImageSource } from "./render";

/** "stamp" places an item of an object library (see InkSurface.stamp). */
export type ToolId = "pen" | "marker" | "eraser" | "lasso" | "shape" | "text" | "fill" | "stamp";
export type EraserMode = "partial" | "stroke" | "lasso";
export type WritingPen = Exclude<PenType, "marker">;

/** The selected tool and its options (remembered between sessions). */
export interface ToolState {
  tool: ToolId;
  pen: WritingPen;
  color: string;
  /** Current width of every pen (page units). */
  widths: Record<PenType, number>;
  markerColor: string;
  eraser: EraserMode;
  /** Eraser radius in page units. */
  eraserSize: number;
  shape: ShapeKind;
  /** Fill of new closed shapes ("" = none). */
  shapeFill: string;
  /** Colour of the fill tool ("" = it removes fills). */
  fillColor: string;
  /** How fills are drawn (the fill tool and new shapes). */
  fillStyle: FillStyle;
  /** Font size of new text boxes (page units). */
  textSize: number;
  /** Solid, dashed or dotted pen lines. */
  lineStyle: LineStyle;
  /**
   * Quick pens (like the Boox Notes' favourite pens): always MAX_FAVORITES of them;
   * the toolbar shows the first `favoriteCount` (see SurfaceSettings).
   */
  favorites: Array<{ pen: WritingPen; color: string; width: number }>;
}

/** The most favourite pens there can be; the fewest the toolbar shows. */
export const MAX_FAVORITES = 8;
/** About this many favourite pens fit on the toolbar; it scrolls sideways to the others. */
export const VISIBLE_FAVORITES = 4;
export const MIN_FAVORITES = 2;

export const DEFAULT_TOOL_STATE: ToolState = {
  tool: "pen",
  pen: "fountain",
  color: "#000000",
  widths: { fountain: 1.8, ballpoint: 1.5, pencil: 1.5, brush: 4, calligraphy: 4, marker: 16 },
  markerColor: "#ffe14d",
  eraser: "partial",
  eraserSize: 8,
  shape: "rect",
  shapeFill: "",
  fillColor: "#c4dfff",
  fillStyle: "solid",
  textSize: 24,
  lineStyle: "solid",
  favorites: [
    { pen: "fountain", color: "#000000", width: 1.8 },
    { pen: "ballpoint", color: "#d32f2f", width: 1.5 },
    { pen: "ballpoint", color: "#1565c0", width: 1.5 },
    { pen: "fountain", color: "#2e7d32", width: 1.8 },
    { pen: "pencil", color: "#4d4d4d", width: 1.5 },
    { pen: "brush", color: "#000000", width: 4 },
    { pen: "calligraphy", color: "#6a1b9a", width: 4 },
    { pen: "ballpoint", color: "#ef6c00", width: 1.5 },
  ],
};

export type PenButtonAction = "eraser" | "lasso" | "none";
export type FitMode = "page" | "width";

/** How the surface reacts to pen and fingers. */
export interface SurfaceSettings {
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
  /** Pages one below the other, scrolled through like a PDF reader (instead of turned one at a time). */
  continuous: boolean;
  /** Pens left out of the pen bar and the pen's options (at least one is always offered). */
  hiddenPens: WritingPen[];
  /** Tapping the pen or highlighter opens the floating pen bar (instead of the options card). */
  penBar: boolean;
  /** Where the pen bar was moved to: its top-left corner as fractions of the view (null: under the toolbar). */
  penBarPos: { x: number; y: number } | null;
  /** The pen bar's colours ("#rrggbb"; added with the colour picker, removed by holding one). */
  penColors: string[];
  /** How many thicknesses the pen bar shows (1–5, spread from thin to thick). */
  penBarSizes: number;
  /** How many favourite pens there are on the toolbar (MIN_FAVORITES … MAX_FAVORITES; more than VISIBLE_FAVORITES scroll). */
  favoriteCount: number;
  /** Low-latency canvas (Chrome's "desynchronized" mode). */
  lowLatency: boolean;
  /** White surroundings and no animations (e-ink). */
  eink: boolean;
}

export const DEFAULT_SURFACE_SETTINGS: SurfaceSettings = {
  fingerDrawing: false,
  sideButton: "eraser",
  pressure: true,
  twoFingerUndo: true,
  threeFingerRedo: true,
  swipePages: true,
  scribbleErase: true,
  holdToShape: true,
  fit: "page",
  continuous: false,
  favoriteCount: 2,
  hiddenPens: [],
  penBar: false,
  penBarPos: null,
  penColors: [...DEFAULT_PEN_PALETTE],
  penBarSizes: 5,
  lowLatency: true,
  eink: false,
};

/** A button in the bar above a lasso selection. */
export interface SelectionAction {
  id: string;
  icon: string;
  label: string;
  run(): void;
}

/** What the surface needs from the app around it. */
export interface SurfaceHost {
  images: ImageSource;
  /** Draw a Lucide icon into an element (Obsidian's setIcon). */
  icon(el: HTMLElement, name: string): void;
  openLink(target: string, newTab: boolean): void;
  /** Open a web or mail address (a link inside a PDF page); window.open when missing. */
  openUrl?(url: string): void;
  /** The notebook or its metadata changed (save soon). */
  changed(): void;
  pageChanged?(index: number, count: number): void;
  toolChanged?(state: ToolState): void;
  historyChanged?(canUndo: boolean, canRedo: boolean): void;
  selectionChanged?(count: number): void;
  /** Extra buttons for a lasso selection (e.g. "To text"). */
  selectionActions?(): SelectionAction[];
  notice?(message: string): void;
  /** The page was drawn again: zoom, scroll, size or page may have changed. */
  viewChanged?(): void;
  /** The pen touched the page (screen position in CSS pixels, and the event's time on the performance clock). */
  penDown?(clientX: number, clientY: number, timeStamp?: number): void;
  /** The last pen stroke was not ink after all (a link tap, a snapped shape, scribble erasing). */
  inkDiscarded?(): void;
  /**
   * The page was drawn again – not a pen stroke being written: all of it (`whole`: a page turn, undo,
   * zoom) or a part (erasing, a snapped shape).
   */
  pageRedrawn?(whole: boolean): void;
}
