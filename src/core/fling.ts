/**
 * Momentum scrolling ("fling"): after a finger scroll, the page keeps moving at
 * the speed the finger had when it lifted and slows down until it stops, like
 * scrolling in a PDF reader or a web page on a phone.
 */

export interface MoveSample {
  /** Time in ms. */
  t: number;
  /** Total distance moved so far, CSS pixels. */
  x: number;
  y: number;
}

/** Only the last part of the movement counts for the speed. */
export const FLING_WINDOW_MS = 100;
/** A finger that rested this long before lifting does not fling. */
export const FLING_REST_MS = 60;
/** Speeds below this (px/ms) do not start a fling, and end one. */
export const FLING_MIN_SPEED = 0.05;
/** The fastest fling (px/ms). */
export const FLING_MAX_SPEED = 8;
/** How much speed is kept after each millisecond (friction). */
export const FLING_DECAY_PER_MS = 0.996;

/**
 * The speed (px/ms) of the movement when the finger lifted at `now`, from the
 * samples of the last FLING_WINDOW_MS; {0, 0} when too slow, too short or it
 * rested before lifting.
 */
export function flingVelocity(samples: readonly MoveSample[], now: number): { vx: number; vy: number } {
  const none = { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  if (!last || now - last.t > FLING_REST_MS) return none;
  const recent = samples.filter((s) => last.t - s.t <= FLING_WINDOW_MS);
  const first = recent[0];
  const dt = last.t - first.t;
  if (recent.length < 2 || dt <= 0) return none;
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < FLING_MIN_SPEED) return none;
  if (speed > FLING_MAX_SPEED) {
    vx *= FLING_MAX_SPEED / speed;
    vy *= FLING_MAX_SPEED / speed;
  }
  return { vx, vy };
}

/**
 * One step of a fling: how far to move in `dt` ms at speed (vx, vy), and the
 * speed after it (slowed down by friction). `done` once it is too slow to go on.
 */
export function flingStep(vx: number, vy: number, dt: number): { dx: number; dy: number; vx: number; vy: number; done: boolean } {
  const step = Math.max(0, Math.min(dt, 50));
  const k = Math.pow(FLING_DECAY_PER_MS, step);
  // distance over the step with the speed decaying continuously
  const travel = step === 0 ? 0 : (1 - k) / -Math.log(FLING_DECAY_PER_MS);
  const nvx = vx * k;
  const nvy = vy * k;
  return { dx: vx * travel, dy: vy * travel, vx: nvx, vy: nvy, done: Math.hypot(nvx, nvy) < FLING_MIN_SPEED };
}
