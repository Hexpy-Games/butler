// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

/** Exercise actual DS rendering; explicit cover must keep the default pixels. */
export async function checkAttachmentFit(page: Page, url: string) {
  const shots = process.env.BUTLER_ATTACHMENT_FIT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const theme of ["light", "dark"]) for (const width of [320, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width: Math.max(width, 900), height: 1000 });
    const params = new URLSearchParams({ visual: "design-system", page: "blocks/AttachmentList",
      theme, locale: "en", width: String(width), motion: "reduced" });
    await page.goto(url + "?" + params);
    const story = page.locator('[data-ds-story="Thumbnail fit (cover and contain)"]').first();
    await story.scrollIntoViewIfNeeded();
    const tiles = story.locator("[data-ds-theme]").first().locator('[data-slot="attachment-tile"]');
    await tiles.first().waitFor();
    await tiles.locator("img").evaluateAll(async images => {
      await Promise.all(images.map(image => (image as HTMLImageElement).decode()));
    });
    const state = await tiles.locator("img").evaluateAll(images => images.map(image => ({
      fit: getComputedStyle(image).objectFit, background: getComputedStyle(image).backgroundColor,
      width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight,
    })));
    assert.deepEqual(state.map(image => image.fit), ["cover", "cover", "contain", "contain"]);
    assert.ok(state[2]!.width > state[2]!.height * 5);
    assert.ok(state[3]!.height > state[3]!.width * 2);
    assert.ok(state.every(image => image.background !== "rgba(0, 0, 0, 0)"));
    assert.equal(await tiles.nth(0).evaluate(tile => tile.outerHTML),
      await tiles.nth(1).evaluate(tile => tile.outerHTML), "default and explicit cover markup");
    // Compare in the same pixel position; adjacent wrapping tiles may land on fractional coordinates.
    const before = await tiles.nth(0).screenshot({ animations: "disabled" });
    await tiles.nth(0).locator("img").evaluate(image => image.setAttribute("data-fit", "cover"));
    assert.deepEqual(await tiles.nth(0).screenshot({ animations: "disabled" }), before, "default cover pixels");
    await tiles.nth(0).locator("img").evaluate(image => image.removeAttribute("data-fit"));
    if (shots) await story.screenshot({ path: join(shots, `ds-${theme}-${width}.png`), animations: "disabled" });
  }
  console.log("PASS attachment fit: 10 theme/width cells; default cover pixels identical");
}
