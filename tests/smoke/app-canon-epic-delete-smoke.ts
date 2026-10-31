// test-category: race
// Native UI harness: deletion owns a separate confirmation and keeps conversations.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { seedCanonBoard, openCanonBoard } from "../support/canon-board-scenarios.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { captureDeleteCards, captureDeleteMenu, type DeleteTool } from "../support/canon-delete-card-crops.ts";
import { closeCanonAside } from "../support/canon-board-aside.ts";
import { openPlan, showCanonSidebar } from "../support/canon-sidebar-scenarios.ts";
import type { CanonOverview, EpicDetail, EpicProgressSnapshot } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-epic-delete-screenshots";
mkdirSync(shots, { recursive: true });
const cases = [1440, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "wallpaper"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_EPIC_DELETE_CASE", import.meta.path, { isolate: true })) process.exit(0);
let tool: DeleteTool | null = null;
const server = await createNativeAppServer({ stubToolCall: request => {
  if (!request.stream || !Array.isArray(request.body.tools)) return null;
  const next = tool; tool = null; return next;
}, uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const { projectId, planId } = await seedCanonBoard(server);
  browser = await launchSmokeBrowser();
  for (const name of cases.filter(name => name === process.env.BUTLER_EPIC_DELETE_CASE)) {
    const [widthText, theme, surface] = name.split("-");
    const width = Number(widthText), wallpaper = surface === "wallpaper";
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      main_screen_theme: wallpaper ? "silk" : "none", wallpaper: { source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    const epic = await server.api<EpicDetail>(`/projects/${projectId}/canon/epics`, { method: "POST", body: JSON.stringify({ title: "삭제 확인 · 긴 과제 제목이 여러 줄로 이어져도 작업 메뉴와 겹치지 않고 올바르게 표시됩니다", plan_id: planId }) });
    const { session_id: chat } = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
      let running = true;
      await page.route(`**/projects/${projectId}/canon`, async route => {
        const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
        const body = await response.json();
        if (!response.ok()) return route.fulfill({ response });
        const canon = body.data as CanonOverview;
        for (const row of [...canon.backlog, ...canon.plans.flatMap(plan => plan.works)]) if (row.id === epic.id)  { row.delete_blocked = running; row.running = process.env.BUTLER_R3_BASELINE === "1" ? running : false; }
        await route.fulfill({ response, json: body });
      });
      await page.route(`**/canon/epics/${epic.id}`, async route => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
        if (!response.ok()) return route.fulfill({ response });
        const body = await response.json();
        body.data.delete_blocked = running; body.data.running = process.env.BUTLER_R3_BASELINE === "1" ? running : false; await route.fulfill({ response, json: body });
      });
      await page.route(`**/canon/epics/${epic.id}/progress`, route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: {
        epic_id: epic.id, stage: null, stage_history: [], actions: [], counts: { completed: 0, total: 0 }, running: false, disposition: null,
      } satisfies EpicProgressSnapshot } }));
      await page.goto(server.url, { waitUntil: "load" });
      await showCanonSidebar(page);
      await openCanonBoard(page);
      await page.screenshot({ path: join(shots, `${name}-before.png`), animations: "disabled" });
      const epicCard = page.locator(`[data-kanban-item="${epic.id}"]`);
      assert.equal(await epicCard.locator('[data-slot="spinner"]').count(), process.env.BUTLER_R3_BASELINE === "1" ? 1 : 0);
      await epicCard.screenshot({ path: join(shots, `${name}-bound-unrelated-turn.png`), animations: "disabled" });
      const card = page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first();
      await card.click();
      const detail = page.locator('[data-test-class="canon-epic-detail"]');
      const menu = detail.getByRole("button", { name: `${epic.title} 메뉴`, exact: true });
      const openMenu = () => menu.click();
      await detail.screenshot({ path: join(shots, `${name}-detail.png`), animations: "disabled" });
      const titleBox = await detail.getByRole("heading", { name: epic.title, exact: true }).boundingBox();
      const menuBox = await menu.boundingBox();
      assert(titleBox && menuBox);
      if (baseline) assert(titleBox.y >= menuBox.y + menuBox.height, "baseline menu consumes a separate row");
      else assert(Math.abs(titleBox.y - menuBox.y) < 32, "menu shares the title row");
      await openMenu();
      const action = page.getByRole("menuitem", { name: "과제 삭제", exact: true });
      assert.equal(await action.getAttribute("aria-disabled"), "true");
      await action.hover({ force: true });
      await page.getByRole("tooltip").filter({ hasText: "진행 중에는 삭제할 수 없습니다" }).waitFor();
      await captureDeleteMenu(page, shots, `${name}-disabled-tooltip`);
      await page.screenshot({ path: join(shots, `${name}-disabled-tooltip.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      await closeCanonAside(page);
      await openPlan(page, planId);
      const overview = page.locator('[data-test-class="canon-plan-overview"]');
      await overview.getByRole("button", { name: `${epic.title} 메뉴`, exact: true }).click();
      assert.equal(await action.getAttribute("aria-disabled"), "true");
      await action.hover({ force: true });
      await page.getByRole("tooltip").filter({ hasText: "진행 중에는 삭제할 수 없습니다" }).waitFor();
      await captureDeleteMenu(page, shots, `${name}-plan-disabled-tooltip`);
      await page.screenshot({ path: join(shots, `${name}-plan-disabled-tooltip.png`), animations: "disabled" });
      await page.keyboard.press("Escape");
      running = false;
      await page.reload({ waitUntil: "load" });
      await openPlan(page, planId);
      await overview.getByRole("button", { name: `${epic.title} 메뉴`, exact: true }).click();
      await page.screenshot({ path: join(shots, `${name}-plan-menu.png`), animations: "disabled" });
      await action.click();
      await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
      await showCanonSidebar(page);
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
      await captureDeleteCards(page, server, projectId, name, shots, next => { tool = next; });
      await page.unrouteAll({ behavior: "wait" });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ result: "PASS", case: process.env.BUTLER_EPIC_DELETE_CASE, screenshots: shots, stubModelCalls: server.stubModelCalls.length }));
} finally { await browser?.close(); await server.stop(); }
