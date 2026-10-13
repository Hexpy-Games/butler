import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Stub App harness: approval priority, question delivery, transcript and reload at mobile/desktop widths.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api } from "../../packages/butler-app/client/ui/src/app/api";
import { snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache";
import { createNativeAppServer } from "../support/native-app-server";

const dir = mkdtempSync(join(tmpdir(), "butler-ask-user-ui-"));
const server = await createNativeAppServer({ butlerData: join(dir, "data"), uiRoot: resolve("packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: "en" } } });
const session = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Question smoke" }) });
const sessionId = session.session.id;
const browser = await launchSmokeBrowser();
const context = await browser.newContext();
const questions = { questions: [{ id: "format", eyebrow: "Output", title: "Which format?", kind: "single", allow_custom: true,
  options: [{ id: "brief", label: "Brief", recommended: true }, { id: "full", label: "Full" }] }] };
try {
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 800 });
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
    if (process.env.BUTLER_SMOKE_EVIDENCE) {
      mkdirSync(process.env.BUTLER_SMOKE_EVIDENCE, { recursive: true });
      await page.screenshot({ path: join(process.env.BUTLER_SMOKE_EVIDENCE, `ask-user-${width}.png`) });
    }
    await page.close();
  }
  // A free-text question is one input; options that duplicate the card's Skip and free input never show,
  // and every remaining option answers when picked.
  const freeText = { questions: [
    { id: "name", eyebrow: "Name", title: "What is your name?", kind: "text", allow_custom: true, options: [] },
  ] };
  const controls = { questions: [{ id: "address", eyebrow: "Address", title: "How should I address you?", kind: "single", allow_custom: false, options: [
    { id: "boss", label: "Boss", kind: "answer" }, { id: "own", label: "I'll choose", kind: "input" }, { id: "later", label: "Skip for now", kind: "skip" }] }] };
  for (const [name, questions] of [["free-text", freeText], ["card-controls", controls]] as const) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await server.signIn(page);
    await page.addInitScript(snapshot => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify(snapshot)), snapshotForAppUiState({ active_session_id: sessionId, left_open: false }));
    const request = { request_ref: `question-ref-${name}`, category: "ask_user", source_turn_id: "turn-question", source_session_id: `butler/app-${sessionId}`, question_state: "pending", questions };
    let response: unknown;
    await page.route("**/session-view?*", async route => {
      if (new URL(route.request().url()).searchParams.get("session_id") !== sessionId) { await route.continue(); return; }
      const fetched = await route.fetch({ headers: { ...route.request().headers(), origin: new URL(server.url).origin } });
      const body = await fetched.json();
      const view = body.data ?? body;
      view.pending_questions = response ? [] : [request]; view.authority_requests = []; view.question_answers = [];
      await route.fulfill({ json: body });
    });
    await page.route("**/authority-requests?*", route => route.fulfill({ json: { protocol_version: "butler.app.v1", data: { session_id: sessionId, requests: response ? [] : [request] } } }));
    await page.route(`**/authority-requests/${request.request_ref}/answer?*`, route => {
      response = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { protocol_version: "butler.app.v1", data: { request_ref: request.request_ref, decision: "modified", scheduled: true } } });
    });
    await page.goto(server.url);
    const panel = page.locator('[data-slot="composer-question-panel"]');
    await panel.waitFor();
    if (name === "free-text") {
      assert.equal(await panel.locator("[data-question-option]").count(), 0, "free text has no option rows");
      assert.equal(await panel.locator("input").count(), 1, "free text is one input");
      await panel.locator("input").fill("Grace");
      await panel.locator("input").press("Enter");
      for (let i = 0; i < 100 && !response; i++) await page.waitForTimeout(20);
      assert.deepEqual(response, { status: "answered", answers: [{ id: "name", selected: [], custom: "Grace", skipped: false }] });
    } else {
      const rows = await panel.locator("[data-question-option]").allInnerTexts();
      assert.equal(rows.length, 2, `only the concrete answer and the card's own input: ${rows}`);
      assert.equal(await panel.getByText("Skip for now", { exact: true }).count(), 0);
      assert.equal(await panel.getByText("I'll choose", { exact: true }).count(), 0);
      await panel.getByText("Boss", { exact: true }).click();
      for (let i = 0; i < 100 && !response; i++) await page.waitForTimeout(20);
      assert.deepEqual(response, { status: "answered", answers: [{ id: "address", selected: ["boss"], custom: null, skipped: false }] });
    }
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
  console.log(JSON.stringify({ ok: true, checks: ["approval-before-question", "stable-option-ids", "answer-summary", "free-text-input", "card-control-options-dropped", "reload", "later-restore", "desktop-bridge", "320px", "375px", "390px", "430px", "768px", "1280px"] }));
} finally {
  await browser.close(); await server.stop(); rmSync(dir, { recursive: true, force: true });
}
