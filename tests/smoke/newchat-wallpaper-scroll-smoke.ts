// Browser smoke: scrolling the new-chat suggestion rail never stops the animated wallpaper.
// Counts the engine's drawn frames on the new-chat canvas (no pixels read) before, during and after
// wheel scrolling and a drag-like scroll of the rail, at 1280 and 375. Run it on a GPU (or pass
// BUTLER_SMOKE_BROWSER_ARGS with GPU flags): on software GL the engine holds still frames by design.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";

type DrawWindow = Window & { __wallpaperDraws: number };
const RAIL = '[data-test-class="new-chat-suggestion-rail"]';
const CANVAS = 'canvas[data-test-class~="new-chat-fluid-gradient"]';

async function drawsOver(page: Page, ms: number, during?: () => Promise<void>): Promise<number> {
  await page.evaluate(() => { (window as unknown as DrawWindow).__wallpaperDraws = 0; });
  const started = Date.now();
  await (during ? during() : page.waitForTimeout(ms));
  const elapsed = Math.max(Date.now() - started, ms);
  if (elapsed > ms) await page.waitForTimeout(0);
  const draws = await page.evaluate(() => (window as unknown as DrawWindow).__wallpaperDraws);
  return (draws * 1000) / elapsed;
}

const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const results: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const target = window as unknown as DrawWindow;
    target.__wallpaperDraws = 0;
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    let pending = false;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      // One count per drawn frame: a two-pass module issues several draw calls in the same task.
      if (!pending && (this.canvas as HTMLCanvasElement).matches?.('[data-test-class~="new-chat-fluid-gradient"]')) {
        target.__wallpaperDraws++;
        pending = true;
        queueMicrotask(() => { pending = false; });
      }
      return draw.apply(this, args);
    };
  });
  await server.signIn(page);
  // Modules that read u_contentRect (the rail's visible cards) and one that does not; diatom is two-pass.
  for (const module of ["butler.shoreline", "butler.diatom", "butler.bloom"]) for (const width of [1280, 375]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({
      wallpaper: { source: { kind: "live", module }, motion: "auto", pauseOnBattery: false },
    }) });
    const key = `${module} ${width}`;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.url);
    const canvas = page.locator(CANVAS).first();
    await canvas.waitFor({ state: "attached" });
    await page.locator(RAIL).waitFor();
    await page.waitForTimeout(1500);
    // Software GL holds still frames by design (data-wallpaper-fallback); nothing animates to stop.
    if (await canvas.getAttribute("data-wallpaper-fallback")) {
      results[key] = { skipped: "software GL fallback" };
      continue;
    }
    const scrollable = await page.locator(RAIL).evaluate((rail) => rail.scrollWidth > rail.clientWidth + 1);
    const box = (await page.locator(RAIL).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await drawsOver(page, 1000);
    const wheel = await drawsOver(page, 1500, async () => {
      for (let step = 0; step < 90; step += 1) {
        await page.mouse.wheel(step % 30 < 15 ? 60 : -60, 0);
        await page.waitForTimeout(16);
      }
    });
    const afterWheel = await drawsOver(page, 1500);
    // A finger drag scrolls the rail every frame without wheel events.
    const drag = await drawsOver(page, 1500, async () => {
      await page.locator(RAIL).evaluate(async (rail) => {
        const end = performance.now() + 1500;
        let direction = 1;
        while (performance.now() < end) {
          rail.scrollLeft += 12 * direction;
          if (rail.scrollLeft <= 0 || rail.scrollLeft >= rail.scrollWidth - rail.clientWidth) direction = -direction;
          await new Promise((next) => requestAnimationFrame(next));
        }
      });
    });
    const afterDrag = await drawsOver(page, 1500);
    const row = { scrollable, before, wheel, afterWheel, drag, afterDrag };
    results[key] = row;
    console.log(`newchat wallpaper scroll ${key}: ${JSON.stringify(row)}`);
    assert(before >= 12, `${key}: the wallpaper animates before scrolling (${before.toFixed(1)} draws/s)`);
    for (const [phase, rate] of Object.entries({ wheel, afterWheel, drag, afterDrag })) {
      assert(rate >= 12, `${key}: the wallpaper keeps drawing ${phase} (${rate.toFixed(1)} draws/s)`);
      assert(rate <= 22, `${key}: the 20fps cap holds ${phase} (${rate.toFixed(1)} draws/s)`);
    }
  }
  console.log(JSON.stringify({ ok: true, service: "newchat-wallpaper-scroll-smoke", results }));
} finally {
  await browser.close();
  await server.stop();
}
