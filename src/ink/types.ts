import type { FillStyle, PenType } from "../core/ink/model";
import type { ShapeKind } from "../core/ink/shapes";
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
  /** Two quick pens (like the Boox Notes' favourite pens). */
  favorites: Array<{ pen: WritingPen; color: string; width: number }>;
}

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
  favorites: [
    { pen: "fountain", color: "#000000", width: 1.8 },
    { pen: "ballpoint", color: "#d32f2f", width: 1.5 },
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
