// Stubbed native child -> committed BTCC progress -> SSE -> all mounted App surfaces.
// Run Electron with Node --experimental-strip-types for its inspector transport.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { liveDelegationStub } from "../support/live-delegation-stub.ts";
import { liveDelegationBrowser } from "../support/live-delegation-browser.ts";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime.ts";

const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);

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
  // 세션 정보 lists the unfinished subtask; it replaced the composer capsule.
  const pill = page.locator('[data-test-class="subtask-row"]');
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  try { await card.getByText(/1\/3/).waitFor(); } catch (error) {
    console.error(JSON.stringify({ body: await page.locator("body").innerText(), calls: server.stubModelCalls.length }));
    throw error;
  }
  // The tail rolls its rows (08f2fe847); the outgoing frame stays mounted until its animation ends.
  const activityLabel = await card.locator('[data-slot="rolling-swap"] > :not([data-motion="outgoing"]) [data-test-class="work-activity-tail-latest"]').textContent();
  assert(activityLabel !== null && activityLabel.trim().length > 0, "delegated activity label is present");
  assert(!/tool\s*usage|tool\s*use|use tool|working|work in progress|도구 사용|작업 중|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/iu.test(activityLabel),
    `delegated activity names the current work without a generic label or internal id: ${activityLabel}`);
  const parent = await server.api<{ active_turn: unknown; steward_children: unknown[]; subtasks: { state: string }[] }>("/session-view?session_id=general");
  assert.equal(parent.active_turn, null, "parent has ended while child runs");
  assert.equal(parent.steward_children.length, 1);
  assert.deepEqual(parent.subtasks.map(subtask => subtask.state), ["working"], "the open child is one working subtask");
  const navigation = await server.api<{ chats: { id: string; subtasks?: unknown[] }[] }>("/navigation");
  assert.equal(navigation.chats.find(chat => chat.id === "general")?.subtasks?.length, 1, "the navigation row carries the subtask");
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await pill.click();
  await dialog.waitFor();
  const url = page.url();
  let navigations = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  for (const [progress, checkpoint] of [["2/3", "Progress checkpoint 2"], ["3/3", "Progress checkpoint 3"]]) {
    await stub.whenHeld();
    stub.advance();
    try { await page.waitForFunction(({ progress, checkpoint }) => {
      const selectors = ['[data-test-class~="steward-parent-progress-card"]', '[data-test-class="subtask-row"]'];
      return selectors.every(selector => document.querySelector(selector)?.textContent?.includes(progress)) &&
        document.querySelector('[data-test-class="steward-observer-dialog"]')?.textContent?.includes(checkpoint);
    }, { progress, checkpoint }); } catch (error) {
      console.error(JSON.stringify({ progress, card: await card.textContent(), pill: await pill.textContent(), modal: await dialog.textContent() }));
      throw error;
    }
    if (output) await page.screenshot({ path: `${output}/live-${progress.replace("/", "-")}.png` });
  }
  assert.equal(navigations, 0, "no reload or navigation");
  assert.equal(page.url(), url);
  console.log(JSON.stringify({ ok: true, browser: browser.name, realSSE: true, parentEnded: true, surfaces: ["card", "progress", "session-info-subtask", "modal"], navigations }));
} finally {
  stub.release();
  await browser.close();
  await server.stop();
}
