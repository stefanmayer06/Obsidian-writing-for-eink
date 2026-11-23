import { describe, expect, it } from "vitest";
import { FLING_DECAY_PER_MS, FLING_MAX_SPEED, FLING_MIN_SPEED, flingStep, flingVelocity, type MoveSample } from "../src/core/fling";

/** A steady finger movement: `speed` px/ms upwards, a sample every 16 ms. */
function steady(speed: number, until: number, count = 10): MoveSample[] {
  return Array.from({ length: count }, (_, i) => {
    const t = until - (count - 1 - i) * 16;
    return { t, x: 0, y: -speed * t };
  });
}

describe("flingVelocity", () => {
  it("is the speed of the last part of the movement", () => {
    const v = flingVelocity(steady(2, 1000), 1005);
    expect(v.vx).toBe(0);
    expect(v.vy).toBeCloseTo(-2);
  });

  it("only counts the last 100 ms", () => {
    // slow at first, then fast
    const samples: MoveSample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 300, x: 0, y: 30 },
      { t: 400, x: 0, y: 130 },
      { t: 450, x: 0, y: 180 },
    ];
    expect(flingVelocity(samples, 455).vy).toBeCloseTo(1);
  });

  it("does not fling when the finger rested before lifting", () => {
    expect(flingVelocity(steady(2, 1000), 1100)).toEqual({ vx: 0, vy: 0 });
  });

  it("does not fling a slow drag, a single sample or nothing", () => {
    expect(flingVelocity(steady(FLING_MIN_SPEED / 2, 1000), 1000)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([{ t: 10, x: 0, y: 50 }], 10)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([], 10)).toEqual({ vx: 0, vy: 0 });
  });

  it("caps the speed", () => {
    const v = flingVelocity(steady(50, 1000), 1000);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(FLING_MAX_SPEED);
  });
});

describe("flingStep", () => {
  it("slows down and finally stops", () => {
    let vy = 3;
    let travelled = 0;
    let ms = 0;
    let done = false;
    while (!done && ms < 10_000) {
      const s = flingStep(0, vy, 16);
      travelled += s.dy;
      expect(Math.abs(s.vy)).toBeLessThan(Math.abs(vy));
      vy = s.vy;
      done = s.done;
      ms += 16;
    }
    expect(done).toBe(true);
    // about a second of gliding, and as far as the speed and the friction say
    expect(ms).toBeGreaterThan(600);
    expect(ms).toBeLessThan(2000);
    // (it stops at the minimum speed, short of the last few pixels of an endless glide)
    expect(travelled).toBeCloseTo((3 - Math.abs(vy)) / -Math.log(FLING_DECAY_PER_MS), 3);
  });

  it("moves the same distance however the frames fall", () => {
    let a = { vx: 0, vy: 2 };
    let da = 0;
    for (let i = 0; i < 30; i++) {
      const s = flingStep(a.vx, a.vy, 10);
      da += s.dy;
      a = s;
    }
    let b = { vx: 0, vy: 2 };
    let db = 0;
    for (let i = 0; i < 10; i++) {
      const s = flingStep(b.vx, b.vy, 30);
      db += s.dy;
      b = s;
    }
    expect(da).toBeCloseTo(db, 6);
  });

  it("treats a long pause (a hidden tab) as a short step", () => {
    const s = flingStep(0, 2, 5000);
    expect(s.dy).toBeCloseTo(flingStep(0, 2, 50).dy);
  });
});
