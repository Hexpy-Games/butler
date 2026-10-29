import { verifyDashboardSelection } from "../support/canon-dashboard-selection.ts";
import { canonAsideClose, closeCanonAside, verifyCanonAside } from "../support/canon-board-aside.ts";
// Native stub-backed UI smoke: all planning content is seeded through canon HTTP.
import { captureBoardEdges } from "../support/canon-board-visuals.ts";
import { verifyBoardSelector } from "../support/canon-board-selector.ts";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { captureCanonDrag, verifyCanonDrags } from "../support/canon-board-drags.ts";
import { openCanonBoard, seedCanonBoard, verifyCanonFlows } from "../support/canon-board-scenarios.ts";

const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/canon-board-smoke");
mkdirSync(shots, { recursive: true });
const cases = [1440, 1280, 1024, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "wallpaper"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_CANON_SMOKE_CASE", import.meta.path, { isolate: true })) process.exit(0);
const selectedCase = process.env.BUTLER_CANON_SMOKE_CASE;
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let count = 0;
let failure: unknown;
let cleanupErrors: unknown[] = [];
try {
  const { projectId, planId } = await seedCanonBoard(server);
  browser = await launchSmokeBrowser();
  for (const cell of cases.filter(cell => !selectedCase || cell === selectedCase)) {
    const [widthText, theme, surface] = cell.split("-");
    const width = Number(widthText), wallpaper = surface === "wallpaper";
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      main_screen_theme: wallpaper ? "silk" : "none", wallpaper: {
        source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false,
      },
    }) });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
    let page: Page | undefined;
    let contextFailure: unknown;
    try {
      await server.signIn(context);
      page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
        schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false,
      })));
      await page.goto(server.url, { waitUntil: "load" });
      await openCanonBoard(page);
      await page.waitForFunction(expected => Boolean(document.querySelector('[data-test-class~="project-dashboard-wallpaper"]')) === expected, wallpaper);
      const name = `${before ? "before" : "after"}-${theme}-${width}-${wallpaper ? "wallpaper" : "plain"}`;
      if (before) {
        await page.getByRole("tabpanel").getByRole("status").first().waitFor({ state: "hidden" });
        await capture(page, `${name}-rest.png`); count++; continue;
      }
      const board = page.locator('[data-test-class="canon-board"]');
      await board.locator("[data-kanban-item]").filter({ hasText: "캐논" }).getByRole("button").first().waitFor();
      assert.equal(await board.getByText(/GitHub|가져오기|동기화됨|마일스톤/).count(), 0);
      assert.equal(await board.getByRole("radio").count(), 0);
      await verifyBoardSelector(page, server, projectId, planId, name, shots, () => openCanonBoard(page!));
      await captureBoardEdges(page, shots, name);
      await capture(page, `${name}-rest.png`); count++;
      const card = board.locator("[data-kanban-item]").filter({ hasText: "캐논" }).getByRole("button").first();
      assert.equal(await card.getByRole("img", { name: "나", exact: true }).count(), 1, "Assigned card has an Avatar after its title");
      assert.equal(await card.locator("svg").count(), 0, "Idle card shows no status icon: the lane shows the status");
      if (width === 1440 && !wallpaper) await verifyDashboardSelection(page, projectId, shots, name);
      await card.focus(); await card.press("Enter");
      await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
      if (width !== 390) {
        // Exercise pointer opening from a closed panel, as well as Enter above.
        await closeCanonAside(page);
        await page.locator('[data-slot="management-page-aside"]').waitFor({ state: "hidden" });
        await card.click();
        await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
      } else {
        const close = await canonAsideClose(page).boundingBox();
        assert(close && close.y >= 0 && close.y + close.height < 844, "Selected detail opens in the phone viewport");
      }
      await page.waitForFunction(() => document.activeElement?.matches('[data-slot="management-page-aside"] h3'));
      await verifyCanonAside(page);
      assert.equal(await board.locator('[data-test-class="canon-epic-detail"]').count(), 0, "Detail is outside the board in the page aside");
      const detailPanel = page.locator('[data-slot="management-page-aside"]');
      const planControl = await detailPanel.getByRole("combobox", { name: "계획", exact: true }).boundingBox();
      const ordinal = await detailPanel.getByText("· 1번째", { exact: true }).boundingBox();
      const panelBox = await detailPanel.boundingBox();
      assert(planControl && ordinal && panelBox && ordinal.x + ordinal.width <= panelBox.x + panelBox.width,
        "Plan ordinal stays inside the panel");
      assert(Math.abs(ordinal.y + ordinal.height / 2 - planControl.y - planControl.height / 2) < 4, "Plan ordinal stays inline");
      assert.equal(await detailPanel.getByRole("button", { name: "대화 열기", exact: true }).count(), 1);
      assert.equal(await card.locator('[data-slot="spinner"]').count(), 0, "Idle in-progress conversation shows no Spinner");
      await capture(page, `${name}-detail.png`); count++;
      await detailPanel.getByRole("button", { name: "대화 열기", exact: true }).click();
      await page.locator('[data-test-class="titlebar-title"]').filter({ hasText: "캐논" }).waitFor();
      await openCanonBoard(page);
      await card.click();
      await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
      await closeCanonAside(page);
      await board.getByRole("button", { name: "새 과제", exact: true }).first().click();
      assert.equal(await page.locator("#canon-create-plan").inputValue(), planId, "New Epic defaults to selected plan");
      await page.getByRole("dialog").waitFor();
      for (const id of ["canon-create-plan", "canon-create-assignee"]) {
        assert(await page.locator(`#${id}`).evaluate(select => {
          const wrapper = select.closest('[data-slot="native-select-wrapper"]')!;
          return Math.abs(wrapper.getBoundingClientRect().width - wrapper.parentElement!.getBoundingClientRect().width) < 2;
        }), "Create selects fill their columns");
      }
      await capture(page, `${name}-create.png`); count++;
      await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
      await captureCanonDrag(page, join(shots, `${name}-drag.png`)); count++;
      if (width === 390 && theme === "dark" && wallpaper) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await verifyCanonDrags(page, server, projectId, planId);
        await verifyCanonFlows(page, server, projectId, planId);
      }
      assert.deepEqual(errors, [], "No renderer errors");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport overflow");
      console.log(JSON.stringify({ result: "ASSERTIONS_PASS", case: cell, screenshots: count,
        flows: width === 390 && theme === "dark" && wallpaper ? "create,move,status,live-update,conflict,plan-create,plan-edit,pointer-reorder,pointer-status,detail-plan,keyboard" : "visual",
        stubModelCalls: server.stubModelCalls.length }));
    } catch (error) {
      if (page) { console.log("CASE_FAILURE", await page.locator("body").innerText()); await page.screenshot({ path: join(shots, `${cell}-failure.png`) }); }
      contextFailure = error;
    }
    finally { await closeCase(page, context, contextFailure); }
  }
} catch (error) { failure = error; }
finally {
  const cleanup = await Promise.allSettled([browser?.close(), server.stop()]);
  cleanupErrors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}
if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Canon smoke failed");
console.log(JSON.stringify({ result: "PASS", case: selectedCase, screenshots: count, directory: shots, stubModelCalls: server.stubModelCalls.length }));
async function closeCase(page: Page | undefined, context: import("playwright").BrowserContext, failure: unknown): Promise<void> {
  const errors: unknown[] = failure ? [failure] : [];
  // Close the live page before its single-process browser; always retain the first failure.
  try { await page?.close(); } catch (error) { errors.push(error); }
  try { await context.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Canon case failed");
}
async function capture(page: Page, filename: string): Promise<void> {
  await page.screenshot({ path: join(shots, filename), animations: "disabled" });
}
