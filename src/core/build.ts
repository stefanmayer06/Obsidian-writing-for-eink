/**
 * Which build of the plugin this is.
 *
 * The build (esbuild.config.mjs) puts its name into main.js: the commit's date and
 * time and its short hash, e.g. 20261114-1840-0cb277b. The Ink Notebook Bridge app
 * carries a copy of the plugin it was built with and compares names: instant ink
 * needs the two halves to be from the same build, and a test build keeps the
 * plugin's version number, so the version alone cannot tell.
 */
declare const __INK_BUILD__: string | undefined;

const MARK = "ink-notebook-build:";
const raw = typeof __INK_BUILD__ === "string" ? __INK_BUILD__ : "";

/** This build's name ("dev" when not built by esbuild.config.mjs: tests, the harness). */
export const BUILD_ID: string = raw.startsWith(MARK) ? raw.slice(MARK.length) : raw || "dev";

/** The build named in the text of a main.js, or null (a build from before builds had names). */
export function buildOf(mainJs: string): string | null {
  return /ink-notebook-build:(\d{8}-\d{4}-[0-9a-f]{7,40}(?:\+local)?)/.exec(mainJs)?.[1] ?? null;
}

/** The date and time a build's name starts with ("20261114-1840"), by which builds sort; null for a name without one. */
export function buildTime(id: string | null | undefined): string | null {
  return /^(\d{8}-\d{4})-/.exec(id ?? "")?.[1] ?? null;
}

/**
 * How build `a` stands to build `b`: "same", "older", "newer", or "unknown" when a name has no time
 * (two different builds of the same minute count as "older": they are not the same, so `b` replaces `a`).
 */
export function compareBuilds(a: string, b: string): "same" | "older" | "newer" | "unknown" {
  if (a === b) return "same";
  const ta = buildTime(a);
  const tb = buildTime(b);
  if (!ta || !tb) return "unknown";
  return ta > tb ? "newer" : "older";
}
