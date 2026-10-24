// test-category: race
// UI harness: derived progress snapshots exercise the existing inspector controls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { seedCanonBoard, openCanonBoard } from "../support/canon-board-scenarios.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import type { CanonOverview, EpicProgressSnapshot } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-link-progress-screenshots";
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: new URL("../../packages/butler-app/client/ui/dist", import.meta.url).pathname });
const browser = await launchSmokeBrowser();
try {
  const { projectId } = await seedCanonBoard(server);
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const epic = canon.plans.flatMap(plan => plan.works).find(work => work.title === "캐논")!;
  const progress: EpicProgressSnapshot = {
    epic_id: epic.id, stage: "execution", stage_history: [], disposition: "open", running: true,
    counts: { completed: 2, total: 5 },
    actions: Array.from({ length: 5 }, (_, i) => ({ work_id: "work", actionKey: `action-${i}`, description: `확인 ${i + 1}`, dependencyKeys: [], status: i < 2 ? "done" : "pending" })),
  };
  for (const theme of ["light", "dark"]) {
    const current = await server.api<{ revision: number }>(`/canon/epics/${epic.id}`);
    await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({ expected_revision: current.revision, status: "in_progress" }) });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
      await page.route(`**/canon/epics/${epic.id}/progress`, route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: progress } }));
      await page.route(`**/projects/${projectId}/canon`, async route => {
        const board = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
        const card = board.plans.flatMap(plan => plan.works).find(work => work.id === epic.id)!;
        card.task_counts = progress.counts; card.running = progress.running;
        await route.fulfill({ json: { protocol_version: "butler.app.v1", data: board } });
      });
      await page.goto(server.url, { waitUntil: "load" });
      await openCanonBoard(page);
      const card = page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first();
      await card.getByText("작업 2/5", { exact: false }).waitFor();
      await card.click();
      const detail = page.locator('[data-test-class="canon-epic-detail"]');
      await detail.getByText("확인 5", { exact: true }).waitFor();
      await detail.getByText("실행", { exact: true }).waitFor();
      const status = detail.getByRole("combobox", { name: "상태", exact: true });
      for (const [value, message] of [["done", "진행 중에는 완료할 수 없습니다"], ["cancelled", "진행 중에는 취소할 수 없습니다"]]) {
        const option = status.locator(`option[value="${value}"]`);
        assert(await option.isDisabled());
        assert.equal(await option.getAttribute("title"), message);
      }
      await page.screenshot({ path: join(shots, `${theme}-running.png`), animations: "disabled" });
      progress.running = false;
      await page.reload({ waitUntil: "load" });
      await openCanonBoard(page);
      await page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first().click();
      await detail.getByText("확인 5", { exact: true }).waitFor();
      assert(await status.locator('option[value="done"]').isEnabled());
      assert(await status.locator('option[value="cancelled"]').isEnabled());
      await status.selectOption("done");
      await page.locator('[data-sonner-toast]').filter({ hasText: "상태를 바꿨습니다" }).first().waitFor();
      await page.screenshot({ path: join(shots, `${theme}-idle.png`), animations: "disabled" });
      progress.running = true;
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ result: "PASS", themes: 2, actions: 5, screenshots: shots, stubModelCalls: server.stubModelCalls.length }));
} finally { await browser.close(); await server.stop(); }
