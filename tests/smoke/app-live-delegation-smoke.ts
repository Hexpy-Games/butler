// Stubbed native child -> committed BTCC progress -> SSE -> all mounted App surfaces.
import { strict as assert } from "node:assert";
import { chromium, firefox } from "playwright";
import { mkdirSync } from "node:fs";
import { createNativeAppServer } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { liveDelegationStub } from "../support/live-delegation-stub";

const stub = liveDelegationStub();
const server = await createNativeAppServer(stub.options);
const engine = process.env.BUTLER_SMOKE_BROWSER === "firefox" ? firefox : chromium;
const browser = await engine.launch({ headless: true, args: engine === chromium ? smokeBrowserArgs() : [] });
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill("Delegate a three step progress check.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
  const pill = page.locator('[data-test-class="steward-progress-capsule"]');
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  await card.getByText(/1\/3/).waitFor();
  await page.getByText("Delegated work started.", { exact: true }).waitFor();
  await pill.click();
  await dialog.waitFor();
  const url = page.url();
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  const timings: number[] = [];
  for (const progress of ["2/3", "3/3"]) {
    const started = Date.now();
    stub.advance();
    await page.waitForFunction(progress => {
      const selectors = ['[data-test-class~="steward-parent-progress-card"]', '[data-test-class="steward-progress-capsule"]', '[data-test-class="steward-observer-dialog"]'];
      return selectors.every(selector => document.querySelector(selector)?.textContent?.includes(progress));
    }, progress, { timeout: 1000 });
    const elapsed = Date.now() - started;
    assert(elapsed <= 1000, `all delegated surfaces: ${elapsed}ms`);
    timings.push(elapsed);
    if (output) await page.screenshot({ path: `${output}/live-${progress.replace("/", "-")}.png` });
  }
  assert.equal(navigations, 0, "no reload or navigation");
  assert.equal(page.url(), url);
  console.log(JSON.stringify({ ok: true, browser: engine.name(), realSSE: true, timingsMs: timings, parentEnded: true, surfaces: ["card", "progress", "pill", "modal"], navigations }));
} finally {
  stub.release();
  await browser.close();
  await server.stop();
}
