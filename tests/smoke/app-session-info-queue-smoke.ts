// test-category: race
// Native gateway plus session projection replay; no provider calls.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProgressRow, QueuedMessageRecord, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installPendingAskEvents, replaySession } from "../support/session-info-fixtures.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";

const themes = ["light", "dark"];
if (await runSmokeCases(themes, "BUTLER_QUEUE_THEME", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_QUEUE_THEME ?? "light";
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? join(tmpdir(), "butler-session-queue-shots"));
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    reduce_motion: true, wallpaper: { source: { kind: "none" } } }) });
  const { session } = await server.api<{ session: { id: string } }>("/sessions", {
    method: "POST", body: JSON.stringify({ kind: "chat", title: "후속 메시지 확인" }),
  });
  const original = await server.api<SessionView>(`/session-view?session_id=${session.id}`);
  const progress: ProgressRow[] = [
    { id: "accepted", kind: "message", state: "running", safe_label: "Request accepted." },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `round-${i}`, kind: "turn", state: "thinking", safe_label: "upstage/solar-pro4" })),
    { id: "tool", kind: "used_tool", state: "waiting_for_tool", safe_label: "generate_image" },
  ];
  const view: SessionView = { ...original, branch: null, context: null, pending_questions: [], messages: [], artifacts: [], automations: [],
    latest_turn: { id: "queue-turn", state: "thinking", cancellable: true, retryable: false,
      created_at: original.updated_at, updated_at: original.updated_at, progress: { safe_progress_rows: progress } } };
  const queued: QueuedMessageRecord = { id: "follow-up", chat_id: session.id, text: "검토 결과 정리", state: "queued", cursor: 1,
    created_at: original.updated_at, updated_at: original.updated_at,
    controls: { model: "custom/stub", reasoning_effort: "none", access_mode: "ask_first", plan_mode: false } };
  let queue: QueuedMessageRecord[] = [queued];
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installPendingAskEvents(page);
  await replaySession(page, () => view, () => false);
  await page.route("**/session-queue?**", route => route.fulfill({ json: {
    protocol_version: "butler.app.v1", data: { session_id: session.id, queued_messages: queue },
  } }));
  await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id,
    left_open: true, right_open: false, session_info_open: true,
  })), session.id);
  await server.signIn(page);
  const toggle = page.locator('[data-test-class="session-info-toggle"]');
  const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
  const card = aside.locator('[data-session-section="queue"]');
  await page.goto(server.url);
  await card.getByText(queued.text, { exact: true }).waitFor();
  assert.deepEqual(await card.innerText(), ["작업 대기열", baseline ? "7" : "1",
    ...(baseline ? progress.map(row => row.safe_label) : []), queued.text].join("\n"));
  await page.evaluate(() => document.fonts.ready);
  await aside.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-queue-${theme}.png`), animations: "disabled" });
  // Dispatching is still a queued follow-up. Terminal records and other sessions are not.
  if (!baseline) {
    queue = [{ ...queued, state: "dispatching" }, { ...queued, id: "delivered", state: "dispatched" },
      { ...queued, id: "other-session", chat_id: "another-session" }];
    await page.reload();
    await card.getByText(queued.text, { exact: true }).waitFor();
    assert.equal(await card.innerText(), ["작업 대기열", "1", queued.text].join("\n"));
  }
  // Keep all six progress events active while removing the queued follow-up.
  queue = [];
  const queueRead = page.waitForResponse(response => response.url().includes("/session-queue?") && response.ok());
  await page.reload();
  await queueRead;
  if (baseline) {
    await card.getByText("6", { exact: true }).waitFor();
  } else {
    await toggle.waitFor({ state: "detached" });
    assert.equal(await card.count(), 0);
    assert.equal(await aside.count(), 0);
  }
  assert.deepEqual(errors, []);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ queueCard: baseline ? "BASELINE_REPRODUCED" : "PASS", theme,
    progressRows: progress.length, queuedCount: baseline ? 7 : 1, emptyCount: baseline ? 6 : 0, shots }));
} finally {
  await browser?.close();
  await server.stop();
}
