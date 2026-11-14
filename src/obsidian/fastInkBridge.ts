import { CapacitorAdapter, Platform } from "obsidian";
import type InkNotebookPlugin from "../main";
import {
  buildMessage,
  eventWallTime,
  fastInkPen,
  intersect,
  isArmed,
  parseStatus,
  sameRequest,
  WindowOrigin,
  type CssRect,
  type FastInkInputs,
  type FastInkMessage,
  type FastInkStatus,
  type FastInkViewport,
  type FastInkWindow,
} from "../core/fastInk";
import type { InkSurface } from "../ink/surface";
import { currentDevice } from "./einkMode";

/**
 * Instant ink on Onyx Boox tablets, through the Ink Notebook Bridge app.
 *
 * A plugin cannot reach the Boox firmware's pen drawing (that needs Android
 * code), so the Bridge app does it: it turns the firmware drawing on over the
 * ink page, and the ink appears as fast as in the Boox Notes app. The plugin
 * still gets the pen and records every stroke as always; this class only keeps
 * the Bridge told where the page is, which parts its toolbars and cards cover,
 * which pen is selected, and until when (a lease renewed while the page is open,
 * so the Bridge stops by itself when Obsidian goes away).
 *
 * "Where the page is" is given exactly, nothing is left for the Bridge to guess:
 * the part of the page that takes ink (the paper, not the grey around it), the ink
 * view around it, and where Obsidian's window is on the screen (every pen and
 * finger event carries its screen position as well as its window position).
 *
 * Two ways to the Bridge: a WebSocket on 127.0.0.1 (instant, when Obsidian's
 * WebView allows it), else a small file in this plugin's folder that the Bridge
 * watches. The socket is tried while an ink page is open; nothing is written to the
 * file until the Bridge has shown up (its status file), unless instant ink is set
 * to "Always on".
 */

/** The active ink page, as far as instant ink is concerned. */
export interface FastInkView {
  readonly surface: InkSurface | undefined;
  readonly containerEl: HTMLElement;
}

export type FastInkConnection = "off" | "waiting" | "connected";

export const BRIDGE_PORT = 47613;
export const BRIDGE_DOWNLOAD_URL = "https://github.com/stefanmayer06/Obsidian-writing-for-eink/releases";
export const BRIDGE_START_URL = "inknotebook-bridge://start";

const LEASE_SOCKET_MS = 6000;
const RENEW_SOCKET_MS = 2000;
const LEASE_FILE_MS = 10_000;
const RENEW_FILE_MS = 4000;
const TICK_MS = 1000;
const STATUS_POLL_MS = 3000;
const STATUS_POLL_IDLE_MS = 15_000;
/** The Bridge counts as running when its status is this recent. */
const STATUS_FRESH_MS = 15_000;
/** The Bridge counts as installed (worth writing to) when it reported within this time. */
const BRIDGE_SEEN_MS = 24 * 60 * 60 * 1000;
const SOCKET_RETRY_MS = 30_000;
const SOCKET_RETRY_SLOW_MS = 5 * 60_000;
/** A repaint after part of the page was drawn again waits until the drawing settles (an erase gesture redraws many times). */
const REFRESH_SETTLE_MS = 250;
/** After the whole page was drawn again (a page turn, undo, zoom): almost at once (only what comes together is gathered). */
const REFRESH_PAGE_MS = 30;
/** Touches this soon after the pen moved are the palm resting on the screen, not presses. */
const PALM_MS = 700;
/** Pen-downs this recent go with every message (the control file keeps only the latest message). */
const RECENT_DOWNS_MS = 1500;
const RECENT_DOWNS = 4;
/**
 * A press on a toolbar or card is "done" (its result is in the next message, which tells the Bridge
 * the firmware may draw again) right after its click, or this long after the pen or finger lifted
 * when no click follows (a drag, a long press).
 */
