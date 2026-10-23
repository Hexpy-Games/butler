import { strict as assert } from "node:assert";
import type { Page } from "playwright";

export function canonInspectorClose(page: Page) {
  return page.locator(page.viewportSize()!.width === 390
    ? '[data-test-class="right-panel-overlay-close"]' : '[data-test-class="titlebar-right-panel-toggle"]');
}

export async function closeCanonInspector(page: Page) {
  await canonInspectorClose(page).click();
  await page.locator('[data-test-class~="right-inspector-open"]').waitFor({ state: "hidden" });
  assert.equal(await page.locator('[data-test-class="canon-board"] [data-selected="true"]').count(), 0,
    "Closing the inspector deselects the card");
}

export async function verifyCanonInspector(page: Page) {
  const inspector = page.locator('[data-test-class~="right-inspector-open"]');
  const box = await inspector.boundingBox();
  assert(box && box.height >= page.viewportSize()!.height - 70, "App inspector fills the available height");
  if (page.viewportSize()!.width === 390) {
    const drawer = page.locator('[data-slot="adaptive-shell-inspector"][data-open="true"]');
    const bounds = await drawer.boundingBox();
    assert(bounds && bounds.width === 390, "Phone detail uses the full-screen inspector drawer");
  } else {
    const board = page.locator('[data-test-class="canon-board"]');
    const detail = inspector.locator('[data-test-class="canon-epic-detail"]');
    const firstId = await detail.getAttribute("data-epic-id");
    const other = board.locator('[data-kanban-item]').filter({ hasText: "문서" }).getByRole("button").first();
    await other.click();
    await detail.getByRole("heading", { name: "문서", exact: true }).waitFor();
    assert.notEqual(await detail.getAttribute("data-epic-id"), firstId, "Selecting another card updates the inspector");
    assert.equal(await detail.getByRole("button", { name: "대화 열기", exact: true }).count(), 0);
    await board.locator(`[data-kanban-item="${firstId}"]`).getByRole("button").click();
    await detail.getByRole("heading", { name: "캐논", exact: true }).waitFor();
  }
}
