import { CapacitorAdapter, Platform } from "obsidian";
import type InkNotebookPlugin from "../main";
import {
  buildMessage,
  fastInkPen,
  isArmed,
  parseStatus,
  sameRequest,
  type CssRect,
  type FastInkInputs,
  type FastInkMessage,
  type FastInkStatus,
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

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** What the ink page looks like now, for the Bridge. */
export function measureInkPage(surface: InkSurface, opts: { refreshMs: number; sideButtonErases: boolean }): FastInkInputs {
  const doc = surface.el.ownerDocument;
  const win = doc.defaultView ?? window;
  const dpr = win.devicePixelRatio || 1;
  const box = surface.el.getBoundingClientRect();
  const region = box.width > 0 && box.height > 0 ? rectOf(box) : null;
  const exclude: CssRect[] = [];
  doc.querySelectorAll<HTMLElement>(UI_SELECTOR).forEach((el) => {
    if (win.getComputedStyle(el).visibility === "hidden") return;
    for (const r of Array.from(el.getClientRects())) if (r.width > 0 && r.height > 0) exclude.push(rectOf(r));
  });
  const t = surface.tools;
  const pen = t.tool === "pen" ? fastInkPen(t.pen, t.widths[t.pen], t.color, surface.view.scale, dpr) : null;
  let reason: string | null = null;
  if (!region) reason = "the page is not on screen";
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
  return { ready, region, exclude, pen, dpr, refreshMs: opts.refreshMs, sideButtonErases: opts.sideButtonErases, reason };
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
  private down: { x: number; y: number; t: number } | null = null;
  private frame = 0;
  private interval: number | null = null;
  private writing = false;
  private pendingWrite: string | null = null;
  private dirReady = false;
  private lastStatusPoll = Number.NEGATIVE_INFINITY;
  private bridgeStatus: FastInkStatus | null = null;
  private statusVia: "socket" | "file" | null = null;
  private observer: MutationObserver | null = null;
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

  /** The pen touched the page; the Bridge uses this to measure where the window is. */
  penDown(x: number, y: number): void {
    if (!this.enabled || !this.sent?.armed) return;
    if (this.onPage?.armed) this.onPage.strokes++;
    this.down = { x, y, t: Date.now() };
    if (!this.bridgeStatus?.calibrated) this.update();
  }

  /** The last stroke was not ink: the Bridge takes its fast ink off the page. */
  discard(): void {
    if (!this.enabled || !this.sent?.armed) return;
    this.clearCount++;
    this.send(true);
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
    const surface = view?.surface;
    // while the pen writes, nothing about the page changes: only renew the lease
    if (surface?.input.busy && this.sent) {
      if (force) this.transmit({ ...this.sent, seq: ++this.seq, until: now + this.leaseMs(), clear: this.clearCount, down: undefined });
      return;
    }
    const s = this.plugin.settings;
    const inputs = surface ? measureInkPage(surface, { refreshMs: s.fastInkRefreshMs, sideButtonErases: s.sideButton !== "none" }) : NO_INPUTS;
    this.notePage(inputs);
    const msg = buildMessage(inputs, { seq: this.seq + 1, now, leaseMs: this.leaseMs(), clear: this.clearCount, down: this.down });
    const unchanged = sameRequest(this.sent, msg);
    if (!force && unchanged && !msg.down) return;
    // nothing to say: it was off and stays off
    if (!msg.armed && this.sent && !this.sent.armed && unchanged) return;
    if (!msg.armed && !this.sent) return;
    if (!this.bridgeSeen()) return;
    this.seq = msg.seq;
    this.down = null;
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
    this.send(!!this.sent?.armed && now - this.sentAt >= renew);
    const pageOpen = !!this.activeView();
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
