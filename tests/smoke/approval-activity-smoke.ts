// Real gateway transport and timeline, with deterministic stub authority/form resumes.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

if (await runSmokeCases(["light", "dark"], "BUTLER_APPROVAL_ACTIVITY_CASE", import.meta.path)) process.exit(0);
const theme = process.env.BUTLER_APPROVAL_ACTIVITY_CASE ?? "light";
const before = Bun.argv.includes("--before");
const output = process.env.BUTLER_APPROVAL_ACTIVITY_SHOTS;
assert(output, "Set BUTLER_APPROVAL_ACTIVITY_SHOTS to the screenshot directory");
mkdirSync(output, { recursive: true });
let mode: "authority" | "question" = "authority";
let pendingTool = false;
let observedSkills = false;
let resumeStarted = false;
let release: (() => void) | undefined;
let resumed: Promise<void>;
const preamble = "요청하신 내용을 확인했습니다.";
const answer = "요청하신 작업을 완료했습니다.";
const server = await createNativeAppServer({
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
  stubReply: async request => {
    if (!request.stream) return "{}";
    if (pendingTool) return preamble;
    resumeStarted = true;
    await resumed;
    return answer;
  },
  stubToolCall: request => {
    if (!request.stream || !pendingTool) return null;
    if (!observedSkills) {
      observedSkills = true;
      return { name: "list_skills", arguments: {} };
    }
    pendingTool = false;
    return mode === "authority"
      ? { name: "write_file", arguments: { path: join(server.butlerData, "approval-activity.txt"), content: "approved", overwrite: true } }
      : { name: "ask_user", arguments: { questions: [{ id: "format", eyebrow: "형식", title: "어떤 형식으로 할까요?", kind: "single", allow_custom: true,
        options: [{ id: "brief", label: "간단히", recommended: true }, { id: "full", label: "자세히" }] }] } };
  },
});
const browser = await launchSmokeBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
await server.signIn(page);
const assistant = page.locator('[data-test-class="message assistant"]');
const groups = page.locator('[data-test-class="turn-current-phase-activity"]');
const terminal = page.locator('[data-test-class="assistant-terminal-status-row"]');
let sessionId: string | null = null;
page.on("request", request => {
  const url = new URL(request.url());
  if (url.pathname === "/session-view") sessionId = url.searchParams.get("session_id");
});
async function assistantRecords(waitPending = false) {
  assert(sessionId, "real session observed");
  const deadline = Date.now() + 20_000;
  for (;;) {
    const view = await server.api<{ latest_turn: { state: string }; messages: Array<{ id: string; role: string; status: string }> }>(`/session-view?session_id=${encodeURIComponent(sessionId)}`);
    if (!waitPending || view.latest_turn.state === "waiting_for_form") return view.messages.filter(message => message.role === "assistant");
    assert(Date.now() < deadline, "suspension transport was not projected");
    await new Promise(done => setTimeout(done, 20));
  }
}
async function capture(stage: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output!, `${before ? "before" : "after"}-1280-${theme}-${mode}-${stage}.png`) });
}
async function waitResume() {
  const deadline = Date.now() + 20_000;
  while (!resumeStarted) {
    assert(Date.now() < deadline, "stub resume did not start");
    await new Promise(done => setTimeout(done, 20));
  }
}
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", access_mode: "ask_first", appearance_theme: theme,
    wallpaper: { source: { kind: "none" } } }) });
  for (mode of ["authority", "question"] as const) {
    if (page.url() !== "about:blank") await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(server.url);
    const editor = page.locator('[contenteditable="true"]');
    await editor.waitFor();
    pendingTool = true; observedSkills = false; resumeStarted = false;
    resumed = new Promise(done => { release = done; });
    await editor.fill(`${mode}: 요청을 처리해 주세요.`);
    await page.locator('[data-test-class="composer-send-button"]').click();
    const panel = page.locator(mode === "authority" ? '[data-test-class="composer-authority-decision"]' : '[data-slot="composer-question-panel"]');
    await panel.waitFor();
    await assistant.waitFor();
    const splits = before || mode === "question";
    await page.getByText(preamble, { exact: true }).waitFor();
    assert.equal(await assistant.count(), 1);
    assert.equal(await groups.count(), 1);
    if (!splits) assert.equal(await terminal.count(), 0, "approval must not finish before resume");
    const records = await assistantRecords(true);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, splits ? "delivered" : "streaming");
    const id = records[0].id;
    await capture("pending");
    if (mode === "authority") await panel.getByRole("button", { name: "이번만 허용", exact: true }).click();
    else await panel.getByText("자세히", { exact: true }).click();
    await waitResume();
    if (!splits) assert.equal(await terminal.count(), 0, "approval resume must not show an intermediate completion");
    await capture("resuming");
    release!();
    await page.getByText(answer, { exact: true }).waitFor();
    await page.waitForFunction(expected => document.querySelectorAll('[data-test-class="assistant-terminal-status-row"]').length === expected, splits ? 2 : 1);
    assert.equal(await assistant.count(), splits ? 2 : 1);
    if (!splits) assert.equal(await groups.count(), 1, "authority retains one complete activity group");
    assert.equal((await assistantRecords()).length, splits ? 2 : 1, "forms retain both durable message segments");
    if (!splits) assert.equal((await assistantRecords())[0].id, id, "same turn bubble reused");
    await capture("completed");
    await page.reload();
    await page.getByText(answer, { exact: true }).waitFor();
    assert.equal(await assistant.count(), splits ? 2 : 1, "reload preserves segmentation");
    if (!splits) assert.equal(await groups.count(), 1);
  }
  console.log(JSON.stringify({ ok: true, before, theme, width: 1280, screenshots: 6, authorityMessages: before ? 2 : 1, questionMessages: 2 }));
} catch (error) {
  console.error(error);
  await capture("failure").catch(() => undefined);
  throw error;
} finally {
  release?.();
  await page.goto("about:blank").catch(() => undefined);
  try { await browser.close(); } finally { await server.stop(); }
}
