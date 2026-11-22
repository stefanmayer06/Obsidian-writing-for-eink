import { INK_COLORS, MARKER_COLORS, PENS, shownPens } from "../../core/ink/pens";
import { SHAPES, type ShapeKind } from "../../core/ink/shapes";
import { FILL_COLORS, FILL_STYLE_INFO } from "../../core/ink/fill";
import { FILL_STYLES } from "../../core/ink/model";
import { inkPageForPdfPage } from "../../core/pdfLinks";
import { currentOutlineEntry, type PdfOutlineEntry } from "../../core/pdfOutline";
import type { InkSurface } from "../surface";
import { MAX_FAVORITES, MIN_FAVORITES, type EraserMode, type SurfaceSettings, type ToolId, type ToolState } from "../types";
import { lineStyleButtons, PenBar } from "./penBar";
import { button, el, menu, Popover, section, swatches, thickness, tiles, toggle, type IconFn, type MenuSection } from "./popover";

/**
 * The toolbar of the ink page, laid out like the Boox Notes app: tools on the
 * left (pen, highlighter, eraser, lasso, shapes, text, insert, two favourite
 * pens, undo/redo), the pages on the right (previous, "3 / 12", next, add)
 * and the text page and the menu at the end. Tapping the selected tool again
 * opens its options.
 */

export type ToolbarPosition = "top" | "bottom" | "left" | "right";

export interface ToolbarHost {
  icon: IconFn;
  /** The page grid (tap on "3 / 12"). */
  openPages(): void;
  insertMenu(): MenuSection[];
  moreMenu(): MenuSection[];
  /** Persist tool and behaviour changes. */
  toolsChanged(state: ToolState): void;
  settingsChanged(patch: Partial<SurfaceSettings>): void;
  /** Buttons at the end of the bar (typed notes, text page). */
  endButtons(): Array<{ id: string; icon: string; label: string; showLabel?: boolean; run(): void }>;
  /** Open the object libraries (the Library button is shown when this is given). */
  openLibrary?: () => void;
  /** A PDF's outline (the Outlines button is shown on PDF pages when this is given). */
  pdfOutline?: (path: string) => Promise<PdfOutlineEntry[]>;
}


const ERASERS: Array<{ value: EraserMode; icon: string; label: string }> = [
  { value: "partial", icon: "eraser", label: "Partial" },
  { value: "stroke", icon: "spline", label: "Whole stroke" },
  { value: "lasso", icon: "lasso", label: "Lasso" },
];

const ERASER_SIZES: Array<{ size: number; label: string }> = [
  { size: 5, label: "S" },
  { size: 10, label: "M" },
  { size: 18, label: "L" },
  { size: 32, label: "XL" },
];

const TEXT_SIZES: Array<{ size: number; label: string }> = [
  { size: 18, label: "S" },
  { size: 24, label: "M" },
  { size: 32, label: "L" },
  { size: 44, label: "XL" },
];

export class Toolbar {
  readonly el: HTMLElement;
  private toolButtons = new Map<string, HTMLButtonElement>();
  private favButtons: HTMLButtonElement[] = [];
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private pageLabel!: HTMLButtonElement;
  private endEl!: HTMLElement;
  private libraryBtn: HTMLButtonElement | null = null;
  private outlineBtn: HTMLButtonElement | null = null;
  private favsEl: HTMLElement | null = null;
  /** The floating pen bar (when the "Floating pen bar" setting is on). */
  private penBar: PenBar | null = null;
  /** The favourite pen that was in use, to scroll it into sight when it changes. */
  private activeFav = -1;
  private moreBtn: HTMLButtonElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** How much was folded into the "More" menu to make the bar fit (0 = nothing). */
  private level = 0;
  position: ToolbarPosition = "top";

