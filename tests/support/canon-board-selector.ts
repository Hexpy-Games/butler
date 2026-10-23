import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";
export async function selectBoardPlan(page: Page, title: string) {
  await page.locator('[data-test-class="canon-board"]').getByRole("button", { name: "계획", exact: true }).click();
  await page.locator('[data-slot="filtered-select-popover"]').getByRole("button", { name: title, exact: true }).click();
  await page.locator('[data-slot="filtered-select-popover"]').waitFor({ state: "hidden" });
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
  const chooser = page.locator('[data-slot="filtered-select-popover"]');
  await chooser.waitFor();
  assert.equal(await chooser.locator('[data-slot="filtered-select-item"]').last().innerText(), "백로그");
  await page.screenshot({ path: join(shots, `${name}-open.png`), animations: "disabled" });
  await chooser.getByRole("textbox", { name: "계획 검색", exact: true }).fill("단일");
  assert.deepEqual(await chooser.locator('[data-slot="filtered-select-item"]').allTextContents(), ["단일 과제 계획"]);
  await page.screenshot({ path: join(shots, `${name}-search.png`), animations: "disabled" });
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
}
