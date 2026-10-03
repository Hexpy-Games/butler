import assert from "node:assert/strict";
import type { Page } from "playwright";

const frameCount = (page: Page) => page.locator("[data-decoration-perf]").evaluate(node => JSON.parse((node as HTMLElement).dataset.metrics!).frames as number);

/** Exercise cancellation during a burst, including starting under OS reduced motion. */
export async function checkDecorationLifecycle(page: Page) {
  const input = page.getByRole("textbox", { name: "Try your message" });
  await page.getByLabel("Decoration", { exact: true }).selectOption("flowers");
  await input.pressSequentially("pulse");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenFrames = await frameCount(page);
  await page.waitForTimeout(400);
  assert.equal(await frameCount(page), hiddenFrames, "hidden page cancels its burst");
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(100);
  assert.equal(await frameCount(page), hiddenFrames, "visibility resumes at rest");
  await input.pressSequentially("blur");
  await input.blur();
  const blurredFrames = await frameCount(page);
  await page.waitForTimeout(400);
  assert.equal(await frameCount(page), blurredFrames, "editor blur cancels its burst");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Decoration", { exact: true }).selectOption("characters");
  await input.pressSequentially("quiet");
  await page.waitForTimeout(400);
  assert.equal(await frameCount(page), 0, "OS reduction overrides Interactive");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await input.press("a");
  await page.waitForFunction(() => document.querySelector("[data-decoration-layer]")!.getAnimations({ subtree: true }).some(a => a.playState === "running"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(50);
  assert.equal(await page.locator("[data-decoration-layer]").evaluate(node => node.getAnimations({ subtree: true }).filter(a => a.playState === "running").length), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
