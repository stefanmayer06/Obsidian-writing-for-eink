import { LINE_STYLES, MARKER_COLORS, PENS, shownPens, spreadPresets, WRITING_PEN_TYPES, type LineStyle, type WritingPenType } from "../../core/ink/pens";
import { addColor, colorName, removeColor } from "../../core/palette";
import { panelFraction, panelPixels, type PanelPos } from "../../core/panelPosition";
import type { InkSurface } from "../surface";
import type { ToolState } from "../types";
import { button, el, Popover, type IconFn } from "./popover";

/**
 * The floating pen bar: opened by tapping the pen or the highlighter, it keeps
 * the pens, the thicknesses and the colours one tap away while you write. It
 * can be dragged anywhere by its handle (the place is remembered); the colours
 * scroll sideways. Flat and high-contrast like the toolbar's cards (e-ink).
 */

export interface PenBarHost {
  icon: IconFn;
  /** Change the tools (the toolbar saves and refreshes). */
  setTools(patch: Partial<ToolState>): void;
  /** Open the full options of the current tool next to this button. */
  more(anchor: HTMLButtonElement): void;
  /** The bar was moved: remember where. */
  moved(pos: PanelPos): void;
  /** The pen colours were added to or removed from: remember them. */
  setColors(colors: string[]): void;
  /** Pens were hidden or shown again: remember them (never all hidden). */
  setHiddenPens(hidden: WritingPenType[]): void;
  /** Where the bar goes before it was ever moved (CSS pixels from the view's top). */
  defaultTop(): number;
}

export class PenBar {
  readonly el: HTMLElement;
  private colorsEl: HTMLElement | null = null;
  private shownKey = "";
  private resizeObserver: ResizeObserver | null = null;
  private drag: { pointer: number; dx: number; dy: number } | null = null;

  constructor(
    private parent: HTMLElement,
    private surface: InkSurface,
    private host: PenBarHost,
  ) {
    this.el = el(parent, "div", "ink-penbar ink-ui");
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Pen bar");
    this.el.hidden = true;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.place());
      this.resizeObserver.observe(parent);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.el.remove();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  show(): void {
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    this.refresh(true);
    if (wasHidden) {
      this.place();
      this.revealColor();
      this.surface.host.viewChanged?.();
    }
  }

