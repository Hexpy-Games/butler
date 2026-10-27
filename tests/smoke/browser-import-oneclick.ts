// Real App renderer and native gateway; source data responses are deterministic offline fixtures.
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
import { settleFirstRun } from "../support/first-run-visual";

const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);
const output = process.env.BUTLER_IMPORT_EVIDENCE;
assert.ok(output, "explicit evidence directory required");
const before = process.env.BUTLER_IMPORT_BEFORE_UI;
const stage = process.env.BUTLER_IMPORT_STAGE ?? (before ? "before" : "after");
mkdirSync(join(output, stage), { recursive: true });
const server = await createNativeAppServer({ onboardingComplete: false, uiRoot: resolve(before ?? "packages/butler-app/client/ui/dist") });
let app: Awaited<ReturnType<typeof firstRunElectron>> | undefined;
let mode: "success" | "permission" | "primary" = "success";
let csvReady = false;
let csvDeleted = false;
const runs: { source: string; bookmarks: boolean; passwords: boolean; history: boolean }[] = [];
const captures: string[] = [];
const sources = [{ key: "chrome:work", browser: "chrome", name: "Work", passwords: "direct" },
  { key: "chrome:personal", browser: "chrome", name: "Personal", passwords: "direct" },
  { key: "firefox:default", browser: "firefox", name: "Personal", passwords: "direct" },
  { key: "safari:default", browser: "safari", name: "Safari", passwords: "csv" }];
// Other AI tools: the proxy answers, so the Agent never reads this machine's real tool folders.
const agentSources = [
  { key: "codex", name: "Codex", instructions: true, instructions_file: "~/.codex/AGENTS.md", servers: 3, needs_secret: 1, skipped: 0, unreadable: false },
  { key: "claude-code", name: "Claude Code", instructions: true, instructions_file: "~/.claude/CLAUDE.md", servers: 2, needs_secret: 1, skipped: 0, unreadable: false },
  { key: "opencode", name: "OpenCode", instructions: false, instructions_file: null, servers: 1, needs_secret: 0, skipped: 0, unreadable: false },
  { key: "hermes", name: "Hermes", instructions: true, instructions_file: "~/.hermes/SOUL.md", servers: 0, needs_secret: 0, skipped: 0, unreadable: false }];
