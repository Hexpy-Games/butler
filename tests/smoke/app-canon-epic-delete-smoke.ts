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
import type { CanonOverview, EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-epic-delete-screenshots";
mkdirSync(shots, { recursive: true });
const cases = [1440, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "wallpaper"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_EPIC_DELETE_CASE", import.meta.path, { isolate: true })) process.exit(0);
let tool: DeleteTool | null = null;
let holdStep = false;
let releaseStep: (() => void) | undefined;
let enteredStep: (() => void) | undefined;
const server = await createNativeAppServer({ stubReply: async request => {
  if (holdStep && request.stream) {
    holdStep = false;
    await new Promise<void>(resolve => { releaseStep = resolve; enteredStep?.(); });
  }
  return "Stub reply from the isolated smoke model.";
}, stubToolCall: request => {
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
      const entered = new Promise<void>(resolve => { enteredStep = resolve; });
      holdStep = true;
      await server.api(`/sessions/${chat}/canon/queue`, { method: "POST", body: JSON.stringify({ op: "start_now", epic_id: epic.id }) });
      await entered;
      await page.goto(server.url, { waitUntil: "load" });
      await showCanonSidebar(page);
      await openCanonBoard(page);
      await page.screenshot({ path: join(shots, `${name}-before.png`), animations: "disabled" });
      const epicCard = page.locator(`[data-kanban-item="${epic.id}"]`);
      assert.equal(await epicCard.locator('[data-slot="spinner"]').count(), process.env.BUTLER_EPIC_DELETE_BASELINE === "1" ? 1 : 0);
      await epicCard.screenshot({ path: join(shots, `${name}-unlinked-step.png`), animations: "disabled" });
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
      const refreshed = page.waitForResponse(async response => {
        if (!response.ok() || new URL(response.url()).pathname !== `/projects/${projectId}/canon`) return false;
        const canon = (await response.json()).data as CanonOverview;
        return [...canon.backlog, ...canon.plans.flatMap(plan => plan.works)]
          .some(row => row.id === epic.id && row.delete_blocked === false);
      });
      releaseStep?.();
      await refreshed;
      await overview.getByRole("button", { name: `${epic.title} 메뉴`, exact: true }).click();
      assert.notEqual(await action.getAttribute("aria-disabled"), "true");
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
} finally { releaseStep?.(); await browser?.close(); await server.stop(); }
