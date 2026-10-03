/** Deterministic DS frames (fixed 20 Hz simulation, seeded DS grain), encoded by ffmpeg. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser";

const root = resolve(import.meta.dir, "../../../../..");
const mark = join(root, "packages/butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark");
const output = resolve(process.argv[2] ?? join(import.meta.dir, "../assets/butler-install.gif"));
const temporary = mkdtempSync(join(tmpdir(), "butler-install-frames-"));
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const entry = join(temporary, "frames.ts");
  writeFileSync(entry, `
    import { createSurface, resizeSurface, drawFrame } from ${JSON.stringify(join(mark, "thinking-mark/canvas-drawing"))};
    import { MorphSim } from ${JSON.stringify(join(mark, "thinking-mark/motion"))};
    import { DESIGN_SIZE } from ${JSON.stringify(join(mark, "thinking-mark/constants"))};
    import { RISO_INKS, inkForButlerMarkTheme } from ${JSON.stringify(join(mark, "butlerMarkTheme"))};
    const canvas = document.querySelector('canvas');
    const surface = createSurface(canvas.getContext('2d'), inkForButlerMarkTheme('light'), RISO_INKS.light);
    resizeSurface(surface, 192, 192 / DESIGN_SIZE, 96);
    const simulation = new MorphSim();
    window.frame = (index) => {
      simulation.update(1 / 20, index < 50);
      drawFrame(surface, simulation, false);
      return canvas.toDataURL('image/png').split(',')[1];
    };
  `);
  const built = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!built.success) throw new Error("DS frame bundle failed");
  const page = await browser.newPage();
  await page.setContent('<canvas width="192" height="192"></canvas>');
  await page.addScriptTag({ content: await built.outputs[0]!.text() });
  for (let index = 0; index < 80; index += 1) {
    const png = await page.evaluate((i) => (window as any).frame(i), index);
    writeFileSync(join(temporary, `${String(index).padStart(3, "0")}.png`), Buffer.from(png, "base64"));
  }
  execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", "20", "-i", join(temporary, "%03d.png"),
    "-filter_complex", "split[a][b];[a]palettegen=max_colors=64:reserve_transparent=1[p];[b][p]paletteuse=dither=none",
    "-loop", "0", "-gifflags", "+transdiff", output]);
  const signature = readFileSync(output).subarray(0, 6).toString();
  if (signature !== "GIF89a") throw new Error("Invalid animated GIF");
  console.log(JSON.stringify({ output, bytes: statSync(output).size, width: 192, height: 192, frames: 80, fps: 20 }));
} finally {
  await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
