import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { lifecycleBrowser, uiRoot } from "./lifecycle-browser";
import { wallpaperPosterInputs } from "./wallpaper-poster-inputs";

export const stillDirectory = resolve(uiRoot, "src/components/lifecycle/stills");
function inputs() {
  return { ...wallpaperPosterInputs(uiRoot), generator: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
    encoder: createHash("sha256").update(readFileSync(resolve(uiRoot, "src/components/lifecycle/still.ts"))).digest("hex") };
}
export function checkLifecycleStills() {
  const keys = JSON.parse(readFileSync(join(stillDirectory, "keys.json"), "utf8"));
  if (JSON.stringify(keys.inputs) !== JSON.stringify(inputs())) throw new Error("Lifecycle stills are stale. Run bun run packages/butler-app/client/ui/scripts/generate-lifecycle-stills.ts.");
  for (const entry of Object.values(keys.stills) as Array<{ file: string; sha256: string; bytes: number }>) {
    if (entry.bytes > 81_920) throw new Error(`${entry.file} exceeds 80 KiB: ${entry.bytes}`);
    if (createHash("sha256").update(readFileSync(join(stillDirectory, entry.file))).digest("hex") !== entry.sha256) throw new Error(`Lifecycle still changed: ${entry.file}`);
  }
}
async function generate() {
  const host = await lifecycleBrowser();
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
            frames.push({ key: `${id}|${tone}|${phase}`, file: `${id}.${tone}.${phase}.webp`, ...await encodeLifecycleStill(blob) });
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
    const oversized = results.frames.filter((frame) => frame.bytes.length > 81_920);
    if (oversized.length) console.error("Oversized lifecycle stills:", oversized.map((frame) => [frame.file, frame.bytes.length]));
    writeFileSync(join(stillDirectory, "keys.json"), JSON.stringify({ inputs: inputs(), modules, stills }, null, 2) + "\n");
    if (oversized.length) throw new Error("Lifecycle still budget exceeded; optimize encoding without reducing quality.");
    console.log(JSON.stringify({ stills: results.frames.length, maximumBytes: Math.max(...results.frames.map((f) => f.bytes.length)) }));
  } finally { await host.close(); }
}
export function lifecycleStillFiles() { return readdirSync(stillDirectory).filter((file) => file.endsWith(".webp") || file === "keys.json"); }
if (import.meta.main) {
  if (process.argv.includes("--check")) { checkLifecycleStills(); console.log("Lifecycle stills are current."); }
  else await generate();
}
