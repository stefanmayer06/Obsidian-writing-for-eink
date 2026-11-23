import { FILL_COLORS, FILL_STYLE_INFO } from "../../core/ink/fill";
import { FILL_STYLES } from "../../core/ink/model";
import { LINE_STYLES, MARKER_COLORS, PENS, shownPens, spreadPresets, WRITING_PEN_TYPES, type LineStyle, type WritingPenType } from "../../core/ink/pens";
import { SHAPES, type ShapeKind } from "../../core/ink/shapes";
import { addColor, colorName, moveColor, removeColor } from "../../core/palette";
import { dragDock, isVerticalDock, PANEL_MARGIN, panelFraction, panelPixels, type Area, type Dock, type DragDock, type PanelPos } from "../../core/panelPosition";
import type { InkSurface } from "../surface";
import type { ToolState } from "../types";
import { colorPicker } from "./colorPicker";
import { button, el, Popover, section, swatches, tiles, type IconFn } from "./popover";

/**
 * The floating tool bar: opened by tapping the pen, the highlighter or the
 * shape tool, it keeps that tool's choices one tap away – the pens (or shapes),
 * thicknesses, line style and colours. It can be dragged anywhere by its handle
 * (the place is remembered); dragged near an edge of the page it snaps against
 * it, standing upright on the left and right. Flat and high-contrast like the
 * toolbar's cards (e-ink).
 *
 * The colours: tap one to use it, hold one to remove it, hold and drag one to
 * move it along the strip; dragging the strip scrolls it; "+" adds a colour with
 * the colour picker.
 */

export interface PenBarHost {
  icon: IconFn;
  /** Change the tools (the toolbar saves and refreshes). */
  setTools(patch: Partial<ToolState>): void;
  /** Open the full options of the current tool next to this button. */
  more(anchor: HTMLButtonElement): void;
  /** The bar was moved: remember where. */
  moved(pos: PanelPos): void;
  /** The pen colours were added to, removed from or reordered: remember them. */
  setColors(colors: string[]): void;
  /** Pens were hidden or shown again: remember them (never all hidden). */
  setHiddenPens(hidden: WritingPenType[]): void;
  /** The page area in the view (CSS pixels): the bar stays inside it and docks at its edges. */
  area(): Area;
}

type Mode = "pen" | "marker" | "shape";

/** The bar's shapes: not the "dashed line", which is a line with the bar's dashed style. */
const SHAPE_ORDER = (Object.keys(SHAPES) as ShapeKind[]).filter((k) => k !== "dashed");

export class PenBar {
  readonly el: HTMLElement;
  private colorsEl: HTMLElement | null = null;
  private shownKey = "";
  private resizeObserver: ResizeObserver | null = null;
  /** A drag of the bar: the pointer, where it took hold of the bar, where it started (for the direction) and where the bar would dock. */
  private drag: { pointer: number; dx: number; dy: number; dock: Dock | null; state: DragDock } | null = null;

