import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMessage,
  clipRects,
  eventWallTime,
  fastInkPen,
  intersect,
  isArmed,
  parseStatus,
  roundIn,
  roundOut,
  sameRequest,
  WindowOrigin,
  type FastInkInputs,
} from "../src/core/fastInk";

const inputs: FastInkInputs = {
  ready: true,
  region: { x: 0, y: 56.4, w: 620, h: 800.2 },
  exclude: [
    { x: 0, y: 0, w: 620, h: 56.4 }, // the toolbar above the page: not inside it
    { x: 400.5, y: 70, w: 200, h: 300 }, // a pen card over the page
    { x: 400.5, y: 70, w: 200, h: 300 }, // the same card twice
    { x: 600, y: 800, w: 100, h: 100 }, // a notice reaching past the page
  ],
  // the page reaches past the bottom of the ink view (zoomed in); the region is its part on screen
  page: { x: 0, y: 56.42, w: 620, h: 877.33 },
  surface: { x: 0, y: 56.4, w: 620, h: 800.2 },
  win: { x: 0, y: 24, w: 620, h: 956.4, sw: 620, sh: 980.4 },
  pen: fastInkPen("fountain", 1.8, "#D32F2F", 1.5, 2),
  dpr: 2,
  refreshMs: 800,
  sideButtonErases: true,
};