  constructor(
    parent: HTMLElement,
    private surface: InkSurface,
    private host: ToolbarHost,
  ) {
    this.el = el(parent, "div", "ink-toolbar ink-ui");
    this.el.setAttribute("role", "toolbar");
    this.el.dataset.fold = "0";
    this.build();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.el);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    Popover.closeAll();
    this.penBar?.destroy();
    this.el.remove();
  }

  /** The pen bar, made the first time it is needed (next to the toolbar, in the view). */
  private getPenBar(): PenBar {
    if (!this.penBar) {
      const parent = this.el.parentElement ?? this.el;
      this.penBar = new PenBar(parent, this.surface, {
        icon: this.icon,
        setTools: (patch) => this.setTools(patch),
        more: (anchor) => {
          if (anchor.classList.contains("is-open")) {
            Popover.closeAll();
            return;
          }
          const tool = this.surface.tools.tool === "marker" ? "marker" : "pen";
          this.openOptions(tool, anchor);
        },
        moved: (pos) => {
          this.surface.setSettings({ penBarPos: pos });
          this.host.settingsChanged({ penBarPos: pos });
        },
        setHiddenPens: (hidden) => {
          const hiddenPens = hidden.length >= shownPens([]).length ? [] : hidden;
          this.surface.setSettings({ hiddenPens });
          this.host.settingsChanged({ hiddenPens });
          // the pen in use was just hidden: write with the first one still shown
          const pens = shownPens(hiddenPens);
          if (!pens.includes(this.surface.tools.pen)) this.setTools({ pen: pens[0] });
          else this.penBar?.refresh();
        },
        setColors: (penColors) => {
          this.surface.setSettings({ penColors });
          this.host.settingsChanged({ penColors });
          this.penBar?.refresh();
        },
        defaultTop: () => {
          // just under a top toolbar; near the top of the page otherwise
          const host = parent.getBoundingClientRect();
          const bar = this.el.getBoundingClientRect();
          return this.position === "top" ? bar.bottom - host.top + 8 : 8;
        },
      });
    }
    return this.penBar;
  }

  /** The pen bar goes with the pen and the highlighter, and with its setting. */
  private refreshPenBar(): void {
    const bar = this.penBar;
    if (!bar) return;
    const t = this.surface.tools.tool;
    if (!this.surface.settings.penBar || (t !== "pen" && t !== "marker")) bar.hide();
    else {
      bar.refresh();
      bar.place();
    }
  }

  /**
   * Make the bar fit its width (or height): first the favourite pens, the
   * "add page" and typed-notes buttons and the text label go (into the menu),
   * then the buttons get a little smaller, then the insert and library buttons
   * go, then the fill tool, then the page arrows (swipe instead), and last
   * undo/redo (two- and three-finger taps).
   */
  fit(): void {
    const vertical = this.el.hasAttribute("data-vertical");
    const overflows = () => (vertical ? this.el.scrollHeight > this.el.clientHeight + 1 : this.el.scrollWidth > this.el.clientWidth + 1);
    for (let level = 0; level <= 6; level++) {
      this.el.dataset.fold = String(level);
      this.level = level;
      if (!overflows()) break;
    }
  }

  private get icon(): IconFn {
    return this.host.icon;
  }

  /** How many favourite pens are shown (the setting, kept in range). */
  private get favoriteCount(): number {
    const n = Math.round(this.surface.settings.favoriteCount);
    return Number.isFinite(n) ? Math.max(MIN_FAVORITES, Math.min(MAX_FAVORITES, n)) : MIN_FAVORITES;
  }

  private build(): void {
    const tools = el(this.el, "div", "ink-tb-group ink-tb-tools");
    const tool = (id: ToolId, icon: string, label: string) => {
      const b = button(tools, this.icon, { icon, label, cls: `ink-tb-btn ink-tool-${id}`, onClick: () => this.pickTool(id, b) });
      el(b, "span", "ink-tb-caret");
      this.toolButtons.set(id, b);
      return b;
    };
    if (this.host.pdfOutline) {
      const b = button(tools, this.icon, { icon: "list-tree", label: "Outlines", cls: "ink-tb-btn ink-tb-outline", onClick: () => this.openOutline(b) });
      b.hidden = true;
      this.outlineBtn = b;
    }
    tool("pen", "pen-tool", "Pen");
    tool("marker", "highlighter", "Highlighter");
    tool("eraser", "eraser", "Eraser");
    tool("lasso", "lasso", "Lasso");
    tool("shape", "shapes", "Shapes");
    tool("fill", "paint-bucket", "Fill");
    tool("text", "type", "Text");
    const openLibrary = this.host.openLibrary;
    if (openLibrary) {
      this.libraryBtn = button(tools, this.icon, { icon: "library", label: "Object library", cls: "ink-tb-btn ink-tb-library", onClick: () => (Popover.closeAll(), openLibrary()) });
    }
    const ins = button(tools, this.icon, { icon: "image-plus", label: "Insert", cls: "ink-tb-btn ink-tb-insert", onClick: () => this.openMenu(ins, this.host.insertMenu()) });

    const favs = el(this.el, "div", "ink-tb-group ink-tb-favs");
    this.favsEl = favs;
    // a mouse wheel scrolls the strip of favourite pens sideways (on a top or bottom toolbar)
    favs.addEventListener(
      "wheel",
      (e) => {
        if (this.el.hasAttribute("data-vertical") || favs.scrollWidth <= favs.clientWidth + 1) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (d === 0) return;
        e.preventDefault();
        e.stopPropagation();
        favs.scrollLeft += e.deltaMode === 1 ? d * 16 : d;
      },
      { passive: false },
    );
    for (let i = 0; i < MAX_FAVORITES; i++) {
      const b = button(favs, this.icon, { label: `Favourite pen ${i + 1}`, cls: "ink-tb-btn ink-tb-fav", onClick: () => this.useFavorite(i) });
      b.hidden = i >= this.favoriteCount;
      el(b, "span", "ink-fav-stroke");
      this.favButtons.push(b);
    }

    const hist = el(this.el, "div", "ink-tb-group ink-tb-history");
    this.undoBtn = button(hist, this.icon, { icon: "undo-2", label: "Undo", cls: "ink-tb-btn", onClick: () => this.surface.undo() });
    this.redoBtn = button(hist, this.icon, { icon: "redo-2", label: "Redo", cls: "ink-tb-btn", onClick: () => this.surface.redo() });

    el(this.el, "div", "ink-tb-spacer");

    const pages = el(this.el, "div", "ink-tb-group ink-tb-pages");
    this.prevBtn = button(pages, this.icon, { icon: "chevron-left", label: "Previous page", cls: "ink-tb-btn", onClick: () => this.surface.prev() });
    this.pageLabel = button(pages, this.icon, { label: "Pages", showLabel: true, cls: "ink-tb-btn ink-tb-pagelabel", onClick: () => this.host.openPages() });
    this.nextBtn = button(pages, this.icon, { icon: "chevron-right", label: "Next page", cls: "ink-tb-btn", onClick: () => this.surface.next() });
    button(pages, this.icon, { icon: "file-plus-2", label: "Add a page after this one", cls: "ink-tb-btn ink-tb-addpage", onClick: () => this.surface.addPage("after") });

    this.endEl = el(this.el, "div", "ink-tb-group ink-tb-end");
    this.renderEnd();
    this.refreshTools();
  }

  /** Rebuild the end buttons (their badges/labels change). */
  renderEnd(): void {
    this.endEl.replaceChildren();
    for (const b of this.host.endButtons()) {
      button(this.endEl, this.icon, { icon: b.icon, label: b.label, showLabel: b.showLabel, cls: `ink-tb-btn ink-tb-${b.id}`, onClick: () => b.run() });
    }
    const more = button(this.endEl, this.icon, { icon: "ellipsis-vertical", label: "More", cls: "ink-tb-btn ink-tb-more", onClick: () => this.openMenu(more, this.moreSections()) });
    this.moreBtn = more;
  }

  /** The menu, with whatever was folded out of the bar. */
  private moreSections(): MenuSection[] {
    const folded: MenuSection[] = [];
    if (this.level >= 1) {
      const t = this.surface.tools;
      folded.push({
        title: "Favourite pens",
        items: t.favorites.slice(0, this.favoriteCount).map((f, i) => ({ icon: "star", label: `${PENS[f.pen].label} · ${INK_COLORS.find((c) => c.color === f.color)?.label ?? f.color}`, run: () => this.useFavorite(i) })),
      });
    }
    if (this.level >= 1) {
      const notes = this.host.endButtons().find((b) => b.id === "notes");
      if (notes) folded.push({ items: [{ icon: notes.icon, label: notes.label, run: () => notes.run() }] });
    }
    const outline = this.outlineBtn;
    if (this.level >= 3 && outline && !outline.hidden && this.moreBtn) {
      const more = this.moreBtn;
      folded.push({ items: [{ icon: "list-tree", label: "Outlines…", run: () => this.openOutline(more) }] });
    }
    const openLibrary = this.host.openLibrary;
    if (this.level >= 3 && openLibrary) folded.push({ items: [{ icon: "library", label: "Object library…", run: () => openLibrary() }] });
    if (this.level >= 3) folded.push(...this.host.insertMenu().map((s) => ({ ...s, title: s.title ?? "Insert" })));
    if (this.level >= 4) {
      const more = this.moreBtn;
      folded.push({
        items: [
          {
            icon: "paint-bucket",
            label: "Fill…",
            hint: "Tap inside a shape or a closed area to fill it",
            checked: this.surface.tools.tool === "fill",
            run: () => {
              this.setTools({ tool: "fill" });
              if (more) this.openOptions("fill", more);
            },
          },
        ],
      });
    }
    if (this.level >= 6) folded.push({ items: [{ icon: "undo-2", label: "Undo", run: () => this.surface.undo() }, { icon: "redo-2", label: "Redo", run: () => this.surface.redo() }] });
    return [...folded, ...this.host.moreMenu()];
  }

  setPosition(p: ToolbarPosition): void {
    this.position = p;
    this.el.toggleAttribute("data-vertical", p === "left" || p === "right");
  }

  private side(): "below" | "above" | "right" | "left" {
    return this.position === "bottom" ? "above" : this.position === "left" ? "right" : this.position === "right" ? "left" : "below";
  }

  // ------------------------------------------------------------------ state

  refreshTools(): void {
    const t = this.surface.tools;
    for (const [id, b] of this.toolButtons) {
      const active = id === t.tool;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    // the pen button shows the selected pen and colour
    const pen = this.toolButtons.get("pen");
    if (pen) {
      const i = pen.querySelector<HTMLElement>(".ink-btn-icon");
      if (i && i.dataset.icon !== PENS[t.pen].icon) {
        i.replaceChildren();
        this.icon(i, PENS[t.pen].icon);
        i.dataset.icon = PENS[t.pen].icon;
      }
      pen.style.setProperty("--ink-pen-color", t.color);
      pen.title = `${PENS[t.pen].label} – tap again for options`;
    }
    this.toolButtons.get("marker")?.style.setProperty("--ink-pen-color", t.markerColor);
    this.toolButtons.get("fill")?.style.setProperty("--ink-pen-color", t.fillColor || "transparent");
    if (this.libraryBtn) {
      const placing = t.tool === "stamp";
      this.libraryBtn.classList.toggle("is-active", placing);
      this.libraryBtn.setAttribute("aria-pressed", String(placing));
      this.libraryBtn.title = placing && this.surface.stamp ? `Placing “${this.surface.stamp.name}” – tap the page` : "Object library";
    }
    const shape = this.toolButtons.get("shape");
    if (shape) {
      const i = shape.querySelector<HTMLElement>(".ink-btn-icon");
      const icon = SHAPES[t.shape].icon;
      if (i && i.dataset.icon !== icon) {
        i.replaceChildren();
        this.icon(i, icon);
        i.dataset.icon = icon;
      }
    }
    // the number of favourite pens (a setting) may have changed
    const count = this.favoriteCount;
    let shownChanged = false;
    this.favButtons.forEach((b, i) => {
      const hidden = i >= count;
      if (b.hidden !== hidden) {
        b.hidden = hidden;
        shownChanged = true;
      }
    });
    if (shownChanged) this.fit();
    let activeFav = -1;
    t.favorites.forEach((f, i) => {
      const b = this.favButtons[i];
      if (!b || i >= count) return;
      b.style.setProperty("--ink-pen-color", f.color);
      b.style.setProperty("--ink-fav-width", `${Math.max(2, Math.min(8, f.width * 1.6))}px`);
      const active = t.tool === "pen" && t.pen === f.pen && t.color.toLowerCase() === f.color.toLowerCase() && Math.abs(t.widths[t.pen] - f.width) < 1e-6;
      b.classList.toggle("is-active", active);
      if (active && activeFav < 0) activeFav = i;
      b.title = `${PENS[f.pen].label}, ${INK_COLORS.find((c) => c.color === f.color)?.label ?? f.color} (long-press the pen options to change)`;
    });
    // a favourite that became the pen in use (e.g. saved to slot 7) scrolls into sight
    if (activeFav !== this.activeFav) {
      this.activeFav = activeFav;
      if (activeFav >= 0) this.revealFavorite(activeFav);
    }
    this.refreshPenBar();
  }

  /** Scroll the strip of favourite pens just enough to show one of them. */
  private revealFavorite(i: number): void {
    const strip = this.favsEl;
    const b = this.favButtons[i];
    if (!strip || !b) return;
    const vertical = this.el.hasAttribute("data-vertical");
    const offset = (x: HTMLElement) => (vertical ? x.offsetTop - strip.offsetTop : x.offsetLeft - strip.offsetLeft);
    const start = offset(b);
    const size = vertical ? b.offsetHeight : b.offsetWidth;
    const view = vertical ? strip.clientHeight : strip.clientWidth;
    const pos = vertical ? strip.scrollTop : strip.scrollLeft;
    let next = pos;
    if (start < pos) next = start;
    else if (start + size > pos + view) {
      // the strip snaps to the buttons' starts: go to the first one that brings this button fully in
      const need = start + size - view;
      next = start;
      for (const other of this.favButtons) {
        if (other.hidden) continue;
        const o = offset(other);
        if (o >= need - 0.5) {
          next = o;
          break;
        }
      }
    }
    if (next === pos) return;
    if (vertical) strip.scrollTop = next;
    else strip.scrollLeft = next;
  }

  /**
   * These run after every stroke: only touch the toolbar when something it
   * shows changed (on e-ink, every change of the page is a screen refresh).
   */
  refreshPage(index: number, count: number): void {
    const label = this.pageLabel.querySelector(".ink-btn-label");
    const text = `${index + 1} / ${count}`;
    if (label && label.textContent !== text) label.textContent = text;
    if (this.pageLabel.title !== "All pages") this.pageLabel.title = "All pages";
    setDisabled(this.prevBtn, index <= 0);
    setDisabled(this.nextBtn, index >= count - 1);
    this.refreshOutline();
  }

  /** The Outlines button is there on PDF pages only. */
  refreshOutline(): void {
    const b = this.outlineBtn;
    if (!b) return;
    const hidden = this.surface.page.bg.kind !== "pdf";
    if (b.hidden !== hidden) {
      b.hidden = hidden;
      if (hidden && b.classList.contains("is-open")) Popover.closeAll();
      this.fit();
    }
  }

  /** The card with the PDF's outline; tapping an entry turns to its page. */
  private openOutline(anchor: HTMLButtonElement): void {
    if (anchor.classList.contains("is-open")) {
      Popover.closeAll();
      return;
    }
    const bg = this.surface.page.bg;
    const load = this.host.pdfOutline;
    if (bg.kind !== "pdf" || !load) return;
    const pop = new Popover(this.el.parentElement ?? this.el, anchor, "ink-pop-outline");
    const sec = section(pop.el, "Outlines");
    const status = el(sec, "p", "ink-pop-hint", "Loading…");
    pop.place(this.side());
    load(bg.path).then(
      (entries) => {
        if (Popover.current !== pop) return;
        status.remove();
        if (entries.length === 0) {
          el(sec, "p", "ink-pop-hint", "This PDF has no outline.");
          pop.place(this.side());
          return;
        }
        this.fillOutline(el(sec, "div", "ink-menu ink-outline"), entries, bg.path, bg.page, () => pop.close());
        pop.place(this.side());
        pop.el.querySelector<HTMLElement>(".ink-outline .is-checked")?.scrollIntoView({ block: "center" });
      },
      (e) => {
        console.warn("Ink Notebook: could not read the outline of the PDF", e);
        if (Popover.current === pop) status.textContent = "Could not read the outline of this PDF.";
      },
    );
  }

  private fillOutline(list: HTMLElement, entries: PdfOutlineEntry[], path: string, pdfPage: number, close: () => void): void {
    const pages = this.surface.document.pages;
    const current = currentOutlineEntry(entries, pdfPage);
    entries.forEach((entry, i) => {
      const index = entry.page !== undefined ? inkPageForPdfPage(pages, path, entry.page) : -1;
      const b = el(list, "button", `ink-menu-item ink-outline-item${i === current ? " is-checked" : ""}`);
      b.type = "button";
      b.style.setProperty("--ink-outline-depth", String(Math.min(entry.depth, 6)));
      const t = el(b, "span", "ink-menu-text");
      el(t, "span", "ink-menu-label", entry.title);
      if (entry.url) el(t, "span", "ink-menu-hint", "Web link");
      else if (entry.page === undefined) el(t, "span", "ink-menu-hint", "No page");
      else if (index < 0) el(t, "span", "ink-menu-hint", `Page ${entry.page} – not in this notebook`);
      el(b, "span", "ink-outline-page", entry.page !== undefined ? String(entry.page) : "");
      b.disabled = !entry.url && index < 0;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.disabled) return;
        close();
        if (entry.url) {
          if (this.surface.host.openUrl) this.surface.host.openUrl(entry.url);
          else window.open(entry.url, "_blank");
        } else {
          this.surface.goTo(index);
        }
      });
    });
  }

  refreshHistory(canUndo: boolean, canRedo: boolean): void {
    setDisabled(this.undoBtn, !canUndo);
    setDisabled(this.redoBtn, !canRedo);
  }

  private setTools(patch: Partial<ToolState>): void {
    this.surface.setTools(patch);
    this.refreshTools();
    this.host.toolsChanged(this.surface.tools);
  }

  private useFavorite(i: number): void {
    const f = this.surface.tools.favorites[i];
    if (!f) return;
    this.setTools({ tool: "pen", pen: f.pen, color: f.color, widths: { ...this.surface.tools.widths, [f.pen]: f.width } });
  }

  /** Select a tool; the selected tool's button opens its options. */
  private pickTool(id: ToolId, b: HTMLButtonElement): void {
    const wasActive = this.surface.tools.tool === id;
    if (Popover.current) {
      const same = b.classList.contains("is-open");
      Popover.closeAll();
      if (same) return;
    }
    // the floating pen bar: the pen and the highlighter open it, tapping them again hides it
    if ((id === "pen" || id === "marker") && this.surface.settings.penBar) {
      const bar = this.getPenBar();
      if (!wasActive) {
        this.setTools({ tool: id });
        bar.show();
      } else bar.toggle();
      return;
    }
    if (!wasActive) {
      this.setTools({ tool: id });
      // tools whose options matter first open them right away
      if (id !== "shape" && id !== "fill") return;
    }
    this.openOptions(id, b);
  }

  private openMenu(anchor: HTMLButtonElement, sections: MenuSection[]): void {
    if (anchor.classList.contains("is-open")) {
      Popover.closeAll();
      return;
    }
    const host = this.el.parentElement ?? this.el;
    const pop = new Popover(host, anchor, "ink-pop-menu");
    menu(pop.el, this.icon, sections, () => pop.close());
    pop.place(this.side());
  }

  private openOptions(id: ToolId, anchor: HTMLButtonElement): void {
    const host = this.el.parentElement ?? this.el;
    const pop = new Popover(host, anchor, `ink-pop-${id}`);
    const render = () => {
      pop.el.replaceChildren();
      this.fillOptions(id, pop.el, () => {
        render();
        pop.place(this.side());
      }, () => pop.close());
    };
    render();
    pop.place(this.side());
  }

  private fillOptions(id: ToolId, root: HTMLElement, rerender: () => void, close: () => void): void {
    const t = this.surface.tools;
    const set = (patch: Partial<ToolState>) => {
      this.setTools(patch);
      rerender();
    };
    const setting = (patch: Partial<SurfaceSettings>) => {
      this.surface.setSettings(patch);
      this.host.settingsChanged(patch);
      rerender();
    };
    switch (id) {
      case "pen": {
        tiles(
          section(root, "Pen"),
          this.icon,
          shownPens(this.surface.settings.hiddenPens).map((p) => ({ value: p, icon: PENS[p].icon, label: PENS[p].label.replace(/ pen$/, "") })),
          t.pen,
          (p) => set({ pen: p }),
        );
        thickness(section(root, "Thickness"), this.icon, PENS[t.pen].presets, t.widths[t.pen], t.color, (w) => set({ widths: { ...t.widths, [t.pen]: w } }));
        swatches(section(root, "Colour"), INK_COLORS, t.color, (c) => set({ color: c }));
        lineStyleButtons(el(section(root, "Line"), "div", "ink-pop-row"), this.icon, t.lineStyle, "ink-pop-wide", (st) => set({ lineStyle: st }), true);
        const opts = section(root);
        toggle(opts, "Pressure sensitivity", this.surface.settings.pressure, (v) => setting({ pressure: v }), "Lines get wider the harder you press");
        const count = this.favoriteCount;
        const favRow = el(section(root, count > 2 ? "Save as favourite pen" : "Favourite pens"), "div", "ink-pop-row");
        for (let i = 0; i < count; i++) {
          // two get wide buttons as before; more get numbered ones that fit in a row
          const b = button(favRow, this.icon, {
            icon: "star",
            label: count > 2 ? String(i + 1) : `Save as favourite ${i + 1}`,
            showLabel: true,
            cls: count > 2 ? "ink-pop-wide ink-fav-slot" : "ink-pop-wide",
            onClick: () => {
              const favorites = t.favorites.slice();
              favorites[i] = { pen: t.pen, color: t.color, width: t.widths[t.pen] };
              set({ favorites });
            },
          });
          b.title = `Save this pen as favourite ${i + 1}`;
        }
        break;
      }
      case "marker": {
        thickness(section(root, "Highlighter thickness"), this.icon, PENS.marker.presets, t.widths.marker, t.markerColor, (w) => set({ widths: { ...t.widths, marker: w } }));
        swatches(section(root, "Colour"), MARKER_COLORS, t.markerColor, (c) => set({ markerColor: c }));
        el(section(root), "p", "ink-pop-hint", "Highlights stay underneath your writing.");
        break;
      }
      case "eraser": {
        tiles(section(root, "Eraser"), this.icon, ERASERS, t.eraser, (v) => set({ eraser: v }));
        const sizes = el(section(root, "Size"), "div", "ink-size-row");
        for (const s of ERASER_SIZES) {
          button(sizes, this.icon, { label: s.label, showLabel: true, cls: `ink-size-btn${s.size === t.eraserSize ? " is-active" : ""}`, onClick: () => set({ eraserSize: s.size }) });
        }
        toggle(section(root), "Scribble to erase", this.surface.settings.scribbleErase, (v) => setting({ scribbleErase: v }), "Scratch over writing with the pen to erase it");
        const clear = section(root);
        button(clear, this.icon, {
          icon: "trash-2",
          label: "Clear this page",
          showLabel: true,
          cls: "ink-pop-wide is-danger",
          onClick: () => {
            close();
            this.confirmClear();
          },
        });
        break;
      }
      case "lasso": {
        const row = el(section(root, "Lasso"), "div", "ink-pop-row");
        button(row, this.icon, { icon: "box-select", label: "Select all", showLabel: true, cls: "ink-pop-wide", onClick: () => (close(), this.surface.selectAll()) });
        const paste = button(row, this.icon, { icon: "clipboard-paste", label: "Paste", showLabel: true, cls: "ink-pop-wide", onClick: () => (close(), this.surface.paste()) });
        paste.disabled = !this.surface.canPaste;
        el(section(root), "p", "ink-pop-hint", "Draw a loop around writing to select it, or tap one item. Drag the selection to move it, the corner to resize, the top handle to rotate.");
        break;
      }
      case "shape": {
        tiles(
          section(root, "Shape"),
          this.icon,
          (Object.keys(SHAPES) as ShapeKind[]).map((k) => ({ value: k, icon: SHAPES[k].icon, label: SHAPES[k].label })),
          t.shape,
          (k) => {
            set({ shape: k, tool: "shape" });
            close();
          },
        );
        swatches(section(root, "Fill of new shapes"), [{ color: "", label: "No fill" }, ...FILL_COLORS], t.shapeFill, (c) => set({ shapeFill: c }));
        if (t.shapeFill) this.fillStyles(root, t.fillStyle, (st) => set({ fillStyle: st }));
        el(section(root), "p", "ink-pop-hint", "Arrows drawn from one shape to another stay attached to them when the shapes move.");
        toggle(section(root), "Snap shapes when you hold the pen", this.surface.settings.holdToShape, (v) => setting({ holdToShape: v }), "Draw a line, box, triangle or circle with the pen tool and keep the pen still at the end");
        break;
      }
      case "fill": {
        swatches(section(root, "Fill colour"), [{ color: "", label: "Remove fills" }, ...FILL_COLORS], t.fillColor, (c) => set({ fillColor: c }));
        this.fillStyles(root, t.fillStyle, (st) => set({ fillStyle: st }));
        el(
          section(root),
          "p",
          "ink-pop-hint",
          t.fillColor
            ? "Tap inside a shape or an area enclosed by lines to fill it. Fills stay underneath your writing."
            : "Tap a fill to remove it.",
        );
        break;
      }
      case "text": {
        const sizes = el(section(root, "Text size"), "div", "ink-size-row");
        for (const s of TEXT_SIZES) {
          button(sizes, this.icon, { label: s.label, showLabel: true, cls: `ink-size-btn${s.size === t.textSize ? " is-active" : ""}`, onClick: () => set({ textSize: s.size }) });
        }
        swatches(section(root, "Colour"), INK_COLORS, t.color, (c) => set({ color: c }));
        el(section(root), "p", "ink-pop-hint", "Tap the page where the text should go, or tap a text to change it.");
        break;
      }
      default:
        break;
    }
  }

  private fillStyles(root: HTMLElement, current: (typeof FILL_STYLES)[number], onPick: (st: (typeof FILL_STYLES)[number]) => void): void {
    tiles(
      section(root, "Fill style"),
      this.icon,
      FILL_STYLES.map((st) => ({ value: st, icon: FILL_STYLE_INFO[st].icon, label: FILL_STYLE_INFO[st].label })),
      current,
      onPick,
    );
  }

  private confirmClear(): void {
    const host = this.el.parentElement ?? this.el;
    const anchor = this.toolButtons.get("eraser") as HTMLButtonElement;
    const pop = new Popover(host, anchor, "ink-pop-confirm");
    el(pop.el, "p", "ink-pop-text", "Erase everything on this page? (You can undo this.)");
    const row = el(pop.el, "div", "ink-pop-row");
    button(row, this.icon, { label: "Cancel", showLabel: true, cls: "ink-pop-wide", onClick: () => pop.close() });
    button(row, this.icon, {
      icon: "trash-2",
      label: "Clear page",
      showLabel: true,
      cls: "ink-pop-wide is-danger",
      onClick: () => {
        pop.close();
        this.surface.clearPage();
      },
    });
    pop.place(this.side());
  }
}

function setDisabled(b: HTMLButtonElement, disabled: boolean): void {
  if (b.disabled !== disabled) b.disabled = disabled;
}