const PRESS_DONE_MS = 250;
/** Moves of the pen or a finger are looked at for the window's position at most this often (presses always). */
const LOCATE_EVERY_MS = 100;

const NO_INPUTS: FastInkInputs = { ready: false, region: null, exclude: [], pen: null, dpr: 1, refreshMs: 800, sideButtonErases: true };

/** Elements that are not ink but may lie over the page: the plugin's toolbars and cards, Obsidian's notices and tooltips. */
const UI_SELECTOR = ".ink-ui, .notice, .tooltip";
/** Obsidian's own overlays: while one is open, no instant ink at all. */
const BLOCKING_SELECTOR = ".modal-container, body > .menu, .suggestion-container, .prompt";

function rectOf(r: DOMRect): CssRect {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** An element in a few words, for "why is instant ink off" (e.g. "div.workspace-drawer.mod-left"). */
function describe(el: Element): string {
  const cls = Array.from(el.classList).slice(0, 3).join(".");
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
}

/** On screen: laid out with a size (not display: none, not empty). */
function shown(el: Element): boolean {
  return Array.from(el.getClientRects()).some((r) => r.width > 0 && r.height > 0);
}

/** `el` is what a press in the middle of `r` would reach (nothing lies over it there). */
function onTop(doc: Document, el: Element, r: CssRect): boolean {
  const hit = doc.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
  return !hit || el.contains(hit);
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Where the page is in the window (CSS pixels): all of it, also what lies past the ink view when zoomed in. */
export function pageRect(surface: InkSurface, box: DOMRect): CssRect | null {
  const p = surface.page;
  const v = surface.view;
  const r = { x: box.left + v.ox, y: box.top + v.oy, w: p.w * v.scale, h: p.h * v.scale };
  return r.w > 0 && r.h > 0 && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null;
}

/**
 * What the ink page looks like now, for the Bridge. The firmware draws on the page only – the paper,
 * where ink stays (Ink Notebook draws nothing past the page's edge) – and `screen` is where Obsidian's
 * window is on the screen, when known.
 */
export function measureInkPage(
  surface: InkSurface,
  opts: { refreshMs: number; sideButtonErases: boolean; screen?: { x: number; y: number } | null; safeTop?: number },
): FastInkInputs {
  const doc = surface.el.ownerDocument;
  const win = doc.defaultView ?? window;
  const dpr = win.devicePixelRatio || 1;
  const box = surface.el.getBoundingClientRect();
  const view = box.width > 0 && box.height > 0 ? rectOf(box) : null;
  const page = view ? pageRect(surface, box) : null;
  const region = view && page ? intersect(page, view) : null;
  const screen = opts.screen;
  const windowOnScreen: FastInkWindow | null = screen
    ? { x: screen.x, y: screen.y, w: win.innerWidth, h: win.innerHeight, sw: win.screen?.width ?? 0, sh: win.screen?.height ?? 0 }
    : null;
  // always: by its size, the Bridge can tell where a full-screen window is even when no event has said so
  const vp: FastInkViewport = { w: win.innerWidth, h: win.innerHeight, sw: win.screen?.width ?? 0, sh: win.screen?.height ?? 0, top: opts.safeTop ?? 0 };
  const exclude: CssRect[] = [];
  doc.querySelectorAll<HTMLElement>(UI_SELECTOR).forEach((el) => {
    // only what is really there: a card or tooltip fading out, or kept invisible, takes no ink away
    const style = win.getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) === 0) return;
    // and only what takes presses there: the pen writes through a tooltip (it takes no presses) or
    // a card behind the page, so the firmware has to draw there too – a part left out where the pen
    // writes is a stroke nobody shows until the next pause
    if (style.pointerEvents === "none") return;
    for (const r of Array.from(el.getClientRects())) {
      if (!(r.width > 0 && r.height > 0)) continue;
      const rect = rectOf(r);
      const over = region ? intersect(rect, region) : null;
      if (over && !onTop(doc, el, over)) continue;
      exclude.push(rect);
    }
  });
  const t = surface.tools;
  const pen = t.tool === "pen" ? fastInkPen(t.pen, t.widths[t.pen], t.color, surface.view.scale, dpr) : null;
  let reason: string | null = null;
  if (!view) reason = "the ink view is not on screen";
  else if (!region) reason = "the page is not on screen (scrolled away)";
  else if (doc.visibilityState !== "visible") reason = "Obsidian is in the background";
  else if (!pen) reason = t.tool === "pen" ? "this pen has no instant ink" : `the ${t.tool} tool is selected (instant ink is for the pens)`;
  if (!reason) {
    // an Obsidian window or menu that is really open (one left hidden in the page does not count)
    const blocking = Array.from(doc.querySelectorAll(BLOCKING_SELECTOR)).find(shown);
    if (blocking) reason = `an Obsidian window or menu is open (${describe(blocking)})`;
  }
  // typing somewhere else (the keyboard is up); an editor left focused in a hidden tab does not count
  const active = doc.activeElement;
  if (!reason && active && isEditable(active) && !surface.el.contains(active) && shown(active)) reason = `typing in ${describe(active)}`;
  let ready = !reason;
  // something else lies over the page: a small thing (a floating button) is left out of the
  // drawing area, a big one (a sidebar, a pop-up the plugin does not know) stops instant ink
  if (ready && region) {
    const seen = new Set<Element>();
    let covered = 0;
    const n = 6;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const hit = doc.elementFromPoint(region.x + (region.w * (i + 0.5)) / n, region.y + (region.h * (j + 0.5)) / n);
        if (!hit || surface.el.contains(hit) || hit.closest(UI_SELECTOR)) continue;
        covered++;
        if (seen.has(hit)) continue;
        seen.add(hit);
        const r = hit.getBoundingClientRect();
        if (r.width * r.height > 0.25 * region.w * region.h) {
          covered = n * n;
          reason = `something covers the page (${describe(hit)})`;
        } else {
          exclude.push(rectOf(r));
        }
      }
    }
    if (covered > (n * n) / 4) {
      ready = false;
      reason ??= "things cover much of the page";
    }
  }
  return {
    ready,
    region,
    exclude,
    page,
    surface: view,
    win: windowOnScreen,
    vp,
    pen,
    dpr,
    refreshMs: opts.refreshMs,
    sideButtonErases: opts.sideButtonErases,
    reason,
  };
}

