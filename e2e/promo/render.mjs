// Renders the promo video from the recorded footage (record.mjs) with
// compose.html in a headless Chromium, frame by frame, into ffmpeg.
//
//   node promo/render.mjs                    # → e2e/shots/promo/video/ink-notebook-promo.mp4
//   node promo/render.mjs --frames 0,95,300  # only these frames, as PNGs (to look at)
//   node promo/render.mjs --sheet 12         # a contact sheet: every 12th frame
//
// It writes cues.json (the pen, the taps, the cuts and the beat, frame by frame)
// for sound.py, then puts picture and sound together.
import { chromium } from "playwright-core";
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { handwriting } from "../scripts/handwriting.mjs";
import { CLIPS, WALL, FPS, BPM, VIDEO } from "./timeline.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const E2E = path.resolve(HERE, "..");
const SHOTS = path.join(E2E, "shots", "promo");
const OUT = path.join(SHOTS, "video");
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = arg("--frames")?.split(",").map(Number) ?? null;
const sheet = arg("--sheet") ? Number(arg("--sheet")) : null;

// a small static server for compose.html, timeline.mjs and the frames
const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".png": "image/png", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.join(E2E, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(E2E) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// every scene the edit uses
const scenes = new Set([...CLIPS.flatMap((c) => (c.ranges ?? []).map((r) => r.scene)), ...WALL.map((w) => w.scene)]);
const manifests = {};
for (const scene of scenes) manifests[scene] = JSON.parse(fs.readFileSync(path.join(SHOTS, scene, "manifest.json"), "utf8"));
const title = handwriting("Ink Notebook", { size: 1, seed: 7, wobble: 0.45, slant: 0.05 });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium", args: ["--font-render-hinting=none"] });
const page = await browser.newPage({ viewport: { width: VIDEO.w, height: VIDEO.h }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(`${base}/promo/compose.html`);
await page.waitForFunction(() => typeof window.setup === "function");
const info = await page.evaluate((data) => window.setup(data), { manifests, title });
console.log(`▶ ${info.total} frames (${(info.total / FPS).toFixed(2)} s):`, info.clips.map((c) => `${c.id} ${(c.frames / FPS).toFixed(1)}s`).join(", "));

const shot = () => page.screenshot({ type: "png", clip: { x: 0, y: 0, width: VIDEO.w, height: VIDEO.h } });

if (only || sheet) {
  const list = only ?? Array.from({ length: Math.ceil(info.total / sheet) }, (_, i) => i * sheet);
  const dir = path.join(OUT, "frames");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of list) {
    await page.evaluate((f) => window.renderFrame(f), f);
    fs.writeFileSync(path.join(dir, `frame-${String(f).padStart(4, "0")}.png`), await shot());
  }
  console.log(`  ✓ ${list.length} frames in ${dir}`);
} else {
  const silent = path.join(OUT, "silent.mp4");
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", silent], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((r) => ff.on("close", r));
  const cues = [];
  const t0 = Date.now();
  for (let f = 0; f < info.total; f++) {
    cues.push(await page.evaluate((f) => window.renderFrame(f), f));
    const buf = await shot();
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    if (f % 90 === 0) console.log(`  ${f}/${info.total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  await done;
  const cuesFile = path.join(OUT, "cues.json");
  fs.writeFileSync(cuesFile, JSON.stringify({ fps: FPS, bpm: BPM, total: info.total, clips: info.clips, frames: cues }));
  console.log(`  ✓ ${silent}`);
  const wav = path.join(OUT, "sound.wav");
  const final = path.join(OUT, "ink-notebook-promo.mp4");
  const run = (cmd, a) => new Promise((resolve, reject) => spawn(cmd, a, { stdio: "inherit" }).on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)))));
  await run("python3", ["-I", path.join(HERE, "sound.py"), cuesFile, wav]);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final]);
  console.log(`  ✓ ${final}`);
}
await browser.close();
server.close();