  hide(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.surface.host.viewChanged?.();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Draw the bar again when what it shows changed (tool, pen, colour, thickness). */
  refresh(force = false): void {
    if (this.el.hidden) return;
    const t = this.surface.tools;
    const marker = t.tool === "marker";
    const st = this.surface.settings;
    const key = [t.tool, t.pen, marker ? t.markerColor : t.color, marker ? t.widths.marker : t.widths[t.pen], t.lineStyle, st.hiddenPens.join(","), st.penColors.join(","), st.penBarSizes].join("|");
    if (!force && key === this.shownKey) return;
    const colorChanged = this.shownKey.split("|")[2] !== key.split("|")[2];
    this.shownKey = key;
    const scroll = this.colorsEl?.scrollLeft ?? 0;
    this.build(t, marker);
    if (this.colorsEl) this.colorsEl.scrollLeft = scroll;
    if (colorChanged) this.revealColor();
  }

  private build(t: ToolState, marker: boolean): void {
    this.el.replaceChildren();
    const icon = this.host.icon;

    // the handle: drag the bar anywhere
    const grip = el(this.el, "div", "ink-penbar-grip");
    grip.title = "Drag to move the pen bar";
    icon(grip, "grip-vertical");
    grip.addEventListener("pointerdown", (e) => this.dragStart(e, grip));
    grip.addEventListener("pointermove", (e) => this.dragMove(e));
    grip.addEventListener("pointerup", (e) => this.dragEnd(e, grip));
    grip.addEventListener("pointercancel", (e) => this.dragEnd(e, grip));

    // pens and the highlighter
    const pens = el(this.el, "div", "ink-penbar-group");
    const hidden = this.surface.settings.hiddenPens;
    const shown = shownPens(hidden);
    for (const p of shown) {
      // a hold (or right-click) offers to hide the pen; a tap picks it
      let held = false;
      const b = button(pens, icon, {
        icon: PENS[p].icon,
        label: PENS[p].label,
        cls: "ink-penbar-btn",
        onClick: () => {
          if (held) {
            held = false;
            return;
          }
          this.host.setTools({ tool: "pen", pen: p });
        },
      });
      b.title = `${PENS[p].label} – hold to hide`;
      onHold(b, () => {
        held = true;
        this.offerHidePen(b, p, shown.length);
      });
      setActive(b, !marker && t.pen === p);
    }
    const hl = button(pens, icon, { icon: PENS.marker.icon, label: PENS.marker.label, cls: "ink-penbar-btn", onClick: () => this.host.setTools({ tool: "marker" }) });
    setActive(hl, marker);

    // thicknesses: the five presets of the current pen, drawn as lines of their width
    // as many as chosen in the settings, spread from thin to thick
    const all = marker ? PENS.marker.presets : PENS[t.pen].presets;
    const presets = spreadPresets(all, this.surface.settings.penBarSizes);
    const current = marker ? t.widths.marker : t.widths[t.pen];
    const color = marker ? t.markerColor : t.color;
    const sizes = el(this.el, "div", "ink-penbar-group ink-penbar-sizes");
    presets.forEach((w) => {
      // the line's thickness follows the preset's place among all five
      const i = all.indexOf(w);
      const b = button(sizes, icon, {
        label: `Thickness ${i + 1}`,
        cls: "ink-penbar-btn ink-penbar-size",
        onClick: () => this.host.setTools({ widths: { ...this.surface.tools.widths, [marker ? "marker" : this.surface.tools.pen]: w } }),
      });
      const line = el(b, "span", "ink-penbar-line");
      line.style.height = `${Math.round(2 + (i / (all.length - 1)) * (marker ? 12 : 8))}px`;
      line.style.background = color;
      setActive(b, Math.abs(w - current) < 1e-6);
    });

    // line style: solid, dashed or dotted (pens only; the highlighter is always solid)
    if (!marker) lineStyleButtons(el(this.el, "div", "ink-penbar-group"), icon, t.lineStyle, "ink-penbar-btn", (st) => this.host.setTools({ lineStyle: st }));

    // colours: a strip that scrolls sideways
    const colors = el(this.el, "div", "ink-penbar-colors");
    this.colorsEl = colors;
    const list = marker ? MARKER_COLORS : this.surface.settings.penColors.map((c) => ({ color: c, label: colorName(c) }));
    for (const c of list) {
      const b = el(colors, "button", "ink-penbar-swatch");
      b.type = "button";
      b.title = marker ? c.label : `${c.label} – hold to remove`;
      b.setAttribute("aria-label", c.label);
      b.style.setProperty("--swatch", c.color);
      setActive(b, c.color.toLowerCase() === color.toLowerCase());
      // a hold (or right-click) offers to remove one of your colours; a tap picks it
      let held = false;
      if (!marker) onHold(b, () => {
        held = true;
        this.offerRemove(b, c.color);
      });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (held) {
          held = false;
          return;
        }
        this.host.setTools(marker ? { markerColor: c.color } : { color: c.color });
      });
    }
    // add a colour of your own with the system's colour picker
    if (!marker) {
      const add = button(colors, icon, { icon: "plus", label: "Add a colour", cls: "ink-penbar-btn ink-penbar-add", onClick: () => this.pickColor(add) });
    }
    colors.addEventListener(
      "wheel",
      (e) => {
        if (colors.scrollWidth <= colors.clientWidth + 1) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d === 0) return;
        e.preventDefault();
        colors.scrollLeft += e.deltaMode === 1 ? d * 16 : d;
      },
      { passive: false },
    );

    // everything else (pressure, favourites, custom thickness)
    const more = button(this.el, icon, { icon: "ellipsis", label: "More pen options", cls: "ink-penbar-btn ink-penbar-more", onClick: () => this.host.more(more) });
  }

  /** Open the system's colour picker; the colour picked is added and used. */
  private pickColor(anchor: HTMLElement): void {
    // a fresh input each time: "change" fires even when the same colour is picked again
    this.el.querySelector(".ink-penbar-picker")?.remove();
    const input = el(this.el, "input", "ink-penbar-picker");
    input.type = "color";
    input.value = /^#[0-9a-f]{6}$/i.test(this.surface.tools.color) ? this.surface.tools.color : "#000000";
    input.setAttribute("aria-label", "Pick a colour");
    // where the picker opens, on systems that place it next to the input
    input.style.left = `${anchor.offsetLeft}px`;
    input.addEventListener("change", () => {
      const c = input.value;
      input.remove();
      this.host.setColors(addColor(this.surface.settings.penColors, c));
      this.host.setTools({ color: c.toLowerCase() });
    });
    input.click();
  }

  /** A small card under a colour: remove it from the bar. */
  private offerRemove(anchor: HTMLElement, color: string): void {
    const palette = this.surface.settings.penColors;
    const pop = new Popover(this.parent, anchor, "ink-pop-confirm");
    el(pop.el, "p", "ink-pop-text", `Remove ${colorName(color)} from the pen bar?`);
    const row = el(pop.el, "div", "ink-pop-row");
    button(row, this.host.icon, { label: "Keep", showLabel: true, cls: "ink-pop-wide", onClick: () => pop.close() });
    const remove = button(row, this.host.icon, {
      icon: "trash-2",
      label: "Remove colour",
      showLabel: true,
      cls: "ink-pop-wide is-danger",
      onClick: () => {
        pop.close();
        this.host.setColors(removeColor(this.surface.settings.penColors, color));
      },
    });
    if (palette.length <= 1) {
      remove.disabled = true;
      el(pop.el, "p", "ink-pop-hint", "The last colour stays.");
    }
    pop.place("below");
  }

  /** A small card under a pen: hide it from the pen bar and the pen's options. */
  private offerHidePen(anchor: HTMLElement, pen: WritingPenType, shownCount: number): void {
    const pop = new Popover(this.parent, anchor, "ink-pop-confirm");
    el(pop.el, "p", "ink-pop-text", `Hide the ${PENS[pen].label.toLowerCase()}? You can bring it back in Settings → Ink Notebook → Pens.`);
    const row = el(pop.el, "div", "ink-pop-row");
    button(row, this.host.icon, { label: "Keep", showLabel: true, cls: "ink-pop-wide", onClick: () => pop.close() });
    const hide = button(row, this.host.icon, {
      icon: "eye-off",
      label: "Hide",
      showLabel: true,
      cls: "ink-pop-wide is-danger",
      onClick: () => {
        pop.close();
        const hidden = this.surface.settings.hiddenPens;
        this.host.setHiddenPens(WRITING_PEN_TYPES.filter((p) => p === pen || hidden.includes(p)));
      },
    });
    if (shownCount <= 1) {
      hide.disabled = true;
      el(pop.el, "p", "ink-pop-hint", "The last pen stays.");
    }
    pop.place("below");
  }

  /** Put the bar where it was moved to (or under the toolbar), inside the view. */
  place(): void {
    if (this.el.hidden) return;
    const pos = this.surface.settings.penBarPos;
    const { left, top } = panelPixels(pos, this.el.offsetWidth, this.el.offsetHeight, this.parent.clientWidth, this.parent.clientHeight, this.host.defaultTop());
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  /** Scroll the colour strip so the current colour is in sight. */
  private revealColor(): void {
    const strip = this.colorsEl;
    const active = strip?.querySelector<HTMLElement>(".is-active");
    if (!strip || !active) return;
    const start = active.offsetLeft - strip.offsetLeft;
    const end = start + active.offsetWidth;
    if (start < strip.scrollLeft) strip.scrollLeft = start - 4;
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth + 4;
  }

  // ------------------------------------------------------------------ moving

  private dragStart(e: PointerEvent, grip: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const r = this.el.getBoundingClientRect();
    this.drag = { pointer: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.el.classList.add("is-dragging");
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    e.preventDefault();
    const host = this.parent.getBoundingClientRect();
    const pos = panelFraction(e.clientX - host.left - d.dx, e.clientY - host.top - d.dy, this.el.offsetWidth, this.el.offsetHeight, host.width, host.height);
    this.el.style.left = `${Math.round(pos.x * host.width)}px`;
    this.el.style.top = `${Math.round(pos.y * host.height)}px`;
  }

  private dragEnd(e: PointerEvent, grip: HTMLElement): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.el.classList.remove("is-dragging");
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const host = this.parent.getBoundingClientRect();
    const pos = panelFraction(this.el.offsetLeft, this.el.offsetTop, this.el.offsetWidth, this.el.offsetHeight, host.width, host.height);
    this.host.moved(pos);
    this.surface.host.viewChanged?.();
  }
}

