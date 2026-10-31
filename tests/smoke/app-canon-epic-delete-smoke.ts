// test-category: race
// Native UI harness: deletion owns a separate confirmation and keeps conversations.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { seedCanonBoard, openCanonBoard } from "../support/canon-board-scenarios.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { showCanonSidebar } from "../support/canon-sidebar-scenarios.ts";
import type { EpicDetail, EpicProgressSnapshot } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-epic-delete-screenshots";
mkdirSync(shots, { recursive: true });
const cases = [1440, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "wallpaper"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_EPIC_DELETE_CASE", import.meta.path, { isolate: true })) process.exit(0);
const server = await createNativeAppServer({ uiRoot: new URL("../../packages/butler-app/client/ui/dist", import.meta.url).pathname });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const { projectId, planId } = await seedCanonBoard(server);
  browser = await launchSmokeBrowser();
  for (const name of cases.filter(name => name === process.env.BUTLER_EPIC_DELETE_CASE)) {
    const [widthText, theme, surface] = name.split("-");
    const width = Number(widthText), wallpaper = surface === "wallpaper";
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      main_screen_theme: wallpaper ? "silk" : "none", wallpaper: { source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    const epic = await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, { method: "POST", body: JSON.stringify({ title: "삭제 확인", plan_id: planId }) });
    const { session_id: chat } = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
      let running = true;
      await page.route(`**/canon/epics/${epic.id}/progress`, route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: {
        epic_id: epic.id, stage: null, stage_history: [], actions: [], counts: { completed: 0, total: 0 }, running, disposition: null,
      } satisfies EpicProgressSnapshot } }));
      await page.goto(server.url, { waitUntil: "load" });
      await openCanonBoard(page);
      await page.screenshot({ path: join(shots, `${name}-before.png`), animations: "disabled" });
      const card = page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first();
      await card.click();
      const detail = page.locator('[data-test-class="canon-epic-detail"]');
      const menu = detail.getByRole("button", { name: "삭제 확인 메뉴", exact: false });
      const openMenu = () => menu.click();
      await openMenu();
      const action = page.getByRole("menuitem", { name: "과제 삭제", exact: true });
      assert.equal(await action.getAttribute("aria-disabled"), "true");
      await action.hover({ force: true });
      await page.getByRole("tooltip").filter({ hasText: "진행 중에는 삭제할 수 없습니다" }).waitFor();
      await page.keyboard.press("Escape");
      running = false;
      await page.reload({ waitUntil: "load" });
      await openCanonBoard(page);
      await card.click();
      await openMenu();
      await page.screenshot({ path: join(shots, `${name}-menu.png`), animations: "disabled" });
      await action.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("이 기기에서 삭제합니다. 연결된 대화는 남습니다.", { exact: true }).waitFor();
      assert.equal(await dialog.locator("form").getByRole("button").last().innerText(), "과제 삭제");
      await page.screenshot({ path: join(shots, `${name}-dialog.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "과제 삭제", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await card.waitFor({ state: "hidden" });
      await detail.waitFor({ state: "hidden" });
      await showCanonSidebar(page);
      await page.locator(`[data-tree-item="s:${chat}"]`).waitFor();
      const session = await server.api<{ session: { id: string } }>(`/session-view?session_id=${chat}`);
      assert(session, "linked conversation stays");
      await page.screenshot({ path: join(shots, `${name}-after.png`), animations: "disabled" });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ result: "PASS", case: process.env.BUTLER_EPIC_DELETE_CASE, screenshots: shots, stubModelCalls: server.stubModelCalls.length }));
} finally { await browser?.close(); await server.stop(); }
