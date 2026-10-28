// test-category: format-pin
import { strict as assert } from "node:assert";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

/** Owner-review crops preserve the real layout and verify the PNG device scale. */
export async function captureRegion(page: Page, directory: string, name: string,
  regions: Locator[], options: { focus?: boolean; toast?: boolean } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await regions[0]!.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  if (!options.focus) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('[role="menu"]').waitFor({ state: "detached" });
  if (!options.toast) await page.locator('[data-sonner-toast]').waitFor({ state: "detached" });
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation => animation.timeline instanceof DocumentTimeline
      && animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
  });
  // Paint the settled state after overlay detachment.
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await page.getByText(/Retry to continue|답변 실패/u).count(), 0, "Clean capture scene");
  const boxes = [];
  for (const region of regions) {
    await region.waitFor({ state: "visible" });
    const box = await region.boundingBox(); assert(box); boxes.push(box);
  }
  if (options.toast) for (const button of await page.locator('[data-sonner-toast] [data-close-button]').all()) {
    const box = await button.boundingBox(); if (box) boxes.push(box);
  }
  for (const overlay of await page.locator('[data-slot="popover-content"]:visible').all()) {
    const box = await overlay.boundingBox(); if (box) boxes.push(box);
  }
  const x = Math.floor(Math.min(...boxes.map(box => box.x)));
  const y = Math.floor(Math.min(...boxes.map(box => box.y)));
  const right = Math.ceil(Math.max(...boxes.map(box => box.x + box.width)));
  const bottom = Math.ceil(Math.max(...boxes.map(box => box.y + box.height)));
  const clip = { x, y, width: right - x, height: bottom - y };
  const viewport = page.viewportSize(); assert(viewport);
  assert(x >= 0 && y >= 0 && right <= viewport.width && bottom <= viewport.height,
    `${name}: region must fit the visible viewport: ${JSON.stringify(clip)}`);
  const png = await page.screenshot({ path: join(directory, `${name}.png`), clip, animations: "disabled", scale: "device" });
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(await page.evaluate(() => devicePixelRatio), 2);
  assert.equal(width, clip.width * 2, "PNG width is twice its CSS crop width");
  assert.equal(height, clip.height * 2, "PNG height is twice its CSS crop height");
  appendFileSync(join(directory, "sizes.txt"), `${name}.png ${width}x${height}\n`);
}
