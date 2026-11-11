import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["dev/harness.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "dev/out/harness.js",
  // instant ink (fastInkBridge) imports Platform from "obsidian"
  alias: { obsidian: "./dev/obsidianStub.ts" },
  sourcemap: "inline",
  logLevel: "warning",
});
