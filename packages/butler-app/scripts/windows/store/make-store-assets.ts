import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../../../../../tests/support/smoke-browser-args";

const output = resolve(process.argv[2] ?? join(import.meta.dir, "Assets"));
const icon = readFileSync(resolve(import.meta.dir, "../../../client/electron/assets/icon.png"));
const assets = [
  ...[100, 200, 400].map(scale => [`Square44x44Logo.scale-${scale}.png`, 44 * scale / 100, 44 * scale / 100, 44 * scale / 100] as const),
  ...[16, 24, 32, 48, 256].flatMap(size => ["", "_altform-unplated", "_altform-lightunplated"].map(form => [`Square44x44Logo.targetsize-${size}${form}.png`, size, size, size] as const)),
  ...[100, 200, 400].map(scale => [`Square150x150Logo.scale-${scale}.png`, 150 * scale / 100, 150 * scale / 100, Math.round(75 * scale / 100)] as const),
  ...[100, 200, 400].map(scale => [`Wide310x150Logo.scale-${scale}.png`, 310 * scale / 100, 150 * scale / 100, Math.round(75 * scale / 100)] as const),
  ...[100, 200, 400].map(scale => [`StoreLogo.scale-${scale}.png`, 50 * scale / 100, 50 * scale / 100, 50 * scale / 100] as const),
];
mkdirSync(output, { recursive: true });
for (const file of readdirSync(output)) {
  if (file.endsWith(".png")) rmSync(join(output, file));
}
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage();
  const images = await page.evaluate(async ({ source, assets }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return assets.map(([name, width, height, side]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side);
      return { name, png: canvas.toDataURL("image/png").split(",")[1] };
    });
  }, { source: `data:image/png;base64,${icon.toString("base64")}`, assets });
  for (const { name, png } of images) writeFileSync(join(output, name), Buffer.from(png, "base64"));
  console.log(JSON.stringify({ output, files: images.length }));
} finally {
  await browser.close();
}
