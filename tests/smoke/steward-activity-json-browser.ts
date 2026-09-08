import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { SqliteBtccProgressEventRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-btcc-progress-event-repository.ts";
import { createGuidedActivityProjection, projectTurnProgressToEvents } from "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

// Isolated identity fixtures; actual producer, SQLite, observer HTTP and browser UI.
// No provider call, production mutation or synthetic UI activity row.
const dir = mkdtempSync(join(tmpdir(), "butler-activity-json-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0 });
server.store.updateSettings({ language: "ko" });
const parent = server.store.createSession({ kind: "chat", title: "실행 활동 저장 검증" }).session;
const db = new Database(join(dir, "agent-runtime", "btcc.sqlite"));
const turnId = "steward-turn-json";
const sessionId = "steward-json";
const now = new Date().toISOString();
db.query("INSERT INTO btcc_session_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("relation-json", `butler/app-${parent.id}`, "parent-turn-json", sessionId, "anchor", 1, "공식 자료 조사", now);
db.query(`INSERT INTO btcc_turns (turn_id, session_id, inbox_id, trigger_key, original_message_id,
  original_message, admission_snapshot_ref, model_selection_json, context_json, semantic_state, revision, execution_fence)
  VALUES (?, ?, 'inbox-json', 'trigger-json', 'anchor', 'Research', 'snapshot', '{}', '{}', 'admitted', 1, 0)`)
  .run(turnId, sessionId);
const repository = new SqliteBtccProgressEventRepository(db);
const progress = projectTurnProgressToEvents(event => {
  repository.append({ sessionId, turnId, event,
    destination: { transport: "app", accountId: "local", peer: { kind: "dm", id: parent.id }, replyToMessageId: "anchor" } });
});
const activity = createGuidedActivityProjection({ turnId, managedInitially: true, progress });
const observe = async (name: string, args: Record<string, unknown>, callId: string) => {
  activity.observeToolBatch({ text: "", toolCalls: [{ name, args }] });
  return activity.observeTool({ name, effectiveToolName: name, args, callId });
};
const review = await observe("record_work_review", { subject: "plan", verdict: "accept", summary: "공식 자료를 확인합니다.",
  action_updates: [{ action_key: "공식 자료 수집", status: "active" }] }, "review");
await activity.publishAccepted(review);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(({ key, setup, snapshot }) => {
    localStorage.setItem(key, JSON.stringify(setup));
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify(snapshot));
  }, { key: FIRST_RUN_STORAGE_KEY, setup: firstRunCompleteState("ko"),
    snapshot: snapshotForAppUiState({ active_session_id: parent.id, left_open: true, right_open: false }) });
  await page.goto(server.url);
  const capsule = page.locator('[data-test-class="steward-progress-capsule"]');
  await capsule.click();
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  await dialog.getByText("계획 검토", { exact: true }).waitFor();
  const search = await observe("web_search", { query: "public guidance" }, "search");
  await progress.operationChanged?.({ turnId, semanticState: "admitted", activityId: search.activityId,
    requestId: "search", publicTitle: "웹 검색", capabilityRef: "web_search", status: "started" });
  // Existing observer subscription must pick up persisted execution without reload.
  await dialog.getByText("공식 자료 수집", { exact: true }).waitFor();
  await dialog.getByText("웹 검색", { exact: true }).first().waitFor();
  const checkpoint = await observe("record_work_checkpoint", { public_summary: "수집한 자료를 비교합니다.", next_step: "본문 확인",
    action_updates: [{ action_key: "근거 대조", status: "active" }] }, "checkpoint");
  await activity.publishAccepted(checkpoint);
  await dialog.getByText("근거 대조", { exact: true }).waitFor();
  await dialog.locator('[data-test-class="toggle-turn-activity-disclosure"]').click();
  assert(await dialog.getByText("계획 검토", { exact: true }).isVisible());
  assert(await dialog.getByText("공식 자료 수집", { exact: true }).isVisible());
  const output = resolve(".tmp/activity-json");
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "steward-execution.png") });
  console.log("PASS: plan review → persisted execution/search → checkpoint in live Steward observer, no reload");
} finally {
  await browser.close();
  server.stop();
  db.close();
}
