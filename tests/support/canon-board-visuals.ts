import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";
import { verifyEpicLabel } from "./canon-sidebar-scenarios.ts";

export async function captureBoardEdges(page: Page, shots: string, name: string) {
  const board = page.locator('[data-test-class="canon-plan-lanes"]');
  await board.waitFor();
  const long = board.locator('[data-kanban-item]').filter({ hasText: "아주 긴 과제 제목" });
  await long.scrollIntoViewIfNeeded();
  await verifyEpicLabel(long);
  const avatar = await long.getByRole("img", { name: "나", exact: true }).boundingBox();
  assert(avatar && avatar.width >= 14, "Long title never shrinks the Avatar");
  await page.screenshot({ path: join(shots, `${name}-long-title.png`), animations: "disabled" });
  await board.evaluate(element => { element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2; });
  await page.waitForFunction(() => {
    const board = document.querySelector('[data-test-class="canon-plan-lanes"]');
    return board?.getAttribute("data-overflowing") === "true" && board.getAttribute("data-at-start") === "false"
      && board.getAttribute("data-at-end") === "false";
  });
  assert.equal(await board.getAttribute("data-scroll-fade"), "x");
  assert.notEqual(await board.evaluate(element => getComputedStyle(element).maskImage), "none");
  await board.hover();
  await page.screenshot({ path: join(shots, `${name}-hover-scrollbar.png`), animations: "disabled" });
  await board.evaluate(element => { element.scrollLeft = 0; });
}
