// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { openCanonBoard, seedCanonBoard } from "../support/canon-board-scenarios.ts";
import { verifyAsideCloseGuards } from "../support/canon-aside-exits.ts";
import { verifyInlineFields, verifyInlineExits, inlineShot } from "../support/canon-inline-edit-flows.ts";
import { verifyPaneExits, verifyInlineAttachment, verifyEmptyDescription } from "../support/canon-inline-pane-flows.ts";
import { installPendingAskEvents } from "../support/session-info-fixtures.ts";
import { showCanonSidebar } from "../support/canon-sidebar-scenarios.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const cases = ["dark", "light"];
if (await runSmokeCases(cases, "BUTLER_INLINE_EDIT_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_INLINE_EDIT_CASE ?? "dark";
const shots = join(resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/canon-inline-edit-smoke"), theme);
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let failure: unknown;
let cleanupErrors: unknown[] = [];
try {
  const { projectId, planId } = await seedCanonBoard(server);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, reduce_motion: true,
    wallpaper: { source: { kind: "live", module: "butler.riso-print" }, motion: "paused", pauseOnBattery: false } }) });
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const epic = canon.plans.find(plan => plan.id === planId)!.works.find(work => work.title === "문서")!;
  await server.api(`/canon/epics/${epic.id}`, { method: "PATCH", body: JSON.stringify({
    expected_revision: epic.revision, title: "문서 화면 정리",
    description: "문서 목록과 상세 화면의 구성을 정리합니다.\n제목과 최근 수정일을 쉽게 찾을 수 있도록 배치합니다.\n검색 결과에서 본문을 확인하는 흐름을 점검합니다.",
  }) });
  const other = canon.plans.find(plan => plan.id === planId)!.works.find(work => work.title === "ChatGPT 공식 로그인")!;
  const linked = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
  await server.api(`/canon/epics/${other.id}/conversation`, { method: "POST", body: "{}" });
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await server.signIn(page.context());
  await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false, right_panel_width: 376, active_session_id: id, session_info_open: true, task_graph_enabled: true,
  })), linked.session_id);
  await installPendingAskEvents(page);
  await page.goto(server.url, { waitUntil: "load" });
  await page.locator('[data-test-class="canon-epic-detail"]').getByRole("heading", { name: "문서 화면 정리", exact: true }).waitFor();
  await showCanonSidebar(page);
  await page.waitForFunction(() => document.querySelector('[data-slot="conversation-aside"]')?.getAttribute("data-layout") === "docked");
  // The session summary arrives after the epic and mounts sections around the task; hovering earlier moves the title off the pointer.
  await page.locator('[data-session-section="environment"]').waitFor();
  await verifyInlineFields(page, server, epic.id, shots);
  await verifyEmptyDescription(page, epic.id);
  await verifyInlineAttachment(page, epic.id);
  await verifyPaneExits(page, server, epic.id, shots, other.id);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await openCanonBoard(page);
    await page.locator('[data-kanban-item="' + epic.id + '"]').getByRole("button").first().click();
    // A layout switch keeps the leaving (inert) aside mounted for its exit: use the open one, once the other has gone.
    const aside = page.locator('[data-slot="management-page-aside"][data-state="open"]');
    await aside.waitFor();
    await page.locator('[data-slot="management-page-aside"][data-state="closed"]').waitFor({ state: "detached" });
    assert.equal(await aside.getAttribute("data-layout"), width === 1440 ? "docked" : "floating");
    const dashboardShots = join(shots, "dashboard-" + width); mkdirSync(dashboardShots, { recursive: true });
    const current = await server.api<import("../../packages/butler-app/client/shared/canon-contracts.ts").EpicDetail>("/canon/epics/" + epic.id);
    const initialDescription = "문서 화면의 구성과 검색 흐름을 검토합니다.";
    await server.api("/canon/epics/" + epic.id, { method: "PATCH", body: JSON.stringify({
      expected_revision: current.revision, description: initialDescription,
    }) });
    await aside.getByText(initialDescription, { exact: true }).waitFor();
    await verifyInlineFields(page, server, epic.id, dashboardShots);
    await page.locator('[data-test-class="canon-epic-detail"]').getByRole("button", { name: "제목 수정", exact: true }).click();
    await page.locator('[data-test-class="canon-epic-detail"]').getByLabel("제목", { exact: true }).fill("문서 화면과 검색 흐름 검토");
    await inlineShot(page, dashboardShots, "dashboard-editing");
    await page.locator('[data-test-class="canon-epic-detail"]').getByLabel("제목", { exact: true }).press("Escape");
    await verifyAsideCloseGuards(page, server, epic.id);
    await verifyInlineExits(page, server, epic.id, dashboardShots);
    await page.getByRole("button", { name: "돌아가기", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ result: "ASSERTIONS_PASS", screenshots: shots, stubModelCalls: 0 }));
  await page.close();
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error(await page.locator("body").innerText());
    await page.screenshot({ path: join(shots, "failure.png") });
  }
  failure = error;
} finally {
  const results = await Promise.allSettled([browser?.close(), server.stop()]);
  cleanupErrors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}
if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Inline edit smoke failed");
console.log("PASS canon inline edit");
