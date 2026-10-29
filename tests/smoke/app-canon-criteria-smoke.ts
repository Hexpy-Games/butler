// test-category: security
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { runMcpMatrix } from "../support/canon-mcp-matrix.ts";
import { captureRegion } from "../support/canon-mcp-crops.ts";
import { auditCanonCardFocus } from "../support/canon-registration-cards.ts";
import { openCanonBoard } from "../support/canon-board-scenarios.ts";
import { openPlan } from "../support/canon-sidebar-scenarios.ts";
import { selectBoardPlan } from "../support/canon-board-selector.ts";
import { closeCanonAside } from "../support/canon-board-aside.ts";
import { criteriaText, seedCriteria, publishCriteria } from "../support/canon-criteria-fixture.ts";
import { verifyCriteriaInteractions, verifyCriteriaLayout, verifyCountOnly, verifyZeroAndNullCriteria, verifyEnglishCriteria, verifyChildCriteria, trackSpecHeading, verifySpecHeadingStill, type Capture } from "../support/canon-criteria-interactions.ts";
const cases = [390, 1440].flatMap(w => ["light", "dark"].flatMap(t => ["plain", "wallpaper"].map(bg => `${w}-${t}-${bg}`)));
if (await runMcpMatrix(cases, "BUTLER_CANON_CRITERIA_CASE", import.meta.path)) process.exit(0);
const [widthText, theme, background] = process.env.BUTLER_CANON_CRITERIA_CASE!.split("-");
const width = Number(widthText), wallpaper = background === "wallpaper";
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const directory = process.env.BUTLER_CRITERIA_CROPS ?? "/tmp/canon-criteria-crops";
mkdirSync(directory, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  const fixture = await seedCriteria(server);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    wallpaper: { source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width, height: 1100 }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
  try {
    await server.signIn(context);
    const page = await context.newPage();
    await trackSpecHeading(page);
    await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: true, session_info_open: true })), fixture.session);
    await page.goto(server.url);
    await page.locator('[data-test-class~="mac-window"]').waitFor();
    const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
    const toggle = page.locator('[data-test-class="session-info-toggle"]');
    await toggle.waitFor();
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    await aside.waitFor();
    const detail = aside.locator('[data-test-class="canon-epic-detail"]'); await detail.waitFor();
    const capture: Capture = async (state, region, focus = false, surface = false) => {
      if (wallpaper && state !== "inspector-spec") return;
      await page.waitForFunction(() => document.querySelectorAll('[data-sonner-toast]').length === 0);
      console.log(`capture ${state}`);
      try {
        await captureRegion(page, directory, `${before ? "before" : "after"}-${state}-${width}-${theme}${surface ? `-${background}` : ""}`, Array.isArray(region) ? region : [region], { focus });
      } catch (error) {
        console.error({ state, asideVisible: await aside.isVisible(), detailCount: await detail.count(), body: (await page.locator("body").innerText()).slice(-3000) });
        await page.screenshot({ path: `/tmp/canon-criteria-${state}-failure.png` });
        throw error;
      }
    };
    const tree = detail.locator('[data-test-class="canon-spec-tree"]');
    // Before has the same disclosure tree but no test marker or confirmation control.
    const specRegion = before ? detail.locator("section").filter({ hasText: "검토 기준" }).first() : tree;
    const captureSessionInfo = async () => {
      const workMeter = detail.getByRole("progressbar", { name: "작업", exact: true }).locator("..");
      await capture("session-info", [workMeter, specRegion], false, true);
    };
    if (!before) {
      // The summary's environment section is the last to land above the spec.
      await aside.locator('[data-session-section="environment"]').waitFor();
      await verifySpecHeadingStill(page);
      await verifyCriteriaLayout(tree, "session-info");
    }
    if (before) await capture("criterion-unconfirmed", specRegion.getByText("VB-03", { exact: true }).locator(".."), false, true);
    if (!before) {
      await verifyCriteriaInteractions(page, server, fixture, detail, capture);
      const section = aside.locator('[data-session-section="task"]');
      const meter = section.locator('[data-test-class="canon-criteria-progress"]');
      assert.equal(await meter.count(), 1);
      await meter.getByRole("progressbar", { name: "1/2 확인", exact: true }).waitFor();
      await verifyCriteriaLayout(tree, "session-info-confirmed");
      await captureSessionInfo();
      await publishCriteria(server, fixture);
      await tree.getByRole("button", { name: "VB-03 확인됨", exact: true }).waitFor();
      await page.reload();
      await page.locator('[data-test-class~="mac-window"]').waitFor();
      await toggle.waitFor();
      if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
      await aside.waitFor();
      await detail.waitFor();
      await tree.getByRole("button", { name: "VB-03 확인됨", exact: true }).waitFor();
      await capture("revision-carry", tree, false, true);
      await publishCriteria(server, fixture, "변경 내용을 기준별로 펼쳐 확인할 수 있다");
      await tree.getByRole("button", { name: "VB-03 미확인", exact: true }).waitFor();
      await tree.getByRole("progressbar", { name: "0/2 확인", exact: true }).waitFor();
      await capture("revision-reset", tree, false, true);
      await publishCriteria(server, fixture);
      await tree.getByText(criteriaText, { exact: true }).waitFor();
      await auditCanonCardFocus(page, tree);
    } else await captureSessionInfo();
    await page.locator('[data-test-class="session-info-toggle"]').click();
    await aside.waitFor({ state: "hidden" });
    {
      await openCanonBoard(page); await selectBoardPlan(page, "검토 기준 정리");
      const card = page.locator(`[data-kanban-item="${fixture.epic}"]`);
      await card.waitFor();
      if (!before) await verifyCountOnly(card);
      await capture("board-card", card);
      const empty = page.locator(`[data-kanban-item="${fixture.empty}"]`); await empty.waitFor();
      assert.equal(await empty.getByRole("progressbar").count(), 0);
      await capture("no-criteria", empty);
      await card.getByRole("button").first().click();
      const inspectorTree = page.locator('[data-slot="management-page-aside"] [data-test-class="canon-spec-tree"]');
      await inspectorTree.waitFor();
      if (!before) { await verifyCriteriaLayout(inspectorTree, "inspector-spec"); await auditCanonCardFocus(page, inspectorTree); }
      await capture("inspector-spec", inspectorTree, false, true);
      await closeCanonAside(page);
      await empty.getByRole("button").first().click();
      const emptyTree = page.locator('[data-slot="management-page-aside"] [data-test-class="canon-spec-tree"]');
      await emptyTree.getByText("명세", { exact: true }).waitFor();
      assert.equal(await emptyTree.getByRole("progressbar").count(), 0, "No criteria keeps the heading without a meter");
      await closeCanonAside(page);
      await openPlan(page, fixture.plan);
      const row = page.locator(`[data-sortable-id="${fixture.epic}"]`); await row.waitFor();
      if (!before) await verifyCountOnly(row);
      await capture("plan-overview", row);
      const emptyRow = page.locator(`[data-sortable-id="${fixture.empty}"]`); await emptyRow.waitFor();
      assert.equal(await emptyRow.getByRole("progressbar").count(), 0);
    }
    if (!before) await verifyChildCriteria(page, server, fixture, capture);
    if (!before && width === 1440 && theme === "light" && !wallpaper) {
      await verifyZeroAndNullCriteria(page, server, fixture);
      await verifyEnglishCriteria(page, server);
    }
    assert.equal(server.stubModelCalls.length, 0);
    console.log(JSON.stringify({ result: "PASS", before, width, theme, background, clipped: 0 }));
  } finally { await context.close(); }
} finally { await browser?.close(); await server.stop(); }
