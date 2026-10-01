// Stub App harness: approval priority, question delivery, transcript and reload at mobile/desktop widths.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { api } from "../../packages/butler-app/client/ui/src/app/api";
import { snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache";
import { createNativeAppServer } from "../support/native-app-server";

const dir = mkdtempSync(join(tmpdir(), "butler-ask-user-ui-"));
const server = await createNativeAppServer({ butlerData: join(dir, "data"), uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: "en" } } });
const session = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Question smoke" }) });
const sessionId = session.session.id;
const browser = await chromium.launch({ headless: true });
const questions = { questions: [{ id: "format", eyebrow: "Output", title: "Which format?", kind: "single", allow_custom: true,
  options: [{ id: "brief", label: "Brief", recommended: true }, { id: "full", label: "Full" }] }] };
try {
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await server.signIn(page);
    await page.addInitScript(snapshot => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify(snapshot)), snapshotForAppUiState({ active_session_id: sessionId, left_open: false }));
    let approval = true;
    let pending = true;
    let response: unknown;
    const request = { request_ref: "question-ref-smoke", category: "ask_user", source_turn_id: "turn-question", source_session_id: `butler/app-${sessionId}`, question_state: "pending", questions };
    const allow = { request_ref: "approval-smoke", category: "command", reason: "Run a command?", executable: "echo", command_count: 1, source_turn_id: "turn-approval", scope: { title: "Run a command?", description: "echo smoke" } };
    const envelope = (data: unknown) => ({ protocol_version: "butler.app.v1", data });
    await page.route("**/session-view?*", async route => {
      if (new URL(route.request().url()).searchParams.get("session_id") !== sessionId) { await route.continue(); return; }
      const fetched = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
      assert.equal(fetched.status(), 200, await fetched.text());
      const body = await fetched.json();
      const view = body.data ?? body;
      view.pending_questions = pending ? [request] : [];
      view.authority_requests = approval ? [allow] : [];
      view.question_answers = response ? [{ request_ref: request.request_ref, source_turn_id: request.source_turn_id, updated_at: "2026-10-01T00:00:01Z", questions, response }] : [];
      view.messages = [{ id: "question-user", chat_id: sessionId, role: "user", turn_id: request.source_turn_id, text: "Help me choose.", status: "sent", cursor: 1 }];
      view.cursors.messages = 1;
      await route.fulfill({ json: body });
    });
    await page.route("**/authority-requests?*", route => route.fulfill({ json: envelope({ session_id: sessionId, requests: approval ? [allow, ...(pending ? [request] : [])] : pending ? [request] : [] }) }));
    await page.route("**/authority-requests/approval-smoke/deny?*", route => {
      approval = false;
      return route.fulfill({ status: 202, json: envelope({ request_ref: "approval-smoke", decision: "denied", scheduled: true }) });
    });
    await page.route("**/authority-requests/question-ref-smoke/answer?*", route => {
      response = route.request().postDataJSON();
      pending = (response as { status: string }).status === "deferred";
      request.question_state = pending ? "deferred" : "pending";
      return route.fulfill({ status: 202, json: envelope({ request_ref: request.request_ref, decision: "modified", scheduled: true }) });
    });
    await page.goto(server.url);
    const authority = page.locator('[data-test-class="composer-authority-decision"]');
    const panel = page.locator('[data-slot="composer-question-panel"]');
    await authority.waitFor();
    assert.equal(await panel.count(), 0, "question appeared ahead of approval");
    await authority.locator("button").first().click();
    await panel.waitFor();
    const box = await panel.boundingBox();
    assert(box && box.width <= width, "question exceeds viewport");
    await panel.getByText("Full", { exact: true }).click();
    const card = page.locator('[data-slot="question-answer-card"]');
    await card.waitFor();
    assert.equal(await card.getByText("Full", { exact: true }).count(), 1);
    assert.deepEqual(response, { status: "answered", answers: [{ id: "format", selected: ["full"], custom: null, skipped: false }] });
    await page.reload();
    await card.waitFor();
    assert.equal(await panel.count(), 0);
    response = undefined; pending = true;
    await page.reload();
    await panel.waitFor();
    await panel.getByRole("button", { name: "Answer later", exact: true }).click();
    const pill = page.getByRole("button", { name: "Answer pending", exact: true });
    await pill.waitFor();
    assert.deepEqual(response, { status: "deferred" });
    await page.reload();
    await pill.waitFor();
    await pill.click();
    await panel.waitFor();
    await panel.getByText("Full", { exact: true }).click();
    await card.waitFor();
    assert.deepEqual(response, { status: "answered", answers: [{ id: "format", selected: ["full"], custom: null, skipped: false }] });
    await page.close();
  }
  // The desktop bridge maps the same endpoint and stable IDs as browser/remote HTTP.
  const originalWindow = globalThis.window;
  let bridged: unknown;
  globalThis.window = { location: { origin: new URL(server.url).origin }, butlerApp: { answerUserQuestions: async (input: unknown) => { bridged = input; return { request_ref: "question-ref-smoke", decision: "modified", scheduled: true }; } } } as unknown as Window & typeof globalThis;
  try {
    const response = { status: "deferred" };
    await api(`/authority-requests/question-ref-smoke/answer?session_id=${encodeURIComponent(sessionId)}`, { method: "POST", body: JSON.stringify(response) });
    assert.deepEqual(bridged, { sessionId, requestRef: "question-ref-smoke", response });
  } finally { globalThis.window = originalWindow; }
  console.log(JSON.stringify({ ok: true, checks: ["approval-before-question", "stable-option-ids", "answer-summary", "reload", "later-restore", "desktop-bridge", "320px", "375px", "390px", "430px", "768px", "1280px"] }));
} finally {
  await browser.close(); await server.stop(); rmSync(dir, { recursive: true, force: true });
}
