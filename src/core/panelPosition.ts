/**
 * Where a floating panel (the pen bar) sits in its view. It is stored as
 * fractions of the view, so it stays in the same part of the screen when the
 * window or the tablet's orientation changes, and it is always kept inside.
 */

export interface PanelPos {
  /** The panel's left edge as a fraction of the view's width. */
  readonly x: number;
  /** Its top edge as a fraction of the view's height. */
  readonly y: number;
}

/** How close a panel may come to the view's edges (CSS pixels). */
export const PANEL_MARGIN = 8;

/**
 * The panel's top-left corner in pixels: from a stored position, or (null) centred
 * at `defaultTop`; always fully inside the view when it fits.
 */
export function panelPixels(pos: PanelPos | null, panelW: number, panelH: number, viewW: number, viewH: number, defaultTop: number): { left: number; top: number } {
  const left = pos ? pos.x * viewW : (viewW - panelW) / 2;
  const top = pos ? pos.y * viewH : defaultTop;
  return { left: clamp(left, panelW, viewW), top: clamp(top, panelH, viewH) };
}

/** A position in pixels (after dragging) as fractions of the view, kept inside. */
export function panelFraction(left: number, top: number, panelW: number, panelH: number, viewW: number, viewH: number): PanelPos {
  const x = viewW > 0 ? clamp(left, panelW, viewW) / viewW : 0;
  const y = viewH > 0 ? clamp(top, panelH, viewH) / viewH : 0;
  return { x: round4(x), y: round4(y) };
}

function clamp(v: number, size: number, avail: number): number {
  const max = avail - size - PANEL_MARGIN;
  // too big to fit: keep its start in sight
  if (max < PANEL_MARGIN) return PANEL_MARGIN;
  return Math.min(max, Math.max(PANEL_MARGIN, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