  constructor(
    private parent: HTMLElement,
    private surface: InkSurface,
    private host: PenBarHost,
  ) {
    this.el = el(parent, "div", "ink-penbar ink-ui");
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Tool bar");
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

  /** Where the bar is docked: while dragging, where it would snap; otherwise where it was left. */
  private get dock(): Dock | null {
    if (this.drag) return this.drag.dock;
    return this.surface.settings.penBarPos?.dock ?? null;
  }

  private get vertical(): boolean {
    return isVerticalDock(this.dock);
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

  /** Draw the bar again when what it shows changed (tool, pen, colour, thickness, …). */
  refresh(force = false): void {
    if (this.el.hidden) return;
    const t = this.surface.tools;
    const st = this.surface.settings;
    const mode = modeOf(t);
    const color = mode === "marker" ? t.markerColor : t.color;
    const key = [
      mode,
      t.pen,
      color,
      mode === "marker" ? t.widths.marker : t.widths[t.pen],
      t.lineStyle,
      t.shape,
      t.shapeFill,
      t.fillStyle,
      st.hiddenPens.join(","),
      st.penColors.join(","),
      st.penBarSizes,
      this.vertical,
    ].join("|");
    if (!force && key === this.shownKey) return;
    const colorChanged = this.shownKey.split("|")[2] !== color;
    this.shownKey = key;
    const scroll = this.colorsEl ? { l: this.colorsEl.scrollLeft, t: this.colorsEl.scrollTop } : null;
    this.build(t, mode);
    if (this.colorsEl && scroll) {
      this.colorsEl.scrollLeft = scroll.l;
      this.colorsEl.scrollTop = scroll.t;
    }
    if (colorChanged) this.revealColor();
  }

  private build(t: ToolState, mode: Mode): void {
    // the handle stays (it may be held: the bar is rebuilt when it turns upright mid-drag)
    const grip = this.grip();
    for (const c of Array.from(this.el.children)) if (c !== grip) c.remove();
    this.el.classList.toggle("is-vertical", this.vertical);
    this.el.dataset.mode = mode;
    const icon = this.host.icon;
    grip.replaceChildren();
    icon(grip, this.vertical ? "grip-horizontal" : "grip-vertical");

    if (mode === "shape") this.buildShapes(t);
    else this.buildPens(t, mode === "marker");

    // thicknesses: as many as chosen in the settings, spread from thin to thick
    const marker = mode === "marker";
    const all = marker ? PENS.marker.presets : PENS[t.pen].presets;
    const presets = spreadPresets(all, this.surface.settings.penBarSizes);
    const current = marker ? t.widths.marker : t.widths[t.pen];
    const color = marker ? t.markerColor : t.color;
    const sizes = el(this.el, "div", "ink-penbar-group ink-penbar-sizes");
    for (const w of presets) {
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
    }

    // line style: solid, dashed or dotted (pens and shapes; the highlighter is always solid)
    if (!marker) lineStyleButtons(el(this.el, "div", "ink-penbar-group"), icon, t.lineStyle, "ink-penbar-btn", (st) => this.host.setTools({ lineStyle: st }));

    this.buildColors(marker, color);

    // shapes: the fill of new shapes
    if (mode === "shape") {
      const fill = button(this.el, icon, { icon: "paint-bucket", label: "Fill of new shapes", cls: "ink-penbar-btn ink-penbar-fill", onClick: () => this.pickFill(fill) });
      fill.style.setProperty("--swatch", t.shapeFill || "transparent");
      fill.classList.toggle("is-empty", !t.shapeFill);
    }

    // everything else (pressure, favourites, fine thickness, …)
    const more = button(this.el, icon, { icon: "ellipsis", label: mode === "shape" ? "More shape options" : "More pen options", cls: "ink-penbar-btn ink-penbar-more", onClick: () => this.host.more(more) });
  }

  private gripEl: HTMLElement | null = null;

  /** The handle: drag the bar anywhere (near an edge, it snaps there). Made once. */
  private grip(): HTMLElement {
    if (this.gripEl) return this.gripEl;
    const grip = el(this.el, "div", "ink-penbar-grip");
    grip.title = "Drag to move the bar; let go near an edge to dock it";
    grip.addEventListener("pointerdown", (e) => this.dragStart(e, grip));
    grip.addEventListener("pointermove", (e) => this.dragMove(e));
    grip.addEventListener("pointerup", (e) => this.dragEnd(e, grip));
    grip.addEventListener("pointercancel", (e) => this.dragEnd(e, grip));
    this.gripEl = grip;
    return grip;
  }

  private buildPens(t: ToolState, marker: boolean): void {
    const icon = this.host.icon;
    const pens = el(this.el, "div", "ink-penbar-group");
    const shown = shownPens(this.surface.settings.hiddenPens);
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
  }

  private buildShapes(t: ToolState): void {
    const shapes = el(this.el, "div", "ink-penbar-group ink-penbar-shapes");
    for (const k of SHAPE_ORDER) {
      const b = button(shapes, this.host.icon, { icon: SHAPES[k].icon, label: SHAPES[k].label, cls: "ink-penbar-btn", onClick: () => this.host.setTools({ tool: "shape", shape: k }) });
      setActive(b, t.shape === k);
    }
  }

  // ------------------------------------------------------------------ colours

  private buildColors(marker: boolean, color: string): void {
    const strip = el(this.el, "div", "ink-penbar-colors");
    this.colorsEl = strip;
    const list = marker ? MARKER_COLORS : this.surface.settings.penColors.map((c) => ({ color: c, label: colorName(c) }));
    for (const c of list) {
      const b = el(strip, "button", "ink-penbar-swatch");
      b.type = "button";
      b.dataset.color = c.color;
      b.title = marker ? c.label : `${c.label} – hold to remove, hold and drag to move`;
      b.setAttribute("aria-label", c.label);
      b.style.setProperty("--swatch", c.color);
      setActive(b, c.color.toLowerCase() === color.toLowerCase());
      // presses are handled by the strip (tap, hold, drag); this is the keyboard's Enter/Space
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (e.detail === 0) this.pickSwatch(c.color, marker);
      });
      if (!marker) {
        b.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.offerRemove(b, c.color);
        });
      }
    }
    // add a colour of your own with the colour picker
    if (!marker) {
      const add = button(strip, this.host.icon, { icon: "plus", label: "Add a colour", cls: "ink-penbar-btn ink-penbar-add", onClick: () => this.pickColor(add) });
    }
    this.stripGestures(strip, marker);
    strip.addEventListener(
      "wheel",
      (e) => {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d === 0) return;
        e.preventDefault();
        const step = e.deltaMode === 1 ? d * 16 : d;
        if (this.vertical) strip.scrollTop += step;
        else strip.scrollLeft += step;
      },
      { passive: false },
    );
  }

  private pickSwatch(color: string, marker: boolean): void {
    this.host.setTools(marker ? { markerColor: color } : { color });
  }

  /**
   * Presses on the colour strip: a tap uses a colour. With a finger or the pen,
   * dragging scrolls the strip, and holding a colour lifts it – move along the
   * strip to put it somewhere else, or let go to be asked whether to remove it.
   * With a mouse (which scrolls with its wheel), dragging a colour moves it
   * straight away; right-click removes it.
   */
  private stripGestures(strip: HTMLElement, marker: boolean): void {
    type State = "pending" | "scroll" | "lifted" | "moving";
    let g: { pointer: number; mouse: boolean; x0: number; y0: number; scroll0: number; swatch: HTMLElement | null; from: number; state: State; timer: number | null } | null = null;
    // a long press also brings the system's context menu (touch, pen): during a press it is not a remove
    strip.addEventListener("contextmenu", (e) => {
      if (g) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    const swatches = () => Array.from(strip.querySelectorAll<HTMLElement>(".ink-penbar-swatch"));
    const along = (e: PointerEvent) => (this.vertical ? e.clientY : e.clientX);
    const stopTimer = () => {
      if (g?.timer != null) window.clearTimeout(g.timer);
      if (g) g.timer = null;
    };
    const end = () => {
      stopTimer();
      g?.swatch?.classList.remove("is-lifted");
      strip.classList.remove("is-reordering");
      g = null;
    };

    strip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as Element).closest(".ink-penbar-add")) return;
      const swatch = (e.target as Element).closest<HTMLElement>(".ink-penbar-swatch");
      e.preventDefault();
      g = {
        pointer: e.pointerId,
        mouse: e.pointerType === "mouse",
        x0: e.clientX,
        y0: e.clientY,
        scroll0: this.vertical ? strip.scrollTop : strip.scrollLeft,
        swatch,
        from: swatch ? swatches().indexOf(swatch) : -1,
        state: "pending",
        timer: null,
      };
      try {
        strip.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (swatch && !marker) {
        g.timer = window.setTimeout(() => {
          if (!g || g.state !== "pending") return;
          g.timer = null;
          g.state = "lifted";
          swatch.classList.add("is-lifted");
          strip.classList.add("is-reordering");
          navigator.vibrate?.(12);
        }, LIFT_MS);
      }
    });

    strip.addEventListener("pointermove", (e) => {
      if (!g || e.pointerId !== g.pointer) return;
      const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0);
      if (g.state === "pending" && moved > HOLD_SLOP) {
        stopTimer();
        // a mouse dragging one of your colours moves it; anything else scrolls the strip
        if (g.mouse && g.swatch && !marker) {
          g.state = "moving";
          g.swatch.classList.add("is-lifted");
          strip.classList.add("is-reordering");
        } else g.state = "scroll";
      }
      if (g.state === "scroll") {
        const d = along(e) - (this.vertical ? g.y0 : g.x0);
        if (this.vertical) strip.scrollTop = g.scroll0 - d;
        else strip.scrollLeft = g.scroll0 - d;
        return;
      }
      if ((g.state === "lifted" && moved > 4) || g.state === "moving") {
        g.state = "moving";
        this.dragSwatch(strip, g.swatch as HTMLElement, along(e));
      }
    });

    strip.addEventListener("pointerup", (e) => {
      if (!g || e.pointerId !== g.pointer) return;
      const cur = g;
      end();
      if (cur.state === "pending" && cur.swatch?.dataset.color) this.pickSwatch(cur.swatch.dataset.color, marker);
      else if (cur.state === "lifted" && cur.swatch?.dataset.color) this.offerRemove(cur.swatch, cur.swatch.dataset.color);
      else if (cur.state === "moving" && cur.swatch) {
        const to = swatches().indexOf(cur.swatch);
        if (to !== cur.from) this.host.setColors(moveColor(this.surface.settings.penColors, cur.from, to));
      }
    });

    strip.addEventListener("pointercancel", (e) => {
      if (!g || e.pointerId !== g.pointer) return;
      const cur = g;
      end();
      // a move that was cut short keeps what it did so far
      if (cur.state === "moving" && cur.swatch) {
        const to = swatches().indexOf(cur.swatch);
        if (to !== cur.from) this.host.setColors(moveColor(this.surface.settings.penColors, cur.from, to));
      }
    });
  }

  /** Move a lifted colour along the strip to where the pointer is (and scroll at the ends). */
  private dragSwatch(strip: HTMLElement, swatch: HTMLElement, pos: number): void {
    const vertical = this.vertical;
    const r = strip.getBoundingClientRect();
    const start = vertical ? r.top : r.left;
    const size = vertical ? r.height : r.width;
    // near an end: scroll that way
    const edge = 28;
    if (pos < start + edge) strip[vertical ? "scrollTop" : "scrollLeft"] -= 8;
    else if (pos > start + size - edge) strip[vertical ? "scrollTop" : "scrollLeft"] += 8;
    const others = Array.from(strip.querySelectorAll<HTMLElement>(".ink-penbar-swatch")).filter((s) => s !== swatch);
    let before: HTMLElement | null = null;
    for (const o of others) {
      const or = o.getBoundingClientRect();
      const mid = vertical ? or.top + or.height / 2 : or.left + or.width / 2;
      if (pos < mid) {
        before = o;
        break;
      }
    }
    const target = before ?? strip.querySelector<HTMLElement>(".ink-penbar-add");
    if (target) {
      if (swatch.nextElementSibling !== target) strip.insertBefore(swatch, target);
    } else if (strip.lastElementChild !== swatch) strip.appendChild(swatch);
  }

  /** Open the colour picker card; the colour picked is added to the bar and used. */
  private pickColor(anchor: HTMLButtonElement): void {
    if (anchor.classList.contains("is-open")) {
      Popover.closeAll();
      return;
    }
    const pop = new Popover(this.parent, anchor, "ink-pop-colorpicker");
    el(pop.el, "div", "ink-pop-title", "Add a colour");
    colorPicker(pop.el, {
      icon: this.host.icon,
      initial: this.surface.tools.color,
      okLabel: "Add colour",
      onCancel: () => pop.close(),
      onPick: (c) => {
        pop.close();
        this.host.setColors(addColor(this.surface.settings.penColors, c));
        this.host.setTools({ color: c });
      },
    });
    pop.place(this.popSide());
  }

  /** A small card at a colour: remove it from the bar. */
  private offerRemove(anchor: HTMLElement, color: string): void {
    const palette = this.surface.settings.penColors;
    const pop = new Popover(this.parent, anchor, "ink-pop-confirm");
    el(pop.el, "p", "ink-pop-text", `Remove ${colorName(color)} from the bar?`);
    el(pop.el, "p", "ink-pop-hint", "Tip: hold a colour and drag it to move it along the strip.");
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
    pop.place(this.popSide());
  }

  /** The fill of new shapes: none or a colour, and how it is drawn. */
  private pickFill(anchor: HTMLButtonElement): void {
    if (anchor.classList.contains("is-open")) {
      Popover.closeAll();
      return;
    }
    const pop = new Popover(this.parent, anchor, "ink-pop-fill");
    const render = () => {
      pop.el.replaceChildren();
      const t = this.surface.tools;
      swatches(section(pop.el, "Fill of new shapes"), [{ color: "", label: "No fill" }, ...FILL_COLORS], t.shapeFill, (c) => {
        this.host.setTools({ shapeFill: c });
        render();
      });
      if (t.shapeFill) {
        tiles(
          section(pop.el, "Fill style"),
          this.host.icon,
          FILL_STYLES.map((st) => ({ value: st, icon: FILL_STYLE_INFO[st].icon, label: FILL_STYLE_INFO[st].label })),
          t.fillStyle,
          (st) => {
            this.host.setTools({ fillStyle: st });
            render();
          },
        );
      }
      pop.place(this.popSide());
    };
    render();
  }

  /** A small card at a pen: hide it from the pen bar and the pen's options. */
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
    pop.place(this.popSide());
  }

  /** Which way cards open from the bar: away from the edge it is docked at. */
  popSide(): "below" | "above" | "right" | "left" {
    switch (this.dock) {
      case "left":
        return "right";
      case "right":
        return "left";
      case "bottom":
        return "above";
      default:
        return "below";
    }
  }

  /** Put the bar where it was moved to (or at the top of the page), inside the page area. */
  place(): void {
    if (this.el.hidden || this.drag) return;
    const pos = this.surface.settings.penBarPos;
    const area = this.host.area();
    this.fitTo(area);
    const { left, top } = panelPixels(pos, this.el.offsetWidth, this.el.offsetHeight, this.parent.clientWidth, this.parent.clientHeight, area);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  /** No longer (upright: no taller) than the page area; the colour strip gives way first. */
  private fitTo(area: Area): void {
    const room = (n: number) => `${Math.max(120, Math.floor(n - 2 * PANEL_MARGIN))}px`;
    if (this.vertical) {
      this.el.style.maxHeight = room(area.h);
      this.el.style.removeProperty("max-width");
    } else {
      this.el.style.maxWidth = room(area.w);
      this.el.style.removeProperty("max-height");
    }
  }

  /** Scroll the colour strip so the current colour is in sight. */
  private revealColor(): void {
    const strip = this.colorsEl;
    const active = strip?.querySelector<HTMLElement>(".is-active");
    if (!strip || !active) return;
    if (this.vertical) {
      const start = active.offsetTop - strip.offsetTop;
      const end = start + active.offsetHeight;
      if (start < strip.scrollTop) strip.scrollTop = start - 4;
      else if (end > strip.scrollTop + strip.clientHeight) strip.scrollTop = end - strip.clientHeight + 4;
      return;
    }
    const start = active.offsetLeft - strip.offsetLeft;
    const end = start + active.offsetWidth;
    if (start < strip.scrollLeft) strip.scrollLeft = start - 4;
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth + 4;
  }

  // ------------------------------------------------------------------ moving

  private dragStart(e: PointerEvent, grip: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    Popover.closeAll();
    const r = this.el.getBoundingClientRect();
    const host = this.parent.getBoundingClientRect();
    const dock = this.dock;
    this.drag = { pointer: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, dock, state: { dock, ax: e.clientX - host.left, ay: e.clientY - host.top } };
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
    const area = this.host.area();
    const px = e.clientX - host.left;
    const py = e.clientY - host.top;
    // near an edge (or pushed against one): show the bar as it will dock there (upright on the left and right)
    const want = { x: px - d.dx, y: py - d.dy, w: this.el.offsetWidth, h: this.el.offsetHeight };
    d.state = dragDock(d.state, px, py, want, this.vertical, area);
    const dock = d.state.dock;
    if (dock !== d.dock) {
      const turned = isVerticalDock(dock) !== isVerticalDock(d.dock);
      d.dock = dock;
      this.el.classList.toggle("is-snapping", dock !== null);
      if (turned) {
        this.refresh(true);
        // keep the handle under the pointer
        const g = this.el.querySelector<HTMLElement>(".ink-penbar-grip");
        if (g) {
          d.dx = g.offsetLeft + g.offsetWidth / 2;
          d.dy = g.offsetTop + g.offsetHeight / 2;
        }
      }
    }
    this.fitTo(area);
    const pos = panelFraction(px - d.dx, py - d.dy, this.el.offsetWidth, this.el.offsetHeight, host.width, host.height, area, dock);
    const { left, top } = panelPixels(pos, this.el.offsetWidth, this.el.offsetHeight, host.width, host.height, area);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  private dragEnd(e: PointerEvent, grip: HTMLElement): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.drag = null;
    this.el.classList.remove("is-dragging", "is-snapping");
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const host = this.parent.getBoundingClientRect();
    const pos = panelFraction(this.el.offsetLeft, this.el.offsetTop, this.el.offsetWidth, this.el.offsetHeight, host.width, host.height, this.host.area(), d.dock);
    this.host.moved(pos);
    this.place();
    this.surface.host.viewChanged?.();
  }
}

/** Which bar a tool shows. */
function modeOf(t: ToolState): Mode {
  return t.tool === "marker" ? "marker" : t.tool === "shape" ? "shape" : "pen";
}

const LINE_STYLE_LABELS: Record<LineStyle, string> = { solid: "Solid line", dashed: "Dashed line", dotted: "Dotted line" };

/** Three buttons drawn as a solid, a dashed and a dotted line (the bar and the pen's options). */
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
/** A colour lifts to be moved sooner (before the system's long-press menu, at about 500 ms). */
const LIFT_MS = 350;

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
