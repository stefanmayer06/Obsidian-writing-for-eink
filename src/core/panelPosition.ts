/**
 * Where a floating panel (the pen bar) sits in its view. It is stored as
 * fractions of the view, so it stays in the same part of the screen when the
 * window or the tablet's orientation changes, and it is always kept inside.
 *
 * Dragged close to an edge of the page area, the panel docks there: it snaps
 * flat against that edge (and stands upright on the left and right), keeping
 * its place along the edge.
 */

export type Dock = "left" | "right" | "top" | "bottom";

export interface PanelPos {
  /** The panel's left edge as a fraction of the view's width. */
  readonly x: number;
  /** Its top edge as a fraction of the view's height. */
  readonly y: number;
  /** Docked against an edge of the page area (left and right: upright). */
  readonly dock?: Dock;
}

/** A rectangle in the view, CSS pixels. */
export interface Area {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How close a panel may come to the view's edges (CSS pixels). */
export const PANEL_MARGIN = 8;

/** How near an edge (CSS pixels) the pointer has to be for the panel to dock there. */
export const DOCK_DISTANCE = 56;

/** The panel stands upright when docked here. */
export function isVerticalDock(dock: Dock | null | undefined): boolean {
  return dock === "left" || dock === "right";
}

/**
 * The edge of `area` the pointer (view pixels) is near enough to dock at, or
 * null. In a corner, near two edges, it is the edge the drag is heading for
 * (`motion`: how far the pointer has moved since the drag began): the bar
 * starts at the top of the page, so dragging it left along the top ends near
 * both the top and the left edge – and it should go to the left. Without a
 * clear direction the nearer edge wins.
 */
export function dockFor(px: number, py: number, area: Area, distance = DOCK_DISTANCE, motion?: { dx: number; dy: number }): Dock | null {
  const near = (
    [
      ["left", px - area.x],
      ["right", area.x + area.w - px],
      ["top", py - area.y],
      ["bottom", area.y + area.h - py],
    ] as Array<[Dock, number]>
  ).filter(([, dist]) => dist <= distance);
  if (near.length === 0) return null;
  if (near.length > 1 && motion) {
    // how far the drag went towards each edge
    const toward = (dock: Dock) => (dock === "left" ? -motion.dx : dock === "right" ? motion.dx : dock === "top" ? -motion.dy : motion.dy);
    const heading = near.filter(([dock]) => toward(dock) > 0).sort((a, b) => toward(b[0]) - toward(a[0]));
    if (heading.length > 0) return heading[0][0];
  }
  return near.sort((a, b) => a[1] - b[1])[0][0];
}

/** Where a drag of the panel stands: the edge it would dock at, and where the pointer was when that last changed. */
export interface DragDock {
  readonly dock: Dock | null;
  /** The pointer (view pixels) when the drag began or the dock last changed: directions are measured from here. */
  readonly ax: number;
  readonly ay: number;
}

/** How far (px) the pointer has to head for another edge to move a docked panel there. */
const SWITCH_DISTANCE = 16;
/** How far (px) the pointer has to pull away from the edge to undock the panel. */
const RELEASE_DISTANCE = 80;

const OPPOSITE: Record<Dock, Dock> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/**
 * The dock while the panel is dragged: pointer at (px, py), the panel where it
 * would be without being kept inside (`want`), upright or not.
 *
 * An edge counts when the pointer is near it, or when a lying panel is pushed
 * against its left or right end: its handle is at its left end, so a long bar
 * pushed against the right edge stops there while the pointer is still far from
 * it. Of the edges that count, it is the one the drag heads for. Once docked, the
 * panel stays (upright on a side, it spans the page's height and is near the top
 * and bottom all the time) until the pointer heads for another edge or pulls
 * away from this one.
 */
export function dragDock(s: DragDock, px: number, py: number, want: Area, vertical: boolean, area: Area, distance = DOCK_DISTANCE): DragDock {
  const dx = px - s.ax;
  const dy = py - s.ay;
  const toward = (d: Dock) => (d === "left" ? -dx : d === "right" ? dx : d === "top" ? -dy : dy);
  const pointerDist: Record<Dock, number> = { left: px - area.x, right: area.x + area.w - px, top: py - area.y, bottom: area.y + area.h - py };
  const near = (Object.keys(pointerDist) as Dock[]).filter((d) => pointerDist[d] <= distance);
  const pushed: Dock[] = [];
  if (!vertical) {
    if (want.x < area.x + PANEL_MARGIN - 0.5) pushed.push("left");
    if (want.x + want.w > area.x + area.w - PANEL_MARGIN + 0.5) pushed.push("right");
  }
  const candidates = [...new Set([...near, ...pushed])];
  const best = (list: Dock[]) => list.sort((a, b) => toward(b) - toward(a))[0];

  if (s.dock) {
    const others = candidates.filter((d) => d !== s.dock && toward(d) > SWITCH_DISTANCE);
    if (others.length > 0) return { dock: best(others), ax: px, ay: py };
    if (toward(OPPOSITE[s.dock]) > RELEASE_DISTANCE) return { dock: null, ax: px, ay: py };
    return s;
  }
  const heading = candidates.filter((d) => toward(d) > 0);
  if (heading.length > 0) return { dock: best(heading), ax: px, ay: py };
  // the pointer at an edge without having moved towards it (yet): not while moving away from it
  const still = near.filter((d) => toward(d) >= -4).sort((a, b) => pointerDist[a] - pointerDist[b]);
  return still.length > 0 ? { dock: still[0], ax: px, ay: py } : s;
}

/**
 * The panel's top-left corner in pixels: from a stored position, or (null) centred
 * at the top of the area; docked panels lie against their edge. Always fully
 * inside the area when it fits.
 */
export function panelPixels(pos: PanelPos | null, panelW: number, panelH: number, viewW: number, viewH: number, area: Area): { left: number; top: number } {
  const left = pos ? pos.x * viewW : area.x + (area.w - panelW) / 2;
  const top = pos ? pos.y * viewH : area.y + PANEL_MARGIN;
  const x = clamp(left, panelW, area.x, area.w);
  const y = clamp(top, panelH, area.y, area.h);
  switch (pos?.dock) {
    case "left":
      return { left: clamp(area.x, panelW, area.x, area.w), top: y };
    case "right":
      return { left: clamp(area.x + area.w, panelW, area.x, area.w), top: y };
    case "top":
      return { left: x, top: clamp(area.y, panelH, area.y, area.h) };
    case "bottom":
      return { left: x, top: clamp(area.y + area.h, panelH, area.y, area.h) };
    default:
      return { left: x, top: y };
  }
}

/** A position in pixels (after dragging) as fractions of the view, kept inside the area. */
export function panelFraction(left: number, top: number, panelW: number, panelH: number, viewW: number, viewH: number, area: Area, dock: Dock | null = null): PanelPos {
  const x = viewW > 0 ? clamp(left, panelW, area.x, area.w) / viewW : 0;
  const y = viewH > 0 ? clamp(top, panelH, area.y, area.h) / viewH : 0;
  return dock ? { x: round4(x), y: round4(y), dock } : { x: round4(x), y: round4(y) };
}

/** `v` kept so that a panel `size` long lies inside [start, start + avail] with the margin. */
function clamp(v: number, size: number, start: number, avail: number): number {
  const min = start + PANEL_MARGIN;
  const max = start + avail - size - PANEL_MARGIN;
  // too big to fit: keep its start in sight
  if (max < min) return min;
  return Math.min(max, Math.max(min, v));
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
