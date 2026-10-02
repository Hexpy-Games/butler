// Review evidence from the existing harness; resume uses the real HTTP/store
// path with fixture responses, never a live model or the owner's installation.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchSmokeBrowser } from "../support/browser-launch.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { HARNESS_SS03_OBSERVER_VIEW, HARNESS_SS03_SUMMARY } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";

import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";

const output = resolve(".tmp/steward-311");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const files: string[] = [];
try {
  for (const width of [375, 1280]) for (const theme of ["light", "dark"] as const) {
    if (process.env.BUTLER_REVIEW_WIDTH && String(width) !== process.env.BUTLER_REVIEW_WIDTH) continue;
    if (process.env.BUTLER_REVIEW_THEME && theme !== process.env.BUTLER_REVIEW_THEME) continue;
    for (const locale of ["ko", "en"]) for (const state of ["progress", "summary", "plan", "waiting", "recoverable", "resumed"]) {
      if (process.env.BUTLER_REVIEW_LOCALE && locale !== process.env.BUTLER_REVIEW_LOCALE) continue;
      if (process.env.BUTLER_REVIEW_STATE && state !== process.env.BUTLER_REVIEW_STATE) continue;
      console.log(`capture ${state} ${width} ${theme} ${locale}`);
      const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
      await server.signIn(page);
      const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
      let resumed = false;
      const active = structuredClone(HARNESS_SS03_OBSERVER_VIEW);
      const child = HARNESS_SS03_SUMMARY.steward_children![0]!;
      active.active_turn = child.active_turn;
      active.latest_turn = child.latest_turn;
      await page.route("**/steward-relations/*/resume", async (route) => {
        assert.equal(route.request().method(), "POST");
        resumed = true;
        active.active_turn = { ...active.active_turn!, id: "harness-resumed-turn" };
        active.latest_turn = active.active_turn;
        await route.fulfill({ json: { data: { ok: true } } });
      });
      await page.route("**/session-view?**", async (route) => {
        const id = new URL(route.request().url()).searchParams.get("session_id");
        if (id === active.session_id) {
          const view = structuredClone(active);
          if (state === "waiting") { view.active_turn = null; view.waiting_for_children = true; }
          if ((state === "recoverable" || state === "resumed") && !resumed) {
            view.active_turn = null;
            view.status = "failed";
            view.latest_turn = { ...view.latest_turn!, state: "runtime_fault", retryable: true };
          }
          await route.fulfill({ json: { data: view } });
        } else if (id === "butler-client") {
          await route.fulfill({ json: { data: { ...HARNESS_SS03_OBSERVER_VIEW, ...HARNESS_SS03_SUMMARY, session_id: id } } });
        } else await route.continue();
      });
      const selected = state === "resumed" ? "recoverable" : state;
      await page.goto(`${server.url}?visual=components&surface=ss03&steward=${selected}&theme=${theme}&locale=${locale}`);
      const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
      await dialog.waitFor();
      if (state === "resumed") {
        await dialog.getByRole("button", { name: copy.conversation.work.resumeInterrupted, exact: true }).click();
        await dialog.getByRole("button", { name: copy.composer.stop, exact: true }).waitFor();
        assert(resumed, "resume must execute the HTTP command");
      }
      if (state === "summary" || state === "plan" || state === "recoverable") {
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        const hideInspector = page.locator('[data-test-class="right-panel-overlay-close"]');
        if (await hideInspector.isVisible()) await hideInspector.click();
        const hideSidebar = page.getByRole("button", { name: copy.titlebar.hideLeftPanel, exact: true });
        if (width === 375 && await hideSidebar.isVisible()) await hideSidebar.click();
        await page.locator('[data-test-class~="steward-parent-progress-card"]').waitFor();
        if (state === "plan") {
          const capsule = page.locator('[data-test-class~="steward-progress-capsule"]');
          await capsule.waitFor();
          assert((await capsule.innerText()).includes("2/3"), "accepted plan counter");
        }
      }
      if (state === "progress") {
        const toggle = dialog.locator('[data-test-class="turn-current-phase-activity"] button[aria-expanded="false"]').first();
        if (await toggle.count()) await toggle.click();
        const tools = dialog.locator('[data-test-class~="turn-work-tool-group"] button[aria-expanded="false"]').first();
        if (await tools.count()) await tools.click();
      }
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.waitForFunction(() => document.getAnimations().every((animation) =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      const name = `${state}-${width}-${theme}-${locale}.png`;
      await page.screenshot({ path: resolve(output, name), fullPage: true });
      files.push(name);
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  }
  writeFileSync(resolve(output, `screenshots-${process.env.BUTLER_REVIEW_WIDTH ?? "all"}-${process.env.BUTLER_REVIEW_THEME ?? "all"}.json`), JSON.stringify({ files, resume: "stub HTTP response through the product store" }, null, 2));
  console.log(JSON.stringify({ ok: true, files }));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser.close();
  await server.stop();
}