const LINE_STYLE_LABELS: Record<LineStyle, string> = { solid: "Solid line", dashed: "Dashed line", dotted: "Dotted line" };

/** Three buttons drawn as a solid, a dashed and a dotted line (the pen bar and the pen's options). */
export function lineStyleButtons(parent: HTMLElement, icon: IconFn, current: LineStyle, cls: string, onPick: (st: LineStyle) => void, showLabel = false): void {
  for (const st of LINE_STYLES) {
    const b = button(parent, icon, { label: LINE_STYLE_LABELS[st], showLabel, cls: `${cls} ink-linestyle-btn`, onClick: () => onPick(st) });
    const sample = createSpan({ cls: `ink-linestyle-sample is-${st}` });
    b.prepend(sample);
    setActive(b, st === current);
  }
}

/** How long a press is held before it counts as a hold (ms), and how far it may wander (px). */
const HOLD_MS = 550;
const HOLD_SLOP = 8;

/** Call `fn` when the element is pressed and held (pen, finger or mouse) or right-clicked. */
function onHold(target: HTMLElement, fn: () => void): void {
  let timer: number | null = null;
  let start = { x: 0, y: 0 };
  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  target.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    stop();
    timer = window.setTimeout(() => {
      timer = null;
      fn();
    }, HOLD_MS);
  });
  target.addEventListener("pointermove", (e) => {
    if (timer !== null && Math.hypot(e.clientX - start.x, e.clientY - start.y) > HOLD_SLOP) stop();
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave"]) target.addEventListener(name, stop);
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    stop();
    fn();
  });
}

function setActive(b: HTMLElement, active: boolean): void {
  b.classList.toggle("is-active", active);
  b.setAttribute("aria-pressed", String(active));
}
