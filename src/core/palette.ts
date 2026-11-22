import { INK_COLORS, MARKER_COLORS, PEN_BAR_COLORS } from "./ink/pens";

/**
 * The pen bar's own colours: start with the built-in ones, then add colours
 * with a colour picker and remove the ones you do not use. Colours are kept as
 * lower-case "#rrggbb", each once; there is always at least one.
 */

/** The most colours a palette keeps. */
export const MAX_PALETTE = 48;

export const DEFAULT_PEN_PALETTE: readonly string[] = PEN_BAR_COLORS.map((c) => c.color);

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** "#RRGGBB" or "#rgb" as lower-case "#rrggbb"; null for anything else. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (HEX6.test(v)) return v.toLowerCase();
  const m = HEX3.exec(v);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : null;
}

/** A stored palette: valid colours only, each once, at most MAX_PALETTE; the defaults when none is left. */
export function loadPalette(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_PEN_PALETTE];
  const out: string[] = [];
  for (const v of value) {
    const c = normalizeColor(v);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_PALETTE) break;
  }
  return out.length > 0 ? out : [...DEFAULT_PEN_PALETTE];
}

/** The palette with a colour added at the end (unchanged when it is there already, invalid or full). */
export function addColor(palette: readonly string[], color: string): string[] {
  const c = normalizeColor(color);
  if (!c || palette.includes(c) || palette.length >= MAX_PALETTE) return [...palette];
  return [...palette, c];
}

/** The palette without a colour (unchanged when it is the last one). */
export function removeColor(palette: readonly string[], color: string): string[] {
  const c = normalizeColor(color);
  const out = palette.filter((p) => p !== c);
  return out.length > 0 ? out : [...palette];
}

/** A colour's name when it is one of the built-in ones, otherwise its code ("#3a7bd5"). */
export function colorName(color: string): string {
  const c = color.toLowerCase();
  return [...PEN_BAR_COLORS, ...INK_COLORS, ...MARKER_COLORS].find((k) => k.color.toLowerCase() === c)?.label ?? c;
}
