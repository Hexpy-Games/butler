import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, type Page } from "playwright";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser-args";
import { lifecycleBrowser, uiRoot } from "./lifecycle-browser";
import { wallpaperPosterInputs } from "./wallpaper-poster-inputs";

export const stillDirectory = resolve(uiRoot, "src/components/lifecycle/stills");
function inputs() {
  return { ...wallpaperPosterInputs(uiRoot), generator: createHash("sha256").update(readFileSync(resolve(uiRoot, "scripts/generate-lifecycle-stills.ts"))).digest("hex"),
    encoder: createHash("sha256").update(readFileSync(resolve(uiRoot, "src/components/lifecycle/still.ts"))).digest("hex") };
}
export async function checkLifecycleStills(decode = true, renderer?: Page) {
  const keys = JSON.parse(readFileSync(join(stillDirectory, "keys.json"), "utf8"));
  if (JSON.stringify(keys.inputs) !== JSON.stringify(inputs())) throw new Error("Lifecycle stills are stale. Run bun run packages/butler-app/client/ui/scripts/generate-lifecycle-stills.ts.");
  const frames = Object.values(keys.stills) as Array<{ file: string; sha256: string; bytes: number }>;
  const encoded = frames.map((entry) => {
    const bytes = readFileSync(join(stillDirectory, entry.file));
    if (bytes.length !== entry.bytes || bytes.length > 320 * 1024) throw new Error(`${entry.file} exceeds 320 KiB or has an incorrect byte count: ${bytes.length}`);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Lifecycle still changed: ${entry.file}`);
    return { file: entry.file, bytes: Array.from(bytes) };
  });
  if (!decode) return;
  const browser = renderer ? undefined : await chromium.launch({ headless: true, args: smokeBrowserArgs(), executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = renderer ?? await browser!.newPage();
    if (!renderer) await page.setContent("<!doctype html><html><body>Lifecycle still decode</body></html>");
    const rows = await page.evaluate(async (frames) => {
      // Drain renderer initialization and argument transport before timing; no image warm-up.
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const rows = [];
      for (const frame of frames) {
        const blob = new Blob([new Uint8Array(frame.bytes)], { type: "image/webp" });
        const start = performance.now();
        const image = await createImageBitmap(blob);
        const decodeMs = performance.now() - start;
        if (image.width !== 720 || image.height !== 528) throw new Error(`Incorrect still dimensions: ${frame.file}`);
        image.close();
        rows.push({ file: frame.file, decodeMs });
      }
      return rows;
    }, encoded);
    console.log(JSON.stringify({ rows, stills: rows.length, maximumBytes: Math.max(...frames.map((frame) => frame.bytes)), maximumDecodeMs: Math.max(...rows.map((row) => row.decodeMs)), decoder: "renderer createImageBitmap" }));
    const slow = rows.filter((row) => row.decodeMs > 15);
    if (slow.length) throw new Error(`Lifecycle still decode exceeds 15 ms: ${JSON.stringify(slow)}`);
  } finally { await browser?.close(); }
}
async function generate() {
  const host = await lifecycleBrowser("/scripts/lifecycle-still-render.ts");
  const stills: Record<string, unknown> = {};
  let modules: Record<string, unknown> = {};
  mkdirSync(stillDirectory, { recursive: true });
  try {
    const page = await host.browser.newPage();
    await page.goto(host.url);
    const results = await page.evaluate(async () => {
      const registryPath = "/src/libs/design-system/blocks/Wallpaper/registry.ts";
      const stillPath = "/src/libs/design-system/blocks/Wallpaper/still.ts";
      const encoderPath = "/src/components/lifecycle/still.ts";
      const { BUILTIN_WALLPAPERS } = await import(/* @vite-ignore */ registryPath);
      const { renderWallpaperStill } = await import(/* @vite-ignore */ stillPath);
      const { encodeLifecycleStill } = await import(/* @vite-ignore */ encoderPath);
      const modules: Record<string, unknown> = {};
      const frames = [];
      for (const module of BUILTIN_WALLPAPERS.list()) {
        if (module.manifest.image === "required" && !module.defaultImage) continue;
        const id = module.manifest.id;
        const shared = ["butler.dusk", "butler.shoreline", "butler.photo-clouds", "butler.photo-daisies"].includes(id);
        const dayPhase = id === "butler.shoreline";
        const scene = module.manifest.sceneTone;
        modules[id] = { shared, dayPhase, sceneTone: scene ? { ...scene, default: module.manifest.params.find((p: any) => p.key === scene.param)?.default } : null };
        for (const tone of shared ? ["light"] : ["light", "dark"]) {
          for (let phase = 0; phase < (dayPhase ? 4 : 1); phase++) {
            const blob = await renderWallpaperStill(module, { width: 720, height: 528, compositionWidth: 720, pixelRatio: 2,
              contentRect: { x: 32, y: 60, width: 296, height: 144 }, dayPhase: dayPhase ? (phase + 0.5) / 4 : 0.5 }, tone);
            frames.push({ key: `${id}|${tone}|${phase}`, file: `${id}.${tone}.${phase}.webp`, ...await encodeLifecycleStill(blob, id === "butler.stipple" ? 0.8 : 0.9) });
          }
        }
      }
      return { modules, frames };
    });
    modules = results.modules;
    for (const frame of results.frames) {
      const bytes = Buffer.from(frame.bytes);
      
      writeFileSync(join(stillDirectory, frame.file), bytes);
      stills[frame.key] = { file: frame.file, averageColor: frame.averageColor, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
    const oversized = results.frames.filter((frame) => frame.bytes.length > 320 * 1024);
    if (oversized.length) console.error("Oversized lifecycle stills:", oversized.map((frame) => [frame.file, frame.bytes.length]));
    writeFileSync(join(stillDirectory, "keys.json"), JSON.stringify({ inputs: inputs(), modules, stills }, null, 2) + "\n");
    if (oversized.length) throw new Error("Lifecycle still budget exceeded; optimize encoding without reducing quality.");
    console.log(JSON.stringify({ stills: results.frames.length, maximumBytes: Math.max(...results.frames.map((f) => f.bytes.length)) }));
  } finally { await host.close(); }
}
export function lifecycleStillFiles() { return readdirSync(stillDirectory).filter((file) => file.endsWith(".webp") || file === "keys.json"); }
if (import.meta.main) {
  if (process.argv.includes("--check")) { await checkLifecycleStills(); console.log("Lifecycle stills are current."); }
  else { await generate(); await checkLifecycleStills(); }
}
