import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";
const planChooser = (page: Page) => page.locator('[data-slot="filtered-select-popover"][aria-label="계획"]');
export async function selectBoardPlan(page: Page, title: string) {
  await page.locator('[data-test-class="canon-board"]').getByRole("button", { name: "계획", exact: true }).click();
  await planChooser(page).getByRole("button", { name: title, exact: true }).click();
  await planChooser(page).waitFor({ state: "hidden" });
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
  const chooser = planChooser(page);
  await chooser.waitFor();
  const insets = await chooser.evaluate(element => {
    const box = element.closest('[data-slot="popover-content"]')!.getBoundingClientRect();
    const textLeft = (node: Element) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left; };
    const rows = [...element.querySelectorAll('[data-slot="filtered-select-item"]')].map(row => row.getBoundingClientRect());
    return { title: textLeft(element.firstElementChild!) - box.left, label: textLeft(element.querySelector('[data-slot="filtered-select-item"] span span')!) - box.left,
      left: Math.min(...rows.map(row => row.left)) - box.left, right: box.right - Math.max(...rows.map(row => row.right)) };
  });
  assert(Math.abs(insets.title - insets.label) < 1, "Plan title lines up with the row labels");
  assert(Math.abs(insets.left - insets.right) < 1, "Plan rows keep equal side insets");
  assert.equal(await chooser.locator('[data-slot="filtered-select-filters"], [data-slot="filtered-select-group-title"]').count(), 0,
    "Flat plan choices have no empty filter or group-title rows");
  assert.equal(await chooser.locator('[data-slot="filtered-select-item"]').last().innerText(), "백로그");
  await page.screenshot({ path: join(shots, `${name}-open.png`), animations: "disabled" });
  await chooser.getByPlaceholder("계획 검색", { exact: true }).fill("단일");
  assert.deepEqual(await chooser.locator('[data-slot="filtered-select-item"]').allTextContents(), ["단일 과제 계획"]);
  const result = await chooser.locator('[data-slot="filtered-select-item"]').boundingBox();
  const results = await chooser.locator('[data-slot="filtered-select-results"]').boundingBox();
  assert(result && results && result.y >= results.y && result.y + result.height <= results.y + results.height,
    "Filtered result is fully visible without scrolling");
  const popover = await chooser.boundingBox(), composer = await page.locator('[data-test-class~="composer-wrap"]').boundingBox();
  assert(popover && (!composer || popover.y + popover.height <= composer.y), "Selector stays above composer");
  await page.screenshot({ path: join(shots, `${name}-search.png`), animations: "disabled" });
  await chooser.getByPlaceholder("계획 검색", { exact: true }).fill("일치하지 않는 검색");
  assert.equal(await chooser.locator('[data-slot="filtered-select-item"]').count(), 0);
  await chooser.getByText("검색 결과 없음", { exact: true }).waitFor();
  await chooser.getByRole("button", { name: "검색 지우기", exact: true }).click();
  assert.equal(await chooser.locator('[data-slot="filtered-select-item"]').count(), canon.plans.length + 1);
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