export class FastInkBridge {
  private socket: WebSocket | null = null;
  private socketOpen = false;
  /** The last attempt to connect directly: none yet, it worked, or it was refused (Obsidian blocks it or the Bridge is not running). */
  private socketResult: "none" | "open" | "failed" = "none";
  private lastSocketTry = Number.NEGATIVE_INFINITY;
  private seq = 0;
  private clearCount = 0;
  private sent: FastInkMessage | null = null;
  private sentAt = 0;
  /** The last few pen-downs (CSS pixels, wall clock ms), see FastInkMessage.downs. */
  private downs: Array<{ x: number; y: number; t: number }> = [];
  private frame = 0;
  private interval: number | null = null;
  private writing = false;
  private pendingWrite: string | null = null;
  private dirReady = false;
  private lastStatusPoll = Number.NEGATIVE_INFINITY;
  private bridgeStatus: FastInkStatus | null = null;
  private statusVia: "socket" | "file" | null = null;
  private observer: MutationObserver | null = null;
  /** Watches the active ink page for its cards and panels coming and going. */
  private viewObserver: MutationObserver | null = null;
  private observedEl: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private refreshAt = 0;
  /** Presses on anything but the page (the Bridge pauses the firmware for each, see FastInkMessage.ui). */
  private uiCount = 0;
  /** The presses whose result has been sent (FastInkMessage.uiDone). */
  private uiDone = 0;
  private pressTimer: number | null = null;
  /** Where Obsidian's window is on the screen, from the pen's and fingers' events. */
  private readonly origin = new WindowOrigin();
  private lastLocateAt = Number.NEGATIVE_INFINITY;
  /** Measures the safe area at the window's top (Obsidian drawing under the status bar); made once. */
  private safeProbe: HTMLElement | null = null;
  /** When the pen last moved over Obsidian, writing or hovering (performance.now()). */
  private lastPenAt = Number.NEGATIVE_INFINITY;
  private destroyed = false;
  /**
   * What happened on the ink page the last time it was on screen, for the settings (which
   * cover the page themselves, so they cannot look now).
   */
  onPage: { at: number; armed: boolean; reason: string | null; strokes: number; bridgeDrew: boolean } | null = null;
  /** Called when the connection or the Bridge's status changes (the settings tab shows it). */
  onChange: (() => void) | null = null;

