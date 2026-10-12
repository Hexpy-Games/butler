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
const stage = before ? "before" : "after";
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
  if (path === "/security/browser-import/start") {
    const input = JSON.parse(raw.toString()); runs.push({ source: input.source, bookmarks: input.bookmarks, passwords: input.passwords, history: input.history });
    if (mode === "permission") return error("full_disk_access_required");
    if (mode === "primary" && !input.primary_password) return error("primary_password_required");
    await page.locator('[data-test-class="import-progress"]').waitFor();
    await page.locator('[data-test-class="import-progress"]').scrollIntoViewIfNeeded(); await capture("progress");
    return reply({ run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 120, history: 240, passwords: input.source.startsWith("safari:") ? 0 : 34, updated: input.source.startsWith("safari:") ? 0 : 5, existing: 0, needs_csv: input.source.startsWith("safari:") });
  }
  if (path === "/security/browser-import/export") return reply({ export_id: "fixture-export" });
  if (path === "/security/browser-import/export/poll") return reply(csvReady ? { run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 0, passwords: 34, updated: 5, existing: 0, export_id: "fixture-export" } : { waiting: true });
  if (path === "/security/browser-import/export/delete") { csvDeleted = true; return reply({ deleted: true }); }
  if (path === "/security/browser-import/export/cancel") return reply({ cancelled: true });
  if (path === "/security/browser-import/folder") { mode = "success"; return reply({ selected: true, source: "chrome:work" }); }
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
/** Consent is saved and the default model is the registered stub, so the wizard resumes with that AI connected. */
async function connectStub() {
  await page.reload();
  await page.locator("[data-first-run-screen=\"import\"]").waitFor();
}
/** Step order, back targets and the import step between the AI choice and the finish. */
async function wizardFlow(copy: AppCopy) {
  const steps = copy.firstRun.steps;
  await page.locator("#first-run-connect-title").waitFor();
  const labels = (await page.locator("ol li").allInnerTexts()).map(text => text.split("\n").at(-1)?.trim());
  assert.deepEqual(labels, [steps.welcome, steps.consent, steps.connect, copy.settings.pageSections.browserImport, steps.ready]);
  await wizardCapture("connect");
  await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
  await page.locator("#first-run-consent-title").waitFor();
  await page.getByRole("button", { name: copy.firstRun.agree, exact: true }).click();
  await page.locator("#first-run-connect-title").waitFor();
  await connectStub();
  const wizard = page.locator("[data-first-run-screen=\"import\"] [data-settings-section-id=\"browser-import\"]");
  await wizard.locator("[data-import-source]").nth(3).waitFor();
  assert.equal(await page.locator("ol [aria-current=\"step\"]").innerText(), `4\n${copy.settings.pageSections.browserImport}`);
  await wizardCapture("wizard-import");
  await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
  await page.locator("#first-run-connect-title").waitFor();
  fixtureSources = [];
  await connectStub();
  await wizard.getByText(copy.settings.browserImport.noSources, { exact: true }).waitFor();
  await wizardCapture("wizard-import-empty");
  fixtureSources = sources;
  await page.getByRole("button", { name: copy.settings.browserImport.continue, exact: true }).click();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await wizardCapture("ready");
  await page.getByRole("button", { name: copy.firstRun.back, exact: true }).click();
  await page.locator("[data-first-run-screen=\"import\"]").waitFor();
  await page.getByRole("button", { name: copy.settings.browserImport.continue, exact: true }).click();
  await page.locator("#first-run-reply-language:not(:disabled)").waitFor();
  await page.getByRole("button", { name: copy.firstRun.finish, exact: true }).click();
  await page.locator("[data-test-class=\"first-run-setup\"]").waitFor({ state: "detached" });
}
// Pin the existing renderer override: baseline captures must never swap shared build assets.
process.env.BUTLER_APP_RENDERER_DIST = resolve(before ?? "packages/butler-app/client/ui/dist");
try {
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  app = await firstRunElectron(server, `http://127.0.0.1:${address.port}`);
  page = app.page;
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
    await page.goto("app://butler/?settings=browser");
    const section = page.locator('[data-settings-section-id="browser-import"]');
    await section.waitFor();
    await section.locator("[data-import-source]").nth(3).waitFor();
    const history = page.locator('[data-settings-section-id="browser-history"]');
    await history.scrollIntoViewIfNeeded();
    if (!before) assert.equal(await history.getByText(copy.settings.browserImport.history, { exact: true }).count(), 1);
    await capture("history");
    await section.scrollIntoViewIfNeeded();
    const safari = section.locator('[data-import-source="safari:default"]');
    if (!before) assert.equal(await safari.getByText("Safari", { exact: true }).count(), 1);
    await capture("sources");
    if (before) {
      await section.locator("[aria-expanded]").first().click(); // The baseline UI hides item choice in a disclosure.
      await capture("picker");
      await section.locator('[data-import-source="chrome:work"]').click();
      await section.locator('[data-test-class="import-result"]').waitFor();
      await capture("result");
      continue;
    }
    assert.equal(await section.locator("[data-import-source]").count(), 4);
    await section.getByText(copy.settings.browserImport.chooseItems, { exact: true }).waitFor();
    for (const label of [copy.settings.browserImport.bookmarks, copy.settings.browserImport.passwords, copy.settings.browserImport.history]) assert.equal(await section.getByRole("checkbox", { name: label, exact: true }).getAttribute("aria-checked"), "true");
    fixtureSources = [];
    await page.reload();
    await section.getByText(copy.settings.browserImport.noSources, { exact: true }).waitFor();
    await section.scrollIntoViewIfNeeded(); await capture("sources-empty");
    fixtureSources = sources;
    await page.reload();
    await section.locator("[data-import-source]").nth(3).waitFor();
    await section.locator('[data-import-source="chrome:work"] button').click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5, 240), { exact: true }).waitFor();
    await capture("result");
    await section.getByRole("button", { name: copy.settings.browserImport.undo, exact: true }).click();
    await section.getByText(copy.settings.browserImport.undone).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    mode = "permission"; await section.locator('[data-import-source="chrome:work"] button').click();
    await section.locator('[data-test-class="import-permission"]').waitFor();
    await section.locator('[data-test-class="import-permission"]').scrollIntoViewIfNeeded(); await capture("permission");
    await section.getByRole("button", { name: copy.settings.browserImport.pickFolder, exact: true }).click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5, 240), { exact: true }).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    mode = "primary"; await section.locator('[data-import-source="firefox:default"] button').click();
    await section.getByLabel(copy.settings.browserImport.primaryPassword, { exact: true }).fill("fixture-primary");
    await section.getByRole("button", { name: copy.settings.browserImport.run, exact: true }).click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5, 240), { exact: true }).waitFor();
    assert.equal(await section.locator('input[type="password"]').count(), 0);
    mode = "success";
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    csvReady = false; csvDeleted = false;
    await section.locator('[data-import-source="safari:default"] button').click();
    await section.getByText(copy.settings.browserImport.waitingCsv, { exact: true }).waitFor();
    await capture("csv-waiting");
    csvReady = true;
    await section.getByText(copy.settings.browserImport.result(120, 34, 5, 240), { exact: true }).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.undo, exact: true }).click();
    await section.getByText(copy.settings.browserImport.undone, { exact: true }).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.deleteCsv, exact: true }).click();
    await section.getByRole("button", { name: copy.settings.browserImport.deleteCsv, exact: true }).waitFor({ state: "detached" });
    assert.equal(csvDeleted, true, "CSV deletion needs the owner's click");
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    await section.locator('[data-import-source="chrome:work"] button').click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5, 240), { exact: true }).waitFor();
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