describe("instant ink messages", () => {
  it("maps the plugin's pens to the firmware's", () => {
    expect(fastInkPen("fountain", 1.8, "#000000", 1.5, 2)).toEqual({ style: "fountain", width: 5.4, color: "#000000" });
    expect(fastInkPen("pencil", 1.5, "#4d4d4d", 1, 2)?.style).toBe("charcoal2");
    expect(fastInkPen("brush", 4, "#000000", 1, 1)?.style).toBe("brush");
    expect(fastInkPen("ballpoint", 1.5, "#000000", 1, 1)?.style).toBe("pencil");
    expect(fastInkPen("calligraphy", 4, "#000000", 1, 1)?.style).toBe("fountain");
    // the highlighter keeps the normal path (the firmware would paint it opaque)
    expect(fastInkPen("marker", 16, "#ffe14d", 1, 1)).toBeNull();
    // odd colours become black, widths stay in range
    expect(fastInkPen("fountain", 1, "red", 1, 1)?.color).toBe("#000000");
    expect(fastInkPen("fountain", 0.01, "#000000", 1, 1)?.width).toBe(0.5);
    expect(fastInkPen("fountain", 1000, "#000000", 1, 1)?.width).toBe(200);
  });

  it("rounds the page inwards and what covers it outwards", () => {
    expect(roundIn({ x: 0.5, y: 56.4, w: 10, h: 10 })).toEqual({ x: 1, y: 57, w: 9, h: 9 });
    expect(roundOut({ x: 0.5, y: 56.4, w: 10, h: 10 })).toEqual({ x: 0, y: 56, w: 11, h: 11 });
  });

  it("keeps only what lies over the page", () => {
    const region = { x: 0, y: 57, w: 620, h: 799 };
    expect(clipRects(region, inputs.exclude)).toEqual([
      { x: 400, y: 70, w: 201, h: 300 },
      { x: 600, y: 800, w: 20, h: 56 },
    ]);
  });

  it("is armed only with the page ready and a pen that has a firmware style", () => {
    expect(isArmed(inputs)).toBe(true);
    expect(isArmed({ ...inputs, ready: false })).toBe(false);
    expect(isArmed({ ...inputs, pen: null })).toBe(false);
    expect(isArmed({ ...inputs, region: { x: 0, y: 0, w: 0, h: 10 } })).toBe(false);
  });

  it("builds the message the Bridge app reads (shared with its tests)", () => {
    const msg = buildMessage(inputs, { seq: 42, now: 1000, leaseMs: 4000, clear: 3, ui: 2, uiDone: 1, down: { x: 100.54, y: 200.25, t: 4000 } });
    const fixture = JSON.parse(readFileSync("android/app/src/test/resources/plugin-message.json", "utf8"));
    expect(msg).toEqual(fixture);
  });

  it("tells changes from renewals", () => {
    const a = buildMessage(inputs, { seq: 1, now: 0, leaseMs: 1000, clear: 0 });
    const renewed = buildMessage(inputs, { seq: 2, now: 500, leaseMs: 1000, clear: 0, down: { x: 1, y: 2, t: 3 } });
    expect(sameRequest(a, renewed)).toBe(true);
    expect(sameRequest(a, buildMessage(inputs, { seq: 2, now: 0, leaseMs: 1000, clear: 1 }))).toBe(false);
    expect(sameRequest(a, buildMessage({ ...inputs, ready: false }, { seq: 2, now: 0, leaseMs: 1000, clear: 0 }))).toBe(false);
    expect(sameRequest(null, a)).toBe(false);
    // a press on a toolbar is news for the Bridge (it pauses the firmware)
    expect(sameRequest(a, buildMessage(inputs, { seq: 2, now: 0, leaseMs: 1000, clear: 0, ui: 1 }))).toBe(false);
    // and so is its result (the Bridge waits for it to draw again)
    const pressed = buildMessage(inputs, { seq: 2, now: 0, leaseMs: 1000, clear: 0, ui: 1, uiDone: 0 });
    expect(sameRequest(pressed, buildMessage(inputs, { seq: 3, now: 0, leaseMs: 1000, clear: 0, ui: 1, uiDone: 1 }))).toBe(false);
    // the window moved on the screen (split screen): the firmware's area moves
    expect(sameRequest(a, buildMessage({ ...inputs, win: { ...inputs.win!, y: 300 } }, { seq: 2, now: 0, leaseMs: 1000, clear: 0 }))).toBe(false);
  });

  it("says where the page, the ink view and Obsidian's window are", () => {
    const msg = buildMessage(inputs, { seq: 1, now: 0, leaseMs: 1000, clear: 0 });
    expect(msg.page).toEqual({ x: 0, y: 56.4, w: 620, h: 877.3 });
    expect(msg.surface).toEqual({ x: 0, y: 56, w: 620, h: 801 });
    expect(msg.win).toEqual({ x: 0, y: 24, w: 620, h: 956.4, sw: 620, sh: 980.4 });
    // until an event has shown where the window is, none (the Bridge places the page as before)
    const unknown = buildMessage({ ...inputs, win: null, page: null, surface: null }, { seq: 1, now: 0, leaseMs: 1000, clear: 0 });
    expect(unknown.win).toBeUndefined();
    expect(unknown.page).toBeUndefined();
    expect(unknown.surface).toBeUndefined();
  });

  it("takes the page's part on screen", () => {
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: -20, w: 100, h: 60 })).toEqual({ x: 50, y: 0, w: 50, h: 40 });
    expect(intersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it("finds where the window is on the screen from events, and ignores rounding noise", () => {
    const o = new WindowOrigin();
    expect(o.value).toBeNull();
    // the window starts 24 CSS px down (the status bar)
    expect(o.add(100.3, 200.6, 100.3, 224.6)).toBe(true);
    expect(o.value).toEqual({ x: 0, y: 24 });
    // screen positions rounded to whole pixels: jitter under a pixel is no news
    expect(o.add(50.4, 60.4, 50, 84)).toBe(false);
    expect(o.add(70.6, 10.6, 71, 35)).toBe(false);
    expect(o.value).toEqual({ x: 0, y: 24 });
    // events without a screen position say nothing
    expect(o.add(100, 100, 0, 0)).toBe(false);
    expect(o.add(Number.NaN, 1, 2, 3)).toBe(false);
    // the window really moved (split screen): once most of the recent events say so (3 said 24)
    for (let i = 0; i < 3; i++) o.add(10, 10, 10, 610);
    // half and half: still a position the window had, never one between the two
    expect(o.value).toEqual({ x: 0, y: 24 });
    expect(o.add(10, 10, 10, 610)).toBe(true);
    expect(o.value).toEqual({ x: 0, y: 600 });
  });

  it("dates a pen-down by its event, not by when JavaScript got to it", () => {
    // the event happened 180 ms before it was handled
    expect(eventWallTime(1000, 1180, 50_000)).toBe(49_820);
    // no timestamp, or one from another clock: now
    expect(eventWallTime(undefined, 1180, 50_000)).toBe(50_000);
    expect(eventWallTime(1_700_000_000_000, 1180, 50_000)).toBe(50_000);
    expect(eventWallTime(2000, 1180, 50_000)).toBe(50_000);
  });

  it("carries the recent pen-downs, which are not news by themselves", () => {
    const a = buildMessage(inputs, { seq: 1, now: 0, leaseMs: 1000, clear: 0 });
    const b = buildMessage(inputs, { seq: 2, now: 10, leaseMs: 1000, clear: 0, downs: [{ x: 1.04, y: 2, t: 5.2 }] });
    expect(b.downs).toEqual([{ x: 1, y: 2, t: 5 }]);
    expect(a.downs).toBeUndefined();
    expect(sameRequest(a, b)).toBe(true);
  });

  it("reads how the Bridge placed the page", () => {
    expect(parseStatus('{"v":1,"type":"status","at":5,"placement":"from Obsidian\'s window"}')?.placement).toBe("from Obsidian's window");
  });

  it("reads the strokes the firmware missed", () => {
    const s = parseStatus('{"v":1,"type":"status","at":5,"armed":true,"calibrated":true,"missed":2,"lastMissed":{"x":600,"y":120},"area":"x 0–1240"}');
    expect(s).toMatchObject({ missed: 2, lastMissed: { x: 600, y: 120 }, area: "x 0–1240" });
    expect(parseStatus('{"v":1,"type":"status","at":5,"lastMissed":{"x":"a"}}')?.lastMissed).toBeUndefined();
  });

  it("says when it was sent", () => {
    expect(buildMessage(inputs, { seq: 1, now: 1234.6, leaseMs: 1000, clear: 0 })).toMatchObject({ at: 1235, until: 2234.6, ui: 0 });
  });

  it("reads the Bridge's status", () => {
    expect(parseStatus('{"v":1,"type":"status","app":"0.1.0","at":5,"armed":true,"calibrated":false,"transport":"file"}')).toEqual({
      v: 1,
      type: "status",
      app: "0.1.0",
      at: 5,
      armed: true,
      calibrated: false,
      transport: "file",
      error: undefined,
    });
    expect(parseStatus('{"v":2,"type":"status","at":5}')).toBeNull();
    expect(parseStatus("not json")).toBeNull();
  });
});
