import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser-args";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

const ui = resolve(import.meta.dir, "../../ui");
const mark = join(ui, "src/libs/design-system/components/ButlerThinkingMark");
const tokens = readFileSync(join(ui, "src/libs/design-system/tokens.css"), "utf8");
// Light DS surface (--color-surface-base -> --grayscale-01): the installer tile in every Windows theme.
const surface = /--grayscale-01:\s*(#[0-9a-f]{6})/iu.exec(tokens)?.[1];
if (!surface) throw new Error("DS --grayscale-01 token missing");
const output = resolve(process.argv[2] ?? join(import.meta.dir, "../assets/butler-install.gif"));

const TILE = 192;
const MARK = 168;
const RADIUS = Math.round((TILE * 58) / 256); // butler-icon.svg: rx 58 on 256
const FPS = 20;
const HOLD = 10;
const WORKING = 50;
const MAX_SETTLE = 160;

const temporary = mkdtempSync(join(tmpdir(), "butler-install-gif-"));
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const entry = join(temporary, "frames.ts");
  writeFileSync(entry, `
    import { createSurface, resizeSurface, drawFrame } from ${JSON.stringify(join(mark, "thinking-mark/canvas-drawing"))};
    import { MorphSim } from ${JSON.stringify(join(mark, "thinking-mark/motion"))};
    import { DESIGN_SIZE } from ${JSON.stringify(join(mark, "thinking-mark/constants"))};
    import { RISO_INKS, inkForButlerMarkTheme } from ${JSON.stringify(join(mark, "butlerMarkTheme"))};
    const out = document.querySelector('canvas');
    const o = out.getContext('2d');
    const markCanvas = document.createElement('canvas');
    const s = createSurface(markCanvas.getContext('2d'), inkForButlerMarkTheme('light'), RISO_INKS.light);
    resizeSurface(s, ${MARK}, ${MARK} / DESIGN_SIZE, ${MARK / 2});
    const sim = new MorphSim();
    window.frame = (working) => {
      sim.update(1 / ${FPS}, working);
      drawFrame(s, sim, false);
      o.clearRect(0, 0, ${TILE}, ${TILE});
      o.fillStyle = ${JSON.stringify(surface)};
      o.beginPath();
      o.roundRect(0, 0, ${TILE}, ${TILE}, ${RADIUS});
      o.fill();
      o.drawImage(markCanvas, ${(TILE - MARK) / 2}, ${(TILE - MARK) / 2});
      return { png: out.toDataURL('image/png').split(',')[1], rest: sim.idle };
    };
  `);
  const built = await Bun.build({ entrypoints: [entry], target: "browser" });
  if (!built.success) throw new Error("DS frame bundle failed");
  const page = await browser.newPage();
  await page.setContent(`<canvas width="${TILE}" height="${TILE}"></canvas>`);
  await page.addScriptTag({ content: await built.outputs[0]!.text() });
  const frames: string[] = [];
  const step = (working: boolean) => page.evaluate((w) => (window as unknown as { frame: (w: boolean) => { png: string; rest: boolean } }).frame(w), working);
  for (let i = 0; i < HOLD; i += 1) frames.push((await step(false)).png);
  for (let i = 0; i < WORKING; i += 1) frames.push((await step(true)).png);
  let settled = false;
  for (let i = 0; i < MAX_SETTLE && !settled; i += 1) {
    const frame = await step(false);
    settled = frame.rest;
    // The rest frame equals the hold frames that open the loop, so it is not repeated.
    if (!settled) frames.push(frame.png);
  }
  if (!settled) throw new Error("Mark did not settle back to the logo");
  if (frames[0] !== (await step(false)).png) throw new Error("Loop seam: rest frame differs from the first frame");
  frames.forEach((png, index) => writeFileSync(join(temporary, `${String(index).padStart(3, "0")}.png`), Buffer.from(png, "base64")));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-framerate", String(FPS), "-i", join(temporary, "%03d.png"),
    "-filter_complex", "split[a][b];[a]palettegen=max_colors=64:reserve_transparent=1[p];[b][p]paletteuse=dither=none:alpha_threshold=128",
    "-loop", "0", "-gifflags", "+transdiff", output]);
  const encoded = readFileSync(output);
  if (encoded.subarray(0, 6).toString() !== "GIF89a") throw new Error("Invalid GIF signature");
  if (encoded.length > 600_000) throw new Error("Installer GIF exceeds 600 KB");
  console.log(JSON.stringify({ sha256: createHash("sha256").update(encoded).digest("hex"), seam: "rest equals first", bytes: statSync(output).size, size: TILE, frames: frames.length, fps: FPS,
    seconds: frames.length / FPS, hold: HOLD, working: WORKING, settle: frames.length - HOLD - WORKING }));
} finally {
  await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
