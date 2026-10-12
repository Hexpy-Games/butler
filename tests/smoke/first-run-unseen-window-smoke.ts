import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { firstRunStub } from "../support/first-run-stub";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { settleFirstRun } from "../support/first-run-visual";

// Fresh profile, an App window the user cannot see. The welcome card DOM renders at once; the intro waits for a
// visible window (hidden, then shown: it plays) and settles on its still frame when the shown window stays occluded
// (a locked or covered Mac screen, where Electron emits no "show").
const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);
const root = process.env.BUTLER_SMOKE_REPOSITORY_ROOT ?? process.cwd();
const fixture = resolve(root, "tests/support/electron-app-window-fixture.cjs");
const REVEAL_MS = 8_000;
const server = await createNativeAppServer({ onboardingComplete: false });
const stub = await firstRunStub(server);
const results: Record<string, unknown> = {};

type Bridge = Window & { butlerApp?: { setupWindowReady?: () => Promise<string> } };
/** The native visibility answer, or "pending" when it has not settled within waitMs. */
const native = (page: Page, waitMs: number) => page.evaluate((ms) => Promise.race([
  (window as Bridge).butlerApp?.setupWindowReady?.() ?? Promise.resolve("none"),
  new Promise<string>((done) => setTimeout(() => done("pending"), ms)),
]), waitMs);
const cardShown = (page: Page, timeout: number) => page.waitForFunction(() => document.querySelector("[data-setup-card]") !== null
  && document.querySelector('[data-intro="pending"], [data-intro="play"]') === null, null, { timeout });
const stageOpacity = (page: Page) => page.evaluate(() =>
  getComputedStyle(document.querySelector('[data-test-class="setup-wizard-stage"]')!).opacity);

async function launch(appWindow: string, run: (page: Page, domMs: number) => Promise<void>) {
  const launchedAt = Date.now();
  const app = await firstRunElectron(server, stub.url, "[data-first-run-screen]", {
    foreground: false, env: { NODE_OPTIONS: `--require ${JSON.stringify(fixture)}`, BUTLER_SMOKE_APP_WINDOW: appWindow },
  });
  try { await run(app.page, Date.now() - launchedAt); } finally { await app.stop(); }
}

try {
  // Never shown yet: the card DOM is laid out while the intro holds; shown later, the intro starts and settles.
  await launch(`hidden:${REVEAL_MS}`, async (page, domMs) => {
    assert.equal(await page.locator("#first-run-start").count(), 1, "welcome card DOM without a visible window");
    assert.equal(await page.locator('[data-intro="pending"]').count(), 1, "the intro holds for a visible window");
    assert.equal(await native(page, 1_000), "pending", "native: the window has not been shown");
    assert.equal(await native(page, REVEAL_MS + 5_000), "shown", "native: the window became visible");
    const played = await page.locator('[data-intro="play"]').waitFor({ state: "attached", timeout: 3_000 }).then(() => true, () => false);
    await cardShown(page, 10_000);
    await settleFirstRun(page);
    assert.equal(await stageOpacity(page), "1", "the card is painted after the intro");
    const stage = await page.locator("[data-stage]").last().getAttribute("data-stage");
    assert.equal(stage, "current", "the full intro ran, not the still entrance");
    results.hidden = { domMs, native: "shown", played, stage };
  });
  // Shown but occluded: within 5 s the card arrives on the dried still, without the reveal.
  await launch("occluded", async (page, domMs) => {
    assert.equal(await page.locator("#first-run-start").count(), 1, "welcome card DOM in an occluded window");
    const domAt = Date.now();
    await cardShown(page, 5_000);
    const cardMs = Date.now() - domAt;
    await settleFirstRun(page);
    assert.equal(await native(page, 1_000), "still", "native: the shown window never became visible");
    assert.equal(await stageOpacity(page), "1", "the card is painted");
    assert.equal(await page.locator("[data-setup-card]").evaluate((card) => card.getBoundingClientRect().width), 420, "welcome card laid out");
    const stage = await page.locator("[data-stage]").last().getAttribute("data-stage");
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    assert.equal(stage, reduced ? "current" : "rerun", "the card takes the still entrance");
    results.occluded = { domMs, cardMs, native: "still", stage };
  });
  assert.equal(server.stubModelCalls.length, 0, "no provider calls");
  console.log(JSON.stringify({ ok: true, ...results }));
} finally {
  stub.stop();
  await server.stop();
}
