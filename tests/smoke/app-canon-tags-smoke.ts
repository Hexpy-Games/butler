// test-category: race
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { openCanonBoard, seedCanonBoard } from "../support/canon-board-scenarios.ts";
import { captureTagViews, seedTagPalette } from "../support/canon-tags-visuals.ts";
import { verifyTagFlows } from "../support/canon-tags-flows.ts";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/canon-tags-smoke");
mkdirSync(shots, { recursive: true });
const cases = [1440, 1024, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["plain", "riso", "photo"].map(surface => `${width}-${theme}-${surface}`)));
if (await runSmokeCases(cases, "BUTLER_CANON_TAGS_CASE", import.meta.path, { isolate: true })) process.exit(0);
const cell = process.env.BUTLER_CANON_TAGS_CASE!;
const [widthText, theme, surface] = cell.split("-");
const width = Number(widthText), before = process.env.BUTLER_SMOKE_BASELINE === "1";
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let failure: unknown;
const cleanupErrors: unknown[] = [];
try {
  const { projectId, planId } = await seedCanonBoard(server);
  const { tags, palette } = await seedTagPalette(server, projectId, planId);
  let source: unknown = { kind: "none" };
  if (surface === "riso") source = { kind: "live", module: "butler.riso-print" };
  if (surface === "photo") {
    const form = new FormData();
    form.set("file", new Blob([readFileSync("packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/butler.photo-clouds/photo.jpg")], { type: "image/jpeg" }), "clouds.jpg");
    const response = await fetch(new URL("wallpapers", server.url), { method: "POST", headers: server.authHeaders, body: form });
    assert(response.ok);
    const { data } = await response.json() as { data: { id: string } };
    source = { kind: "image", asset: data.id, fit: "cover", dim: 0, blur: 0 };
  }
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    wallpaper: { source, motion: "paused", pauseOnBattery: false } }) });
  browser = await launchSmokeBrowser();
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await server.signIn(context);
    await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
      schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), left_open: true, right_open: false, right_panel_width: 376,
    })));
    await page.goto(server.url, { waitUntil: "load" });
    await openCanonBoard(page);
    await page.waitForFunction(expected => Boolean(document.querySelector('[data-test-class~="project-dashboard-wallpaper"]')) === expected, surface !== "plain");
    await captureTagViews(page, shots, `${before ? "before" : "after"}-${cell}`, tags, palette, before);
    if (!before && cell === "1440-light-plain") await verifyTagFlows(page, server, projectId, tags);
    assert.deepEqual(errors, [], "No renderer errors");
    assert.equal(server.stubModelCalls.length, 0);
    console.log(JSON.stringify({ result: "ASSERTIONS_PASS", case: cell, coverage: before ? "baseline" : "TG-07", flows: !before && cell === "1440-light-plain" ? "TG-01,TG-02,TG-03,TG-04,TG-05,CAS,deleted-tag,picker-row-manage" : "visual", screenshots: before ? 16 : 17, directory: shots }));
  } catch (error) {
    console.log("CASE_FAILURE", await page.locator("body").innerText());
    await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${cell}-failure.png`) });
    throw error;
  } finally {
    try { await page.close(); } catch (error) { cleanupErrors.push(error); }
    try { await context.close(); } catch (error) { cleanupErrors.push(error); }
  }
} catch (error) { failure = error; }
finally {
  const results = await Promise.allSettled([browser?.close(), server.stop()]);
  cleanupErrors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
}
if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Canon tags smoke failed");
console.log(JSON.stringify({ result: "PASS", case: cell, stubModelCalls: server.stubModelCalls.length }));
