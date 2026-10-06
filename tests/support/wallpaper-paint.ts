import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { judgeScreenshotPair } from "./visual-judge.ts";
import type { Page } from "playwright";

/** Wait for the module and tone actually drawn, rather than React's requested attributes. */
export async function assertWallpaperPaint(page: Page, selector: string, module: string): Promise<void> {
  try { await page.waitForFunction(({ selector, module }) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    return canvas?.dataset.wallpaperState === "painted" && canvas.dataset.paintedModule === module
      && canvas.dataset.paintedTone === canvas.dataset.tone && canvas.width > 0 && canvas.height > 0;
  }, { selector, module }); } catch (cause) {
    const state = await page.locator(selector).evaluate(canvas => ({ ...((canvas as HTMLCanvasElement).dataset) }));
    throw new Error(`Expected painted ${module}; actual ${JSON.stringify(state)}`, { cause });
  }
  await judgeWallpaperScreenshot(page, selector, module);
}

/** Semantic art checks are opt-in; ordinary smoke runs make no judge calls. */
export async function judgeWallpaperScreenshot(page: Page, selector: string, module: string): Promise<void> {
  if (process.env.BUTLER_VISUAL_JUDGE !== "1") return;
  const tone = await page.locator(selector).getAttribute("data-painted-tone");
  const output = process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/wallpaper-judge";
  mkdirSync(output, { recursive: true });
  const file = `${module}-${tone}-${page.viewportSize()?.width}.png`;
  const actual = join(output, file);
  await page.screenshot({ path: actual });
  const artwork = module === "butler.silk" ? "visible monochrome silk folds"
    : module === "butler.bloom" ? "visible flowing, softly tinted bloom art" : "visible wallpaper art";
  await judgeScreenshotPair({ actual, expected: process.env.BUTLER_VISUAL_EXPECTED_DIR
    ? join(process.env.BUTLER_VISUAL_EXPECTED_DIR, file) : undefined,
    expectation: `${module} in ${tone} tone: ${artwork}; readable foreground, no clipping or overlap.` });
}
