// Native stub-backed public-path smoke. No direct DB writes and no live model calls.
import { captureOverviewQA } from "../support/canon-overview-qa.ts";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { seedCanonSidebar, showCanonSidebar, openPlan, createFromSidebar, showEpicInspector, verifySidebarOrder, verifyInspectorConflict, verifyOverviewLayout, verifySidebarLongPress, verifyEmptyEpicConversation, verifyEpicLabel } from "../support/canon-sidebar-scenarios.ts";

const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/canon-sidebar-smoke");
mkdirSync(shots, { recursive: true });
const cases = [1440, 1024, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "wallpaper"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_CANON_SIDEBAR_CASE", import.meta.path, { isolate: true })) process.exit(0);
const selected = process.env.BUTLER_CANON_SIDEBAR_CASE!;
const [widthText, theme, surface] = selected.split("-");
const width = Number(widthText), wallpaper = surface === "wallpaper";
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let failure: unknown;
let cleanupErrors: unknown[] = [];
try {
  const seeded = await seedCanonSidebar(server);
  const { projectId, planId } = seeded;
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    main_screen_theme: wallpaper ? "silk" : "none", wallpaper: {
      source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false,
    },
  }) });
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await server.signIn(context);
    await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: true,
    })));
    await page.goto(server.url, { waitUntil: "load" });
    await page.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
    await openPlan(page, planId);
    await page.waitForFunction(expected => Boolean(document.querySelector('[data-test-class~="project-dashboard-wallpaper"][data-module="butler.silk"]')) === expected, wallpaper);
    await showCanonSidebar(page);
    const group = page.locator(`[data-canon-group="${planId}"]`);
    await group.locator('[data-test-class="canon-sidebar-group"]').scrollIntoViewIfNeeded();
    const prefix = `${process.env.BUTLER_SMOKE_BASELINE === "1" ? "before" : "after"}-${selected}`;
    await capture(page, `${prefix}-sidebar`);
    const longRow = group.locator('[data-canon-epic]').filter({ hasText: "아주 긴 과제 제목" });
    await longRow.scrollIntoViewIfNeeded();
    await verifyEpicLabel(longRow);
    await capture(page, `${prefix}-long-title`);
    if (process.env.BUTLER_SMOKE_BASELINE !== "1") {
      const overviewPage = await context.newPage();
      try {
        overviewPage.on("pageerror", error => errors.push(error.message));
        await overviewPage.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
          schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false,
        })));
        await overviewPage.goto(server.url, { waitUntil: "load" });
        await overviewPage.waitForFunction(() => document.documentElement.lang.startsWith("ko"));
        await overviewPage.locator('[data-test-class~="mac-window"]').waitFor();
        await captureOverviewQA(overviewPage, width, selected, process.env.BUTLER_OVERVIEW_SCREENSHOTS ?? join(shots, "plan-overview-qa"), seeded);
      } finally { await overviewPage.close(); }
      await showCanonSidebar(page);
      await verifySidebarLongPress(page, planId);
      await openPlan(page, planId); await verifyOverviewLayout(page, width); await capture(page, `${prefix}-overview`);
      await openPlan(page, planId);
      await page.getByRole("button", { name: "새 과제", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.waitForFunction(expected => Boolean(document.querySelector('[data-test-class~="project-dashboard-wallpaper"][data-module="butler.silk"]')) === expected, wallpaper);
      await capture(page, `${prefix}-dialog`);
      await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
      const created = await createFromSidebar(page, projectId, planId);
      // Close the phone's sidebar before opening its inspector drawer.
      if (width === 390) {
        await page.getByRole("button", { name: "사이드바 숨기기", exact: true })
          .and(page.locator('button:not([data-slot="adaptive-shell-scrim"])')).click();
        await page.locator('[data-slot="adaptive-shell-sidebar"][data-open="true"]').waitFor({ state: "hidden" });
      }
      await verifyEmptyEpicConversation(page, server, created.session_id);
      await capture(page, `${prefix}-empty-conversation`);
      await showEpicInspector(page); await capture(page, `${prefix}-conversation`);
      await verifyInspectorConflict(page, server, created.work.id);
      if (width === 1440) await verifySidebarOrder(page, server, projectId, planId);
      assert.equal(await page.locator('[data-test-class="app-sidebar"]').getByText(/GitHub|동기화됨|가져오기|마일스톤/u).count(), 0);

    }
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport overflow");
    assert.equal(server.stubModelCalls.length, 0);
    console.log(JSON.stringify({ result: "PASS", case: selected, flows: "CN-01,CN-03,tree,recent", order: width === 1440 ? "CN-02" : "desktop coverage", screenshots: shots }));
  } catch (error) {
    console.log("CASE_FAILURE", await page.locator("body").innerText());
    await capture(page, `${selected}-failure`); throw error;
  } finally { await page.close(); await context.close(); }
} catch (error) { failure = error; }
finally {
  const results = await Promise.allSettled([browser?.close(), server.stop()]);
  cleanupErrors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
}
if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Canon sidebar smoke failed");
async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(shots, `${name}.png`), animations: "disabled" });
}