const agentRuns: string[] = [];
let page: import("playwright").Page;
const proxy = createServer((request, response) => {
  void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
});
async function handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) {
  const path = new URL(request.url!, "http://localhost").pathname;
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  const reply = (data: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ protocol_version: "butler.app.v1", data })); };
  const error = (code: string) => { response.writeHead(422, { "content-type": "application/json" }); response.end(JSON.stringify({ protocol_version: "butler.app.v1", error: { code } })); };
  if (path === "/security/signins") return reply({ available: true, sites: [] });
  if (path === "/security/browser-import/sources") return reply({ sources: fixtureSources });
  if (path === "/security/agent-import/sources") return reply({ sources: agentSources });
  if (path === "/security/agent-import/start") {
    agentRuns.push(JSON.parse(raw.toString()).source);
    return reply({ run_id: "00000000-0000-4000-8000-000000000002", instructions: 1, instructions_existing: 0, servers: 3, servers_existing: 0, needs_secret: 1, skipped: 0 });
  }
  if (path === "/security/agent-import/undo") return reply({ instructions: 1, servers: 3 });
  if (path === "/security/browser-import/start") {
    const input = JSON.parse(raw.toString()); runs.push({ source: input.source, bookmarks: input.bookmarks, passwords: input.passwords, history: input.history });
    if (mode === "permission") return error("full_disk_access_required");
    if (mode === "primary" && !input.primary_password) return error("primary_password_required");
    await page.locator('[data-test-class="import-progress"]').waitFor();
    await page.locator('[data-test-class="import-progress"]').scrollIntoViewIfNeeded(); await capture("progress");
    return reply({ run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 120, history: 240, passwords: input.source.startsWith("safari:") ? 0 : 34, invalid: 2, updated: input.source.startsWith("safari:") ? 0 : 5, existing: 0, needs_csv: input.source.startsWith("safari:") });
  }
  if (path === "/security/browser-import/export") return reply({ export_id: "fixture-export" });
  if (path === "/security/browser-import/export/poll") return reply(csvReady ? { run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 0, passwords: 34, updated: 5, invalid: 2, existing: 0, export_id: "fixture-export" } : { waiting: true });
  if (path === "/security/browser-import/export/delete") { csvDeleted = true; return reply({ deleted: true }); }
  if (path === "/security/browser-import/export/cancel") return reply({ cancelled: true });
  if (path === "/security/browser-import/folder") { assert.equal(JSON.parse(raw.toString()).path, resolve("/tmp/browser-import-picked")); mode = "success"; return reply({ selected: true, source: "chrome:work" }); }
  if (path === "/security/browser-import/undo") return reply({ bookmarks: 120, history: 240, passwords: 34 });
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  const upstream = await fetch(new URL(request.url!, server.url), { method: request.method, headers, ...(raw.length ? { body: raw } : {}) });
  response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "transfer-encoding", "content-length"].includes(name))));
  if (path === "/events/live") {
    const reader = upstream.body!.getReader(); response.on("close", () => void reader.cancel().catch(() => {}));
    while (!response.destroyed) { const { done, value } = await reader.read(); if (done) break; response.write(value); }
    response.end(); return;
  }
  response.end(Buffer.from(await upstream.arrayBuffer()));
}
let cell = "";
async function capture(state: string) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, state);
  const name = `${cell}-${state}.png`; captures.push(name);
  await page.screenshot({ path: join(output!, stage, name) });
}
type AppCopy = ReturnType<typeof getAppCopy>;
let fixtureSources = sources;
async function wizardCapture(state: string) { await settleFirstRun(page); await capture(state); }
/** Consent is saved and the default model is the registered stub, so the wizard resumes at the reply language (AI ③). */
async function connectStub() {
  await page.reload();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
}
/** The card morph briefly shows the leaving and arriving cards; read the step once only one is left. */
async function activeStep() {
  await settleFirstRun(page);
  return await page.locator("ol [aria-current=\"step\"]").innerText();
}
/** Step order, back targets and the import step (other AI tools) between the AI choice and the finish. */
async function wizardFlow(copy: AppCopy) {
  const steps = copy.firstRun.steps, text = copy.firstRun;
  await page.locator("[data-first-run-screen=\"memory\"]").waitFor();
  await page.locator("[data-memory-choice=\"off\"]").click();
  await page.getByRole("button", { name: text.memoryChoice.continue, exact: true }).click();
  await page.locator("#first-run-connect-title").waitFor();
  // The previous step's card may still be leaving; read the step list once it is alone.
  await page.waitForFunction(() => document.querySelectorAll("ol").length === 1);
  // The active step carries its substep count ("AI 연결 1/3"); the labels themselves stay the step names.
  const labels = (await page.locator("ol li").allInnerTexts()).map(entry => entry.split("\n").at(-1)?.replace(/\s\d+\/\d+$/u, "").trim());
  assert.deepEqual(labels, [steps.welcome, steps.consent, steps.memory, steps.connect, copy.settings.pageSections.import, steps.ready]);
  assert.equal(await activeStep(), `4\n${steps.connect} 1/3`);
  await wizardCapture("connect");
  await page.getByRole("button", { name: text.back, exact: true }).click();
  await page.locator("[data-first-run-screen=\"memory\"]").waitFor();
  await page.getByRole("button", { name: text.memoryChoice.continue, exact: true }).click();
  await page.locator("#first-run-connect-title").waitFor();
  await connectStub();
  const runsBefore = agentRuns.length;
  await page.getByRole("button", { name: text.next, exact: true }).click();
  await page.locator("[data-agent-import-source]").nth(3).waitFor();
  // Import is one page (other AI tools); browsers are imported from Settings only.
  assert.equal(await activeStep(), `5\n${copy.settings.pageSections.import}`, "import has no substep counter");
  await wizardCapture("wizard-agents");
  await page.getByRole("button", { name: text.import.skip, exact: true }).click();
  await page.getByRole("heading", { name: text.doneTitle, exact: true }).waitFor();
  assert.equal(agentRuns.length, runsBefore, "Skip imports nothing");
  assert.equal(await page.locator("[data-import-source]").count(), 0, "no browser import in first run");
  await wizardCapture("ready");
  await page.getByRole("button", { name: text.back, exact: true }).click();
  await page.locator("#first-run-agents-title").waitFor();
  await page.getByRole("button", { name: text.import.skip, exact: true }).click();
  await page.getByRole("heading", { name: text.doneTitle, exact: true }).waitFor();
  await page.getByRole("button", { name: text.finish, exact: true }).click();
  await page.locator("[data-test-class=\"first-run-setup\"]").waitFor({ state: "detached" });
}
/** Settings → Personalization: other AI tools as rows, one import, then its result row (no undo) and Import more. */
async function agentSettings(copy: AppCopy) {
  await page.goto("app://butler/?settings=personalization");
  const section = page.locator("[data-settings-section-id=\"agent-import\"]");
  await section.locator("[data-agent-import-source]").nth(3).waitFor();
  // The memory import is the last row of the same section; no second import heading.
  await section.locator("[data-setting-id=\"profile-migration\"]").getByText(copy.settings.fields.profileMigrationImport, { exact: true }).waitFor();
  assert.equal(await page.locator("[data-settings-section-id=\"import\"]").count(), 0);
  await section.scrollIntoViewIfNeeded(); await capture("agent-import");
  await section.locator("[data-agent-import-source=\"codex\"] button").click();
  await section.getByText(copy.settings.agentImport.result(1, 3, 1), { exact: true }).waitFor();
  await section.scrollIntoViewIfNeeded(); await capture("agent-import-result");
  await page.setViewportSize({ width: 390, height: 1000 }); await section.scrollIntoViewIfNeeded(); await capture("agent-import-result-390");
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await section.locator('[data-test-class="agent-import-result"]').getByText("Codex", { exact: true }).count(), 1, "the result names the tool");
  assert.equal(await section.getByRole("button", { name: /되돌리기|Undo/u }).count(), 0, "no undo in Settings");
  assert.equal(agentRuns.at(-1), "codex");
  await section.getByRole("button", { name: copy.settings.agentImport.more, exact: true }).click();
  await section.locator("[data-agent-import-source]").nth(3).waitFor();
}
// Pin the existing renderer override: baseline captures must never swap shared build assets.
process.env.BUTLER_APP_RENDERER_DIST = resolve(before ?? "packages/butler-app/client/ui/dist");
try {
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  app = await firstRunElectron(server, `http://127.0.0.1:${address.port}`);
  page = app.page;
  await app.main(`(()=>{const {dialog}=process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/main.mjs"))})("electron");dialog.showOpenDialog=async(_window,options)=>{
    if(options.properties.length!==1 || options.properties[0]!=="openDirectory") throw new Error("folder picker options");
    return {canceled:globalThis.importFolderCanceled===true,filePaths:[${JSON.stringify(resolve("/tmp/browser-import-picked"))}]};
  }})()`);
  await app.main("globalThis.importFolderCanceled=true");
  assert.equal(await page.evaluate(() => (window as unknown as { butlerApp: { pickBrowserFolder: () => Promise<string | null> } }).butlerApp.pickBrowserFolder()), null);
  await app.main("globalThis.importFolderCanceled=false");
  for (const locale of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) {
    cell = `${locale}-${theme}-1440`;
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme,
      onboarding: { consent_version: null, accepted_at: null, completed_at: null }, wallpaper: { source: { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
    await page.locator("#first-run-language").selectOption(locale);
    await capture("welcome");
    await page.getByRole("button", { name: copy.firstRun.start, exact: true }).click();
    await page.locator("#first-run-consent-title").waitFor();
    await wizardCapture("consent");
    await page.getByRole("button", { name: copy.firstRun.agree, exact: true }).click();
    if (before) {
      await page.locator("[data-first-run-screen=\"import\"]").waitFor();
      await wizardCapture("wizard-import");
      await page.getByRole("button", { name: copy.settings.browserImport.skip, exact: true }).click();
      await page.locator("#first-run-connect-title").waitFor();
      await wizardCapture("connect");
      const current = await server.api<{ onboarding: Record<string, unknown> }>("/settings");
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: { ...current.onboarding, completed_at: new Date().toISOString() } }) });
    } else await wizardFlow(copy);
    await page.goto("app://butler/");
    if (await page.locator('[data-test-class="mac-window"]').getAttribute("data-left-open") === "false") {
      await page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true }).click();
    }
    await page.getByRole("button", { name: copy.library.title, exact: true }).click();
    const emptyBookmarks = page.locator('[data-library-kind="bookmark"]');
    await emptyBookmarks.getByText(copy.library.noItems, { exact: true }).waitFor();
    await capture("drawer-empty");
    if (!before) {
      await emptyBookmarks.getByRole("button", { name: copy.settings.pageSections.browserImport, exact: true }).click();
      await page.locator('[data-settings-section-id="browser-import"]').waitFor();
    }
    if (!before) await agentSettings(copy);
    await page.goto("app://butler/?settings=browser");
    const section = page.locator('[data-settings-section-id="browser-import"]');
    await section.waitFor();
    if (before) await section.locator("[data-import-source]").nth(3).waitFor();
    const history = page.locator('[data-settings-section-id="browser-history"]');
    await history.scrollIntoViewIfNeeded();
    if (!before) assert.equal(await history.getByText(copy.settings.browserImport.history, { exact: true }).count(), 1);
    await capture("history");
    await section.scrollIntoViewIfNeeded();
    if (before) {
      await capture("sources");
      await section.locator("[aria-expanded]").first().click(); // The baseline UI hides item choice in a disclosure.
      await capture("picker");
      await section.locator('[data-import-source="chrome:work"]').click();
      await section.locator('[data-test-class="import-result"]').waitFor();
      await capture("result");
      continue;
    }
    // The section is one button; the dialog walks browser → items → import.
    const bi = copy.settings.browserImport;
    const dialog = page.getByRole("dialog");
    assert.equal(await section.locator("[data-import-source]").count(), 0, "sources live in the dialog");
    await capture("section");
    const openImport = async () => {
      await section.getByRole("button", { name: bi.open, exact: true }).click();
      await dialog.locator('[data-browser-import-step="browser"]').waitFor();
    };
    const choose = async (key: string) => {
      await dialog.locator(`[data-import-source="${key}"]`).click();
      await dialog.getByRole("button", { name: bi.next, exact: true }).click();
      await dialog.locator('[data-browser-import-step="items"]').waitFor();
    };
    const runImport = () => dialog.getByRole("button", { name: bi.run, exact: true }).click();
    const more = async () => {
      await dialog.getByRole("button", { name: bi.more, exact: true }).click();
      await dialog.locator('[data-browser-import-step="browser"]').waitFor();
    };
    await openImport();
    await dialog.locator("[data-import-source]").nth(4).waitFor();
    assert.equal(await dialog.locator("[data-import-source]").count(), 5, "four profiles and file import");
    assert.equal(await dialog.locator('[data-import-source="safari:default"]').getByText("Safari", { exact: true }).count(), 1);
    assert.equal(await dialog.getByRole("radio", { checked: true }).count(), 1, "the first profile is picked");
    await capture("sources");
    await choose("chrome:work");
    assert.equal(await dialog.locator('[aria-current="step"]').innerText(), `2\n${bi.chooseItems}`, "the stepper marks step 2");
    await dialog.locator("legend").filter({ hasText: bi.chooseItems }).waitFor();
    for (const label of [bi.bookmarks, bi.passwords, bi.history]) assert.equal(await dialog.getByRole("checkbox", { name: label, exact: true }).getAttribute("aria-checked"), "true");
    await capture("items");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    fixtureSources = [];
    await page.reload();
    await openImport();
    await dialog.getByText(bi.noSources, { exact: true }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: bi.next, exact: true }).isDisabled(), true, "Next waits for a choice");
    await capture("sources-empty");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    fixtureSources = sources;
    await page.reload();
    await openImport();
    await choose("chrome:work");
    await runImport();
    await dialog.getByText(bi.result(120, 34, 5, 240, 2), { exact: true }).waitFor();
    await capture("result");
    assert.equal(await dialog.getByRole("button", { name: /되돌리기|Undo/u }).count(), 0, "no undo in Settings");
    assert.equal(await dialog.locator('[data-test-class="import-result"]').getByText("Chrome · Work", { exact: true }).count(), 1, "the result names the profile");
    await more();
    mode = "permission"; await choose("chrome:work"); await runImport();
    await dialog.locator('[data-test-class="import-permission"]').waitFor();
    await capture("permission");
    await dialog.getByRole("button", { name: bi.pickFolder, exact: true }).click();
    await dialog.getByText(bi.result(120, 34, 5, 240, 2), { exact: true }).waitFor();
    await more();
    mode = "primary"; await choose("firefox:default"); await runImport();
    await dialog.getByLabel(bi.primaryPassword, { exact: true }).fill("fixture-primary");
    await capture("primary-password");
    await runImport();
    await dialog.getByText(bi.result(120, 34, 5, 240, 2), { exact: true }).waitFor();
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    mode = "success";
    await more();
    csvReady = false; csvDeleted = false;
    await choose("safari:default"); await runImport();
    await dialog.getByText(bi.waitingCsv, { exact: true }).waitFor();
    await capture("csv-waiting");
    csvReady = true;
    await dialog.getByRole("button", { name: bi.deleteCsv, exact: true }).waitFor();
    await dialog.getByText(bi.result(120, 34, 5, 240, 2), { exact: true }).waitFor();
    await capture("csv-result");
    await dialog.getByRole("button", { name: bi.deleteCsv, exact: true }).click();
    await dialog.getByRole("button", { name: bi.deleteCsv, exact: true }).waitFor({ state: "detached" });
    assert.equal(csvDeleted, true, "CSV deletion needs the owner's click");
    await more();
    await choose("chrome:work"); await runImport();
    await dialog.getByText(bi.result(120, 34, 5, 240, 2), { exact: true }).waitFor();
    for (const width of [320, 390, 430]) { await page.setViewportSize({ width, height: 1000 }); await capture(`result-${width}`); }
  }
  if (!before) assert.ok(runs.every(run => run.history === true), "history is selected by default");
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(output, stage, "functional-results.json"), JSON.stringify({ stage, captures, runs, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, stage, screenshots: captures.length, modelCalls: 0 }));
} catch (error) {
  if (app) {
    await app.page.screenshot({ path: join(output, stage, `${cell}-failure.png`) }).catch(() => {});
    const screen = await app.page.evaluate(() => ({ url: location.href, language: document.documentElement.lang,
      wizard: document.querySelector("[data-first-run-screen]")?.getAttribute("data-first-run-screen"),
      buttons: [...document.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent) }));
    const settings = await server.api<{ language: string; onboarding: unknown }>("/settings");
    writeFileSync(join(output, stage, "failure.json"), JSON.stringify({ error: String(error), screen, settings: { language: settings.language, onboarding: settings.onboarding } }, null, 2));
  }
  throw error;
} finally {
  await app?.stop(); proxy.closeAllConnections(); proxy.close(); await server.stop();
}
