import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { openPlan, verifyOverviewLayout } from "./canon-sidebar-scenarios.ts";
export async function captureOverviewQA(page: Page, width: number, cell: string, shots: string,
  plans: { planId: string; emptyPlanId: string; singlePlanId: string }) {
  mkdirSync(shots, { recursive: true });
  for (const [id, count] of [[plans.emptyPlanId, 0], [plans.singlePlanId, 1], [plans.planId, 8]] as const) {
    await openPlan(page, id);
    const rows = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-id]');
    await assertCount(rows, count);
    await verifyOverviewLayout(page, width);
    await page.screenshot({ path: join(shots, `${cell}-${count}-rows.png`), animations: "disabled" });
  }
  const rows = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-id]');
  assert((await rows.last().innerText()).includes("아주 긴 과제 제목"));
  await rows.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, `${cell}-long-title.png`), animations: "disabled" });
  await rows.first().getByRole("combobox").click();
  await page.getByRole("listbox").waitFor();
  await page.screenshot({ path: join(shots, `${cell}-status-open.png`), animations: "disabled" });
  await page.keyboard.press("Escape");
  await rows.first().getByRole("button", { name: /메뉴$/u }).click();
  await page.getByRole("menu").waitFor();
  await page.screenshot({ path: join(shots, `${cell}-menu-open.png`), animations: "disabled" });
  await page.keyboard.press("Escape");
  await captureOverviewDrag(page, join(shots, `${cell}-drag.png`));
}
async function assertCount(rows: import("playwright").Locator, count: number) {
  if (count) await rows.nth(count - 1).waitFor();
  else await rows.page().getByText("아직 과제가 없습니다", { exact: true }).waitFor();
  assert.equal(await rows.count(), count);
}
export async function captureOverviewDrag(page: Page, path: string) {
  const handles = page.locator('[data-test-class="canon-plan-epics"] [data-sortable-handle]');
  await handles.first().scrollIntoViewIfNeeded();
  const first = await handles.first().boundingBox(), next = await handles.nth(1).boundingBox();
  assert(first && next);
  try {
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2, { steps: 12 });
    await page.getByText(/^Dragging .+ Use arrow keys to move it\.$/u).waitFor();
    await page.screenshot({ path, animations: "disabled" });
  } finally { await page.keyboard.press("Escape"); await page.mouse.up(); }
}