  constructor(
    private plugin: InkNotebookPlugin,
    private activeView: () => FastInkView | null,
  ) {}

  /** Instant ink is on for this device (it still needs the Bridge app to do anything). */
  get enabled(): boolean {
    const mode = this.plugin.settings.fastInk;
    if (mode === "off" || !Platform.isAndroidApp) return false;
    return mode === "on" || currentDevice().vendor === "Onyx Boox";
  }

  get connection(): FastInkConnection {
    if (!this.enabled) return "off";
    return this.socketOpen || this.statusFresh(STATUS_FRESH_MS) ? "connected" : "waiting";
  }

  get status(): FastInkStatus | null {
    return this.bridgeStatus;
  }

  get transport(): "socket" | "file" | null {
    return this.socketOpen ? "socket" : this.statusVia;
  }

  /** Where the vault is on the device (Android), or null. */
  get vaultPath(): string | null {
    const a = this.plugin.app.vault.adapter;
    try {
      return a instanceof CapacitorAdapter ? a.getFullPath("") : null;
    } catch {
      return null;
    }
  }

  /** The vault is in Obsidian's own app storage, which the Bridge cannot read (Android 11+). */
  get vaultInAppStorage(): boolean {
    return /\/Android\/data\//.test(this.vaultPath ?? "");
  }

  get lastDirectConnection(): "none" | "open" | "failed" {
    return this.socketResult;
  }

  private get dir(): string {
    const m = this.plugin.manifest;
    return `${m.dir ?? `${this.plugin.app.vault.configDir}/plugins/${m.id}`}/bridge`;
  }

  start(): void {
    const p = this.plugin;
    p.registerDomEvent(document, "visibilitychange", () => this.send(true));
    p.registerDomEvent(document, "focusin", () => this.update());
    p.registerDomEvent(document, "focusout", () => this.update());
    p.registerDomEvent(window, "resize", () => this.update());
    // a press on a toolbar, a card or Obsidian: the firmware pauses before the press changes anything
    p.registerDomEvent(
      document,
      "pointerdown",
      (e) => {
        this.locate(e, true);
        this.pressed(e);
      },
      { capture: true, passive: true },
    );
    p.registerDomEvent(
      document,
      "pointermove",
      (e) => {
        if (e.pointerType === "pen") this.lastPenAt = performance.now();
        this.locate(e, false);
      },
      { capture: true, passive: true },
    );
    // the press is over: its result goes to the Bridge (right after its click, which changes the tool)
    p.registerDomEvent(document, "pointerup", () => this.pressDoneIn(PRESS_DONE_MS), { capture: true, passive: true });
    p.registerDomEvent(document, "pointercancel", () => this.pressDoneIn(PRESS_DONE_MS), { capture: true, passive: true });
    p.registerDomEvent(document, "click", () => this.pressClicked(), { capture: true, passive: true });
    // the safe area at the top of the window, for the Bridge (made before the observer below, so it
    // does not count as one of Obsidian's pop-ups coming and going)
    const probe = document.createElement("div");
    probe.className = "ink-safe-area-probe";
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    this.safeProbe = probe;
    // Obsidian's menus, modals and notices come and go as children of <body>
    this.observer = new MutationObserver(() => this.update());
    this.observer.observe(document.body, { childList: true });
    this.interval = window.setInterval(() => this.tick(), TICK_MS);
    p.registerInterval(this.interval);
  }

