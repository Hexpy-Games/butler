// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { openCanonBoard, seedCanonBoard } from "../support/canon-board-scenarios.ts";
import { verifyInlineFields, verifyInlineExits } from "../support/canon-inline-edit-flows.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/canon-inline-edit-smoke");
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let failure: unknown;
let cleanupErrors: unknown[] = [];
try {
  const { projectId, planId } = await seedCanonBoard(server);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "dark",
    wallpaper: { source: { kind: "live", module: "butler.riso-print" }, motion: "paused", pauseOnBattery: false } }) });
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const epic = canon.plans.find(plan => plan.id === planId)!.works.find(work => work.title === "문서")!;
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await server.signIn(page.context());
  await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false, right_panel_width: 376,
  })));
  await page.goto(server.url, { waitUntil: "load" });
  await openCanonBoard(page);
  await page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first().click();
  await page.locator('[data-test-class="canon-epic-detail"]').getByRole("heading", { name: "문서", exact: true }).waitFor();
  await verifyInlineFields(page, server, epic.id, shots);
  await verifyInlineExits(page, server, epic.id, shots);
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
