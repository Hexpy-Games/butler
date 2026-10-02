import { launchSmokeBrowser } from "../support/browser-launch.ts";
// Browser regression for the observer's incremental session-view contract.
// The native gateway/stub model owns startup; only the child projection is
// intercepted, so the real modal, store, timer and HTTP client perform refreshes.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium, firefox } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const engine = process.env.BUTLER_SMOKE_BROWSER === "firefox" ? firefox : chromium;
const browser = await (engine === chromium ? launchSmokeBrowser() : engine.launch({ headless: true }));
const original = structuredClone(HARNESS_SS03_OBSERVER_VIEW);
const turn = original.latest_turn!;
const first = original.messages[0]!;
const activity = {
  id: "observer-read", kind: "message", state: "delivered",
  semantic_block_id: "observer-history", work_decision_source: "model-authored" as const,
  work_decision_summary: "Read the complete source",
  safe_label: "Read the complete source", safe_tool_name: "Read",
  created_at: first.created_at,
};
original.messages = [
  { ...first, id: "observer-user", role: "user", text: "Original request", status: "delivered", cursor: 1 },
  { ...first, id: "observer-answer", text: "Original answer", status: "delivered", cursor: 2,
    turn_id: "observer-history", turn_activity_rows: [activity] },
];
original.message_window = { next_cursor: 2, next_cursor_token: "after-2", complete: true };
let phase: "idle" | "delivered" | "reopened" | "empty" = "idle";
const requests: string[] = [];

function responseFor(url: URL): SessionView {
  const token = url.searchParams.get("cursor_token");
  requests.push(token ?? "snapshot");
  if (phase === "reopened" || phase === "empty" || requests.length === 1 || !token) return original;
  const delivered = phase === "delivered";
  return {
    ...original,
    status: delivered ? "delivered" : "active",
    active_turn: delivered ? null : original.active_turn,
    latest_turn: delivered ? { ...turn, state: "delivered", delivery_state: "delivered", cancellable: false } : turn,
    messages: delivered && token === "after-2" ? [{
      ...first, id: "observer-final", text: "Final answer", status: "delivered", cursor: 3,
    }] : [],
    message_window: {
      next_cursor: delivered ? 3 : 2, next_cursor_token: delivered ? "after-3" : "after-2",
      requested_cursor: token === "after-3" ? 3 : 2, requested_cursor_token: token!, complete: true,
    },
  };
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await server.signIn(page);
  await page.route("**/session-view?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("session_id") !== original.session_id) return route.continue();
    await route.fulfill({ json: { data: responseFor(url) } });
  });
  await page.goto(`${server.url}?visual=components&surface=ss03`);
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  await dialog.getByText("Original answer", { exact: true }).waitFor();
  await page.waitForResponse((response) => response.url().includes("cursor_token=after-2"));
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await dialog.getByText("Original answer", { exact: true }).count(), 1,
    "an empty delta must preserve the original answer");
  assert.equal(await dialog.getByText("Original request", { exact: true }).count(), 1);
  await dialog.locator('[data-test-class="turn-current-phase-activity"][data-turn-id="observer-history"]')
    .getByRole("button", { expanded: false }).click();
  await dialog.getByText("Read the complete source", { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-test-class="steward-observer-message"]').count(), 4,
    "both messages and their activity remain present");

  phase = "delivered";
  await dialog.getByText("Final answer", { exact: true }).waitFor();
  await page.waitForResponse((response) => response.url().includes("cursor_token=after-3"));
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  assert.equal(await dialog.getByText("Original answer", { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("Final answer", { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("Read the complete source", { exact: true }).count(), 1);
  assert.equal(await dialog.locator('[data-test-class="steward-observer-message"]').count(), 4);
  assert.equal(await dialog.locator('[data-test-class~="current-turn-status"]').count(), 0,
    "the terminal response clears running activity");
  assert.equal(await dialog.getByRole("button", { name: "Stop", exact: true }).count(), 0);

  // A new full snapshot must replace the old window, rather than accumulating
  // stale messages forever. Closing/reopening also must retain terminal truth.
  phase = "reopened";
  original.messages = [{ ...first, id: "observer-canonical", text: "Canonical snapshot", status: "delivered" }];
  original.active_turn = null;
  original.latest_turn = { ...turn, state: "delivered", delivery_state: "delivered", cancellable: false };
  original.status = "delivered";
  original.message_window = { next_cursor: 1, complete: true };
  await dialog.getByText("Canonical snapshot", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("Original answer", { exact: true }).count(), 0);
  // Even a genuinely empty terminal child must never claim to be processing.
  phase = "empty";
  original.messages = [];
  original.message_window = { next_cursor: 0, complete: true };
  for (const [status, label] of [
    ["delivered", appCopy.interfaceStatus.delivered],
    ["failed", appCopy.interfaceStatus.failedPast],
    ["cancelled", appCopy.interfaceStatus.cancelled],
  ] as const) {
    original.status = status;
    original.latest_turn = { ...turn, state: status, cancellable: false };
    await dialog.getByText(label, { exact: true }).waitFor();
    assert.equal(await dialog.getByText(appCopy.conversation.work.pendingLabel, { exact: true }).count(), 0);
  }
  console.log(JSON.stringify({ ok: true, service: "steward-refresh", browser: engine.name(),
    requests, checks: ["empty-delta", "activity-retained", "new-answer", "terminal-state", "snapshot-replacement", "empty-terminal-status"] }));
} finally {
  await browser.close();
  await server.stop();
}
