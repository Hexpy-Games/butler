// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { probeFocusRing } from "./focus-ring-clipping.ts";

export function canonAsideClose(page: Page) {
  return page.locator('[data-test-class="canon-aside-close"]');
}

export async function closeCanonAside(page: Page) {
  await canonAsideClose(page).click();
  await page.locator('[data-slot="management-page-aside"]').waitFor({ state: "hidden" });
  assert.equal(await page.locator('[data-test-class="canon-board"] [data-selected="true"]').count(), 0,
    "Closing the aside deselects the card");
}

export async function verifyCanonAside(page: Page) {
  const aside = page.locator('[data-slot="management-page-aside"]');
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-slot="management-page-aside"]');
    return pane?.getAttribute("data-state") === "open" && getComputedStyle(pane).opacity === "1";
  });
  assert.equal(await aside.count(), 1, "Only the settled aside is present");
  assert.equal(await aside.getByRole("button", { name: "대화 열기", exact: true }).count(), 1);
  if (await aside.getAttribute("data-layout") === "docked") {
    const card = aside.locator('[data-slot="card"]').first();
    assert.equal(await card.locator('[data-test-class="canon-aside-close"]').count(), 1);
    assert.deepEqual(await card.evaluate(element => {
      const css = getComputedStyle(element);
      return { radius: css.borderRadius, shadow: css.boxShadow, glass: css.backdropFilter };
    }), { radius: "8px", shadow: "none", glass: "none" });
  }
  const box = await aside.boundingBox();
  assert(box && box.width > 250 && box.height > 300, "Detail stays usable in the page aside");
  const pageWidth = await page.locator('[data-test-class="project-dashboard-view"]').evaluate(element => element.getBoundingClientRect().width);
  assert.equal(await aside.getAttribute("data-layout"), pageWidth >= 1000 ? "docked" : "floating");
  await canonAsideClose(page).focus();
  await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
  const ring = await probeFocusRing(page);
  assert(ring && !ring.noIndicator);
  assert.deepEqual(ring.clips, [], "Aside close focus ring is not clipped");
  if (page.viewportSize()!.width === 390) return;
  const board = page.locator('[data-test-class="canon-board"]');
  const detail = aside.locator('[data-test-class="canon-epic-detail"]');
  const firstId = await detail.getAttribute("data-epic-id");
  await board.locator('[data-kanban-item]').filter({ hasText: "문서" }).getByRole("button").first().click();
  await detail.getByRole("heading", { name: "문서", exact: true }).waitFor();
  assert.notEqual(await detail.getAttribute("data-epic-id"), firstId);
  assert.equal(await detail.getByRole("button", { name: "대화 열기", exact: true }).count(), 0);
  const first = board.locator('[data-kanban-item="' + firstId + '"]').getByRole("button");
  await first.click();
  await detail.getByRole("heading", { name: "캐논", exact: true }).waitFor();
  await first.click();
  await aside.waitFor({ state: "hidden" });
  await first.click();
  await detail.getByRole("heading", { name: "캐논", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await aside.waitFor({ state: "hidden" });
  await first.click();
  await detail.getByRole("heading", { name: "캐논", exact: true }).waitFor();
}
