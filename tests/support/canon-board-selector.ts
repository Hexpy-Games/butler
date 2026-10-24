import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";
export async function selectBoardPlan(page: Page, title: string) {
  await page.locator('[data-test-class="canon-board"]').getByRole("button", { name: "계획", exact: true }).click();
  await page.locator('[data-test-class="canon-plan-chooser"]').getByRole("button", { name: title, exact: true }).click();
  await page.locator('[data-test-class="canon-plan-chooser"]').waitFor({ state: "hidden" });
}
export async function verifyBoardSelector(page: Page, server: NativeAppServerHandle, projectId: string,
  planId: string, name: string, shots: string, reopen: () => Promise<void>) {
  mkdirSync(shots, { recursive: true });
  const board = page.locator('[data-test-class="canon-board"]');
  await board.locator(`[data-plan-id="${planId}"]`).waitFor();
  assert.equal(await board.locator('[data-canon-backlog]').count(), 0, "Default is the nearest due open plan");
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  assert(canon.plans.every(plan => typeof plan.updated_at === "number"), "API supplies real update timestamps");
  await page.screenshot({ path: join(shots, `${name}-closed.png`), animations: "disabled" });
  await board.getByRole("button", { name: "계획", exact: true }).click();
  const chooser = page.locator('[data-test-class="canon-plan-chooser"]');
  await chooser.waitFor();
  assert.equal(await chooser.locator('[data-slot="filtered-select-filters"], [data-slot="filtered-select-group-title"]').count(), 0,
    "Flat plan choices have no empty filter or group-title rows");
  assert.equal(await chooser.locator('[data-slot="option-menu-item"]').last().innerText(), "백로그");
  await page.screenshot({ path: join(shots, `${name}-open.png`), animations: "disabled" });
  await chooser.getByRole("textbox", { name: "계획 검색", exact: true }).fill("단일");
  assert.deepEqual(await chooser.locator('[data-slot="option-menu-item"]').allTextContents(), ["단일 과제 계획"]);
  const result = await chooser.locator('[data-slot="option-menu-item"]').boundingBox();
  const results = await chooser.locator('[data-test-class="canon-plan-results"]').boundingBox();
  const padding = await chooser.locator('[data-test-class="canon-plan-results"] > div').evaluate(element => {
    const style = getComputedStyle(element);
    return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  });
  assert(result && results && Math.abs(results.height - result.height - padding) < 1,
    "Search results contain exactly the content and DS focus-ring padding");
  assert(result && results && result.y >= results.y && result.y + result.height <= results.y + results.height,
    "Filtered result is fully visible without scrolling");
  const popover = await chooser.boundingBox(), composer = await page.locator('[data-test-class~="composer-wrap"]').boundingBox();
  assert(popover && (!composer || popover.y + popover.height <= composer.y), "Selector stays above composer");
  await page.screenshot({ path: join(shots, `${name}-search.png`), animations: "disabled" });
  await chooser.getByRole("textbox", { name: "계획 검색", exact: true }).fill("일치하지 않는 검색");
  assert.equal(await chooser.locator('[data-slot="option-menu-item"]').count(), 0);
  await chooser.getByText("검색 결과 없음", { exact: true }).waitFor();
  await chooser.getByRole("button", { name: "검색 지우기", exact: true }).click();
  assert.equal(await chooser.locator('[data-slot="option-menu-item"]').count(), canon.plans.length + 1);
  await page.keyboard.press("Escape");
  for (const option of [...canon.plans, { id: null, title: "백로그" }]) {
    await selectBoardPlan(page, option.title);
    const selected = option.id ? board.locator(`[data-plan-id="${option.id}"]`) : board.locator('[data-canon-backlog]');
    await selected.waitFor();
    assert.equal(await board.locator('[data-plan-id]').count(), option.id ? 1 : 0);
    await page.screenshot({ path: join(shots, `${name}-${option.id ?? "backlog"}.png`), animations: "disabled" });
  }
  await page.reload(); await reopen();
  await board.locator('[data-canon-backlog]').waitFor();
  assert.equal(await board.locator('[data-plan-id]').count(), 0, "Backlog selection persists across reload");
  await selectBoardPlan(page, "단일 과제 계획");
  await page.reload(); await reopen();
  await board.locator(`[data-plan-id="${canon.plans.find(plan => plan.title === "단일 과제 계획")!.id}"]`).waitFor();
  await page.evaluate(projectId => localStorage.setItem(`butler:canon-plan:${projectId}`, JSON.stringify("missing-plan")), projectId);
  await page.reload(); await reopen();
  await board.locator(`[data-plan-id="${planId}"]`).waitFor();
  assert.equal(await board.locator('[data-canon-backlog]').count(), 0, "Missing saved plan falls back to default");
  assert.equal(await page.evaluate(id => localStorage.getItem(`butler:canon-plan:${id}`), projectId),
    JSON.stringify("missing-plan"), "Fallback never persists an implicit selection");
}
