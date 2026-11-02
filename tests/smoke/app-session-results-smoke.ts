// Pane harness with working evidence, repeated deliveries, and a user upload.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MessageFileRef, SessionArtifactSummary, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { replaySession } from "../support/session-info-fixtures.ts";

if (await runSmokeCases(["light", "dark"], "BUTLER_RESULTS_THEME", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_RESULTS_THEME ?? "light";
const before = process.env.BUTLER_RESULTS_BASELINE === "1";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/butler-session-results-shots");
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: process.env.BUTLER_SMOKE_UI_ROOT });
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  browser = await launchSmokeBrowser();
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, reduce_motion: true }) });
  const { session } = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "공식 자료 비교" }) });
  const original = await server.api<SessionView>(`/session-view?session_id=${session.id}`);
  const firstAt = "2026-11-02T03:51:06.000Z", latestAt = "2026-11-02T04:11:04.000Z";
  const file = (id: string, path: string, deliverable: boolean, created_at = firstAt): MessageFileRef => ({
    file_id: id, safe_name: path.split("/").at(-1)!, source_label: path, deliverable, created_at,
    kind: "text", mime_type: "text/plain", size_bytes: 42, sha256: path === "report.md" ? "report-content-hash" : id,
    url: `/message-files/${id}`,
  });
  const artifact = (f: MessageFileRef): SessionArtifactSummary => ({
    ...f, id: `artifact-${f.file_id}`, title: f.safe_name, kind: "document", open_action: "route",
  });
  const working = Array.from({ length: 8 }, (_, n) => file(`working-${n}`, `sources/page-${n}.html`, false));
  const first = file("first-report", "report.md", true), latest = file("latest-report", "report.md", true, latestAt);
  let view: SessionView = { ...original, context: null, branch: null,
    artifacts: [...working, first].map(artifact),
    messages: [
      { id: "worker-result", chat_id: session.id, role: "assistant", text: "자료를 검토했습니다.", created_at: firstAt, attachments: [...working, first], artifacts: [...working.map(artifact), { ...artifact(first), title: "report.md · 이전" }] },
      { id: "parent-result", chat_id: session.id, role: "assistant", text: "비교표를 전달합니다.", created_at: latestAt, attachments: [latest], artifacts: [artifact(latest)] },
    ],
  };
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await replaySession(page, () => view, () => false);
  await page.addInitScript(id => { if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
    schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false,
  })); }, session.id);
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class="session-info-toggle"]').click();
  const aside = page.getByRole("complementary", { name: "세션 정보", exact: true });
  await aside.locator('[data-session-section="artifacts"]').waitFor();
  const results = aside.locator('[data-session-section="artifacts"]');
  const attachments = aside.locator('[data-session-section="attachments"]');
  assert.equal(await results.getByRole("button", { name: /report.md/u }).count(), before ? 2 : 1);
  assert.equal(await results.getByRole("button", { name: /page-\d.html/u }).count(), before ? 8 : 0);
  assert.equal(await attachments.count(), before ? 1 : 0);
  if (!before) assert.equal(await results.getByRole("button", { name: /이전/u }).count(), 0);
  await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-session-results-${theme}-2x.png`), animations: "disabled" });
  if (!before) {
    const upload = file("user-upload", "notes.txt", false);
    view = { ...view, messages: [...view.messages, { id: "user-upload-message", chat_id: session.id, role: "user", text: "첨부한 자료입니다.", created_at: latestAt, attachments: [upload] }] };
    await page.reload();
    await attachments.waitFor();
    assert.equal(await attachments.getByText("notes.txt", { exact: true }).count(), 1);
    assert.equal(await attachments.getByText("report.md", { exact: true }).count(), 0);
    assert.equal(await attachments.getByText(/page-\d.html/u).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-slot="conversation-aside"][data-layout="docked"]').waitFor({ state: "hidden" });
    await results.waitFor();
    assert.equal(await results.getByRole("button", { name: /report.md/u }).count(), 1);
    view = { ...view, artifacts: working.map(artifact), messages: [{ ...view.messages[0]!, attachments: working, artifacts: working.map(artifact) }] };
    await page.reload();
    await page.locator('[data-test-class="conversation"]').waitFor();
    await page.locator('[data-test-class="session-info-toggle"]').waitFor({ state: "detached" });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", theme, before, workingFiles: 8, resultEntries: before ? 10 : 1, userAttachments: before ? 10 : 0, scale: 2 }));
} finally {
  await browser?.close();
  await server.stop();
}
