// Native stub-backed UI smoke: all planning content is seeded through canon HTTP.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { openCanonBoard, seedCanonBoard, verifyCanonFlows } from "../support/canon-board-scenarios.ts";

const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/canon-board-smoke");
mkdirSync(shots, { recursive: true });
const before = process.env.BUTLER_SMOKE_BASELINE === "1";
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let count = 0;
try {
  const { projectId, planId } = await seedCanonBoard(server);
  browser = await launchSmokeBrowser();
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      main_screen_theme: wallpaper ? "silk" : "none", wallpaper: {
        source: wallpaper ? { kind: "live", module: "butler.silk" } : { kind: "none" }, motion: "paused", pauseOnBattery: false,
      },
    }) });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: "reduce" });
    try {
      await server.signIn(context);
      const page = await context.newPage();
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
      await board.getByRole("button", { name: "캐논", exact: true }).waitFor();
      assert.equal(await board.getByText(/GitHub|가져오기|동기화됨|마일스톤/).count(), 0);
      assert.equal(await board.getByRole("radio").count(), 0);
      await capture(page, `${name}-rest.png`); count++;
      const card = board.getByRole("button", { name: "캐논", exact: true });
      await card.focus(); await card.press("Enter");
      await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
      await card.click();
      await page.locator('[data-test-class="canon-epic-detail"]').waitFor();
      await capture(page, `${name}-detail.png`); count++;
      await page.locator('[data-test-class="canon-detail-panel"]').getByRole("button", { name: "닫기", exact: true }).click();
      await board.locator('[data-canon-backlog]').getByRole("button", { name: "새 과제", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await capture(page, `${name}-create.png`); count++;
      await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
      if (width === 390 && theme === "dark" && wallpaper) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await verifyCanonFlows(page, server, projectId, planId);
      }
      assert.deepEqual(errors, [], "No renderer errors");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport overflow");
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ result: "PASS", screenshots: count, directory: shots, stubModelCalls: server.stubModelCalls.length }));
} finally {
  await browser?.close();
  await server.stop();
}
async function capture(page: Page, filename: string): Promise<void> {
  // Scroll the real selected surface into view on phones; desktop keeps the whole board.
  const panel = page.locator('[data-test-class="canon-detail-panel"]');
  if (filename.endsWith("-detail.png")) await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shots, filename), animations: "disabled" });
}
