// Stubbed native child -> committed BTCC progress -> SSE -> all mounted App surfaces.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { createNativeAppServer } from "../support/native-app-server";
import { liveDelegationStub } from "../support/live-delegation-stub";
import { liveDelegationBrowser } from "../support/live-delegation-browser";

const stub = liveDelegationStub();
const server = await createNativeAppServer(stub.options);
const browser = await liveDelegationBrowser(server);
const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (output) mkdirSync(output, { recursive: true });
try {
  const { page } = browser;
  await server.signIn(page);
  await page.addInitScript(() => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: "general", left_open: true, right_open: false,
  })));
  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill("Delegate a three step progress check.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
  const pill = page.locator('[data-test-class="steward-progress-capsule"]');
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  try { await card.getByText(/1\/3/).waitFor(); } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), calls: server.stubModelCalls.length }));
    throw error;
  }
  const parent = await server.api<{ active_turn: unknown; steward_children: unknown[] }>("/session-view?session_id=general");
  assert.equal(parent.active_turn, null, "parent has ended while child runs");
  assert.equal(parent.steward_children.length, 1);
  await pill.click();
  await dialog.waitFor();
  const url = page.url();
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  const timings: number[] = [];
  for (const [progress, checkpoint] of [["2/3", "Progress checkpoint 2"], ["3/3", "Progress checkpoint 3"]]) {
    await stub.whenHeld();
    const started = Date.now();
    stub.advance();
    try { await page.waitForFunction(({ progress, checkpoint }) => {
      const selectors = ['[data-test-class~="steward-parent-progress-card"]', '[data-test-class="steward-progress-capsule"]'];
      return selectors.every(selector => document.querySelector(selector)?.textContent?.includes(progress)) &&
        document.querySelector('[data-test-class="steward-observer-dialog"]')?.textContent?.includes(checkpoint);
    }, { progress, checkpoint }, { timeout: 1000 }); } catch (error) {
      console.error(JSON.stringify({ progress, card: await card.textContent(), pill: await pill.textContent(), modal: await dialog.textContent() }));
      throw error;
    }
    const elapsed = Date.now() - started;
    assert(elapsed <= 1000, `all delegated surfaces: ${elapsed}ms`);
    timings.push(elapsed);
    if (output) await page.screenshot({ path: `${output}/live-${progress.replace("/", "-")}.png` });
  }
  assert.equal(navigations, 0, "no reload or navigation");
  assert.equal(page.url(), url);
  console.log(JSON.stringify({ ok: true, browser: browser.name, realSSE: true, timingsMs: timings, parentEnded: true, surfaces: ["card", "progress", "pill", "modal"], navigations }));
} finally {
  stub.release();
  await browser.close();
  await server.stop();
}
