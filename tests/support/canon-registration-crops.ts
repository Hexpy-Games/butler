import { strict as assert } from "node:assert";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { auditCanonFacts } from "./canon-registration-cards.ts";

export const cropDirectory = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-registration-crops";
export const cropPhase = process.env.BUTLER_SMOKE_CROP_PHASE ?? (process.env.BUTLER_SMOKE_BASELINE === "1" ? "before" : "after");
export const shouldCaptureState = (state: string) => !process.env.BUTLER_SMOKE_CROP_STATES || process.env.BUTLER_SMOKE_CROP_STATES.split(",").includes(state);

/** Wait for actual portal removal and completed motion, including menu exit fades. */
export async function settleCrop(page: Page, region: Locator) {
  await page.mouse.move(page.viewportSize()!.width - 8, page.viewportSize()!.height - 8);
  await page.locator(":focus").evaluateAll(elements => elements.forEach(element => (element as HTMLElement).blur()));
  for (const close of await page.locator("[data-sonner-toast]").getByRole("button", { name: "Close toast", exact: true }).all()) await close.click();
  try {
    await page.waitForFunction(() => {
      // Resize handles keep a CSS-hidden hint mounted; floating tooltip portals detach.
      if (document.querySelector('[role="menu"], [role="tooltip"]:not([data-slot="resize-hint"]), [data-sonner-toast]')) return false;
      return [...document.querySelectorAll('[data-slot="resize-hint"]')].every(element => {
        const style = getComputedStyle(element);
        return style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0;
      });
    });
  } catch (error) {
    console.error(await page.locator('[role="menu"], [role="tooltip"], [data-sonner-toast]').evaluateAll(elements => elements.map(element => element.outerHTML)));
    throw error;
  }
  await region.evaluate(async element => {
    // ScrollTimeline edge fades describe scroll position and never finish in time.
    const animations = element.getAnimations({ subtree: true }).filter(animation =>
      animation.timeline instanceof DocumentTimeline && animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  assert.equal(await page.getByText(/Retry to continue|답변 실패/u).count(), 0, "clean transcript");
}

/** Outward rounding retains the complete box, including antialiased borders. */
export async function cropRegion(page: Page, region: Locator, name: string) {
  await region.scrollIntoViewIfNeeded();
  await settleCrop(page, region);
  const box = await region.boundingBox(); assert(box);
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y) };
  assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= page.viewportSize()!.width, "complete region inside viewport");
  assert.equal(await page.evaluate(() => devicePixelRatio), 2);
  const png = await page.screenshot({ path: join(cropDirectory, `${name}.png`), clip, scale: "device", animations: "disabled" });
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(width, 2 * clip.width, `${name}: PNG width equals twice its CSS crop box`);
  assert.equal(height, 2 * clip.height, `${name}: PNG height equals twice its CSS crop box`);
  appendFileSync(join(cropDirectory, "sizes.txt"), `${name}.png ${width}x${height}\n`);
  appendFileSync(join(cropDirectory, "boxes.jsonl"), `${JSON.stringify({ name, box, clip, pixels: { width, height }, dpr: 2 })}\n`);
  console.log(`${name}.png ${width}x${height}`);
}

export async function cardMatrix(page: Page, server: NativeAppServerHandle, id: string, state: string, language = "ko") {
  if (!shouldCaptureState(state)) return;
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) {
    const source = background === "wallpaper" ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" };
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme, conversation_background: { source, overlay: 0 }, wallpaper: { source, motion: "paused" } }) });
    await page.setViewportSize({ width, height: 1100 });
    await page.reload();
    await page.waitForFunction(locale => document.documentElement.lang.startsWith(locale), language);
    await page.locator('[data-test-class~="conversation-wallpaper"][data-module="butler.bloom"]').waitFor({ state: background === "wallpaper" ? "attached" : "detached" });
    const card = page.locator(`[data-proposal-id="${id}"]`);
    await card.waitFor();
    assert.equal(await card.getAttribute("data-state"), state === "applied" ? "applied" : state === "declined" ? "cancelled" : "open");
    if (state === "changes-open") {
      const disclosure = card.getByRole("button", { name: "변경 내용", exact: true });
      await disclosure.click(); assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
    }
    if (state === "draft") assert.equal(await card.getByRole("combobox").count(), 0, "same project needs no project select");
    if (state === "draft-en") await card.getByText("Add Epic to Backlog", { exact: true }).waitFor();
    if (state === "draft-other-project") {
      await card.getByRole("combobox", { name: "프로젝트", exact: true }).waitFor();
      assert.equal(await card.locator("select option:checked").textContent(), "다른 제품");
    }
    if (state === "epic-move") await card.getByText("다음 릴리스", { exact: true }).waitFor();
    if (cropPhase === "after") await auditCanonFacts(card);
    await cropRegion(page, card, `${cropPhase}-${state}-${width}-${theme}-${background}`);
  }
}