  destroy(): void {
    if (this.destroyed) return;
    // the Bridge stops at once (and by its lease at the latest)
    if (this.sent?.armed) this.transmit({ ...this.sent, seq: ++this.seq, armed: false, until: Date.now() });
    this.destroyed = true;
    this.observer?.disconnect();
    this.viewObserver?.disconnect();
    this.safeProbe?.remove();
    this.safeProbe = null;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.pressTimer !== null) window.clearTimeout(this.pressTimer);
    if (this.frame) cancelAnimationFrame(this.frame);
    const ws = this.socket;
    this.socket = null;
    this.socketOpen = false;
    window.setTimeout(() => ws?.close(), 200);
  }

  /** Something about the page may have changed: tell the Bridge (once per frame). */
  update(): void {
    if (this.destroyed || this.frame || !this.enabled) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.send(false);
    });
  }

  /**
   * The pen touched the page: the Bridge hears of it at once. It checks that the firmware is
   * drawing this stroke (if not, the firmware pauses, so the screen shows Ink Notebook's own
   * drawing of it). `timeStamp` is the event's own time (performance clock): the Bridge matches the
   * pen-down with the firmware's by time, and JavaScript may get to the event late.
   */
  penDown(x: number, y: number, timeStamp?: number): void {
    const sent = this.sent;
    if (!this.enabled || !sent?.armed || this.destroyed) return;
    if (this.onPage?.armed) this.onPage.strokes++;
    const now = Date.now();
    const t = Math.round(eventWallTime(timeStamp, performance.now(), now));
    const d = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t };
    this.downs = [...this.recentDowns(now), d].slice(-RECENT_DOWNS);
    this.transmit(this.renewal(sent, now, { down: d, downs: this.downs }));
    // the pen wrote on the page where the Bridge was told something covers it: that was wrong (the
    // press reached the page), so the page is measured again once the stroke is done
    if (sent.exclude.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) this.updateAfterStroke();
  }

  /** Measure the page again once the pen no longer writes (nothing is measured mid-stroke). */
  private updateAfterStroke(tries = 25): void {
    window.setTimeout(() => {
      if (this.destroyed) return;
      if (this.activeView()?.surface?.input.busy && tries > 0) return this.updateAfterStroke(tries - 1);
      this.update();
    }, 200);
  }

  /** The last message again with a new lease, the counters as they are now, and these pen-downs. */
  private renewal(
    sent: FastInkMessage,
    now: number,
    downs: { down?: FastInkMessage["down"]; downs?: FastInkMessage["downs"] } = {},
  ): FastInkMessage {
    return {
      ...sent,
      seq: ++this.seq,
      at: now,
      until: now + this.leaseMs(),
      clear: this.clearCount,
      ui: this.uiCount,
      uiDone: this.uiDone,
      down: downs.down,
      downs: downs.downs ?? this.recentDowns(now),
    };
  }

  /**
   * An event shows where Obsidian's window is on the screen (it carries both positions). Cheap: the
   * pen's hover moves come a hundred times a second, so moves are looked at only now and then.
   */
  private locate(e: PointerEvent, press: boolean): void {
    if (!e.isTrusted || this.destroyed) return;
    if (!press && e.timeStamp - this.lastLocateAt < LOCATE_EVERY_MS) return;
    this.lastLocateAt = e.timeStamp;
    if (this.origin.add(e.clientX, e.clientY, e.screenX, e.screenY, window.devicePixelRatio || 1)) this.update();
  }

  /**
   * The pen-downs of the last moments: every message carries them, since a message written to the
   * control file right after another replaces it before the Bridge reads it.
   */
  private recentDowns(now = Date.now()): Array<{ x: number; y: number; t: number }> {
    this.downs = this.downs.filter((o) => now - o.t < RECENT_DOWNS_MS);
    return this.downs;
  }

  /** The last stroke was not ink: the Bridge takes its fast ink off the page. */
  discard(): void {
    if (!this.enabled || !this.sent?.armed) return;
    this.clearCount++;
    this.send(true);
  }

  /**
   * The page was drawn again (`whole`: a page turn, undo, zoom; otherwise a part, as when erasing):
   * the Bridge pauses the firmware, so the panel shows the page as Obsidian draws it (the firmware's
   * ink would hide the change). A whole page goes almost at once, a part once the drawing settles.
   */
  refreshSoon(whole = false): void {
    if (!this.enabled || !this.sent?.armed) return;
    const at = performance.now() + (whole ? REFRESH_PAGE_MS : REFRESH_SETTLE_MS);
    if (this.refreshTimer !== null) {
      // a whole page does not wait for an erase that is settling; an erase restarts the wait
      if (whole && at >= this.refreshAt) return;
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshAt = at;
    this.refreshTimer = window.setTimeout(
      () => {
        this.refreshTimer = null;
        if (this.destroyed || !this.sent?.armed) return;
        this.clearCount++;
        this.send(true);
      },
      Math.max(0, at - performance.now()),
    );
  }

  /**
   * Something that is not the page was pressed (a toolbar button, a card, Obsidian): tell the
   * Bridge at once, before the press changes anything, so the firmware pauses and the panel shows
   * the change at its normal speed (the firmware's handwriting mode would hold it back).
   */
  private pressed(e: PointerEvent): void {
    const sent = this.sent;
    if (this.destroyed || !this.enabled || !sent?.armed) return;
    const now = performance.now();
    if (e.pointerType === "pen") this.lastPenAt = now;
    const surface = this.activeView()?.surface;
    if (!surface) return;
    // the palm, while the pen writes or hovers
    if (surface.input.busy || (e.pointerType === "touch" && now - this.lastPenAt < PALM_MS)) return;
    const target = e.target instanceof Element ? e.target : null;
    // on the page itself: writing, a swipe, a pinch – not a press elsewhere
    if (target && surface.el.contains(target) && !target.closest(UI_SELECTOR)) return;
    this.uiCount++;
    if (this.pressTimer !== null) window.clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.transmit(this.renewal(sent, Date.now()));
  }

  /**
   * The press on a toolbar or card was a click: whatever it changes (a new tool, a card) is changed
   * by the time anything is sent again (its handlers run in this same event), so from now on every
   * message includes this press. The Bridge lets the firmware draw again on that, not after a fixed
   * wait – and never with the pen from before the press. One message is sent for it in any case.
   */
  private pressClicked(): void {
    if (this.uiDone >= this.uiCount || this.destroyed) return;
    this.uiDone = this.uiCount;
    this.sendPressResult(0);
  }

  /** A press that ends without a click (a drag, a long press): its result is sent a moment after it ends. */
  private pressDoneIn(ms: number): void {
    if (this.uiDone >= this.uiCount || this.destroyed) return;
    this.sendPressResult(ms, () => (this.uiDone = this.uiCount));
  }

  private sendPressResult(ms: number, before?: () => void): void {
    if (this.pressTimer !== null) window.clearTimeout(this.pressTimer);
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = null;
      if (this.destroyed) return;
      before?.();
      // already on its way with the press's result (the tool change sent it)
      if (this.sent?.uiDone === this.uiDone) return;
      this.send(true);
    }, ms);
  }

  /** Follow the active ink page's own changes (its pen cards and panels open and close inside it). */
  private watchView(view: FastInkView | null): void {
    const el = view?.containerEl ?? null;
    if (el === this.observedEl) return;
    this.viewObserver?.disconnect();
    this.observedEl = el;
    if (!el) return;
    this.viewObserver ??= new MutationObserver(() => this.update());
    // not "style": a swipe or pinch changes the page's transform on every finger move, and measuring
    // the page each time made page turns lag on e-ink tablets (cards come and go as elements anyway)
    this.viewObserver.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden"] });
  }

  // ------------------------------------------------------------------ sending

  /** The Bridge app has reported recently enough to be worth writing to. */
  private bridgeSeen(): boolean {
    return this.plugin.settings.fastInk === "on" || this.socketOpen || this.statusFresh(BRIDGE_SEEN_MS);
  }

  private statusFresh(ms: number): boolean {
    const s = this.bridgeStatus;
    return !!s && Date.now() - s.at < ms;
  }

  private leaseMs(): number {
    return this.socketOpen ? LEASE_SOCKET_MS : LEASE_FILE_MS;
  }

  private send(force: boolean): void {
    if (this.destroyed) return;
    const now = Date.now();
    const view = this.enabled ? this.activeView() : null;
    this.watchView(view);
    const surface = view?.surface;
    // while the pen writes, nothing about the page changes: only renew the lease
    if (surface?.input.busy && this.sent) {
      if (force) this.transmit(this.renewal(this.sent, now));
      return;
    }
    const s = this.plugin.settings;
    const inputs = surface
      ? measureInkPage(surface, {
          refreshMs: s.fastInkRefreshMs,
          sideButtonErases: s.sideButton !== "none",
          screen: this.origin.value,
          safeTop: this.safeProbe?.getBoundingClientRect().height ?? 0,
        })
      : NO_INPUTS;
    this.notePage(inputs);
    const msg = buildMessage(inputs, {
      seq: this.seq + 1,
      now,
      leaseMs: this.leaseMs(),
      clear: this.clearCount,
      ui: this.uiCount,
      uiDone: this.uiDone,
      app: this.plugin.manifest.version,
      downs: this.recentDowns(now),
    });
    const unchanged = sameRequest(this.sent, msg);
    if (!force && unchanged) return;
    // nothing to say: it was off and stays off (while an ink page is open the lease is renewed anyway,
    // so the Bridge keeps checking often and the pen tool turns instant ink on at once)
    const pageShown = !!surface && document.visibilityState === "visible";
    if (!msg.armed && this.sent && !this.sent.armed && unchanged && !(force && pageShown)) return;
    if (!msg.armed && !this.sent) return;
    if (!this.bridgeSeen()) return;
    this.seq = msg.seq;
    this.transmit(msg);
  }

  /** Remember how the page was for the settings, unless the settings (or another app) are what covers it. */
  private notePage(inputs: FastInkInputs): void {
    if (!this.activeView() || document.visibilityState !== "visible" || document.querySelector(".mod-settings")) return;
    const armed = isArmed(inputs);
    const before = this.onPage;
    if (before && before.armed === armed && before.reason === (inputs.reason ?? null)) {
      before.at = Date.now();
      return;
    }
    this.onPage = { at: Date.now(), armed, reason: inputs.reason ?? null, strokes: 0, bridgeDrew: false };
  }

  private transmit(msg: FastInkMessage): void {
    this.sent = msg;
    this.sentAt = Date.now();
    const text = JSON.stringify(msg);
    if (this.socketOpen && this.socket) {
      try {
        this.socket.send(text);
        return;
      } catch {
        this.dropSocket();
      }
    }
    this.writeFile(text);
  }

  /** Write the control file (the latest state wins; one write at a time). */
  private writeFile(text: string): void {
    this.pendingWrite = text;
    if (this.writing) return;
    this.writing = true;
    void (async () => {
      const adapter = this.plugin.app.vault.adapter;
      while (this.pendingWrite !== null) {
        const t = this.pendingWrite;
        this.pendingWrite = null;
        try {
          if (!this.dirReady) {
            if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
            this.dirReady = true;
          }
          await adapter.write(`${this.dir}/state.json`, t);
        } catch {
          this.dirReady = false;
        }
      }
      this.writing = false;
    })();
  }

  // ------------------------------------------------------------------ the regular check

  private tick(): void {
    if (this.destroyed) return;
    if (!this.enabled) {
      if (this.sent?.armed) this.transmit({ ...this.sent, seq: ++this.seq, armed: false, until: Date.now() });
      return;
    }
    const now = Date.now();
    const renew = this.socketOpen ? RENEW_SOCKET_MS : RENEW_FILE_MS;
    const pageOpen = !!this.activeView();
    const pageShown = pageOpen && document.visibilityState === "visible";
    this.send(!!this.sent && (this.sent.armed || pageShown) && now - this.sentAt >= renew);
    // the socket is tried even before the Bridge's status file shows up: the Bridge may not find
    // the vault (Obsidian's app storage), and the socket needs no file access
    if (!this.socketOpen && pageOpen) {
      const wait = this.statusVia === "file" && this.statusFresh(STATUS_FRESH_MS) ? SOCKET_RETRY_SLOW_MS : SOCKET_RETRY_MS;
      if (now - this.lastSocketTry > wait) this.connectSocket();
    }
    if (!this.socketOpen) {
      const every = pageOpen ? STATUS_POLL_MS : STATUS_POLL_IDLE_MS;
      if (now - this.lastStatusPoll > every) void this.pollStatus();
    }
  }

  private async pollStatus(): Promise<void> {
    this.lastStatusPoll = Date.now();
    try {
      const adapter = this.plugin.app.vault.adapter;
      const path = `${this.dir}/status.json`;
      if (!(await adapter.exists(path))) return;
      const s = parseStatus(await adapter.read(path));
      if (s) this.setStatus(s, "file");
    } catch {
      // not there yet
    }
  }

  private setStatus(s: FastInkStatus, via: "socket" | "file"): void {
    const before = this.connection;
    const calibratedBefore = this.bridgeStatus?.calibrated;
    const wasSeen = this.bridgeSeen();
    this.bridgeStatus = s;
    this.statusVia = via;
    if (s.armed && this.sent?.armed && this.onPage?.armed) this.onPage.bridgeDrew = true;
    // the Bridge just appeared: tell it about the page now
    if (!wasSeen && this.bridgeSeen()) this.update();
    if (before !== this.connection || calibratedBefore !== s.calibrated) this.onChange?.();
  }

  // ------------------------------------------------------------------ socket

  private connectSocket(): void {
    this.lastSocketTry = Date.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    } catch {
      return;
    }
    this.socket = ws;
    const timeout = window.setTimeout(() => {
      if (this.socket === ws && !this.socketOpen) ws.close();
    }, 3000);
    ws.onopen = () => {
      window.clearTimeout(timeout);
      if (this.socket !== ws || this.destroyed) return ws.close();
      this.socketOpen = true;
      this.socketResult = "open";
      // the whole state again, over the socket
      this.sent = null;
      this.send(true);
      this.onChange?.();
    };
    ws.onmessage = (e: MessageEvent) => {
      const s = typeof e.data === "string" ? parseStatus(e.data) : null;
      if (s) this.setStatus(s, "socket");
    };
    ws.onclose = () => {
      window.clearTimeout(timeout);
      if (this.socket !== ws) return;
      if (!this.socketOpen && this.socketResult !== "failed") {
        this.socketResult = "failed";
        this.onChange?.();
      }
      this.dropSocket();
    };
  }

  private dropSocket(): void {
    const was = this.socketOpen;
    this.socket = null;
    this.socketOpen = false;
    if (!was || this.destroyed) return;
    // carry on through the control file
    this.sent = null;
    this.onChange?.();
    this.update();
  }
}
