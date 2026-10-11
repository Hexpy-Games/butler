// Real App renderer and native gateway; source data responses are deterministic offline fixtures.
import { createServer } from "node:http";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";

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
const runs: unknown[] = [];
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
  if (path === "/security/browser-import/sources") return reply({ sources });
  if (path === "/security/browser-import/start") {
    const input = JSON.parse(raw.toString()); runs.push({ source: input.source, bookmarks: input.bookmarks, passwords: input.passwords });
    if (mode === "permission") return error("full_disk_access_required");
    if (mode === "primary" && !input.primary_password) return error("primary_password_required");
    await page.locator('[data-test-class="import-progress"]').waitFor(); await capture("progress");
    return reply({ run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 120, passwords: input.source.startsWith("safari:") ? 0 : 34, updated: 5, existing: 0, needs_csv: input.source.startsWith("safari:") });
  }
  if (path === "/security/browser-import/export") return reply({ export_id: "fixture-export" });
  if (path === "/security/browser-import/export/poll") return reply(csvReady ? { run_id: "00000000-0000-4000-8000-000000000001", bookmarks: 0, passwords: 34, updated: 5, existing: 0, export_id: "fixture-export" } : { waiting: true });
  if (path === "/security/browser-import/export/delete") { csvDeleted = true; return reply({ deleted: true }); }
  if (path === "/security/browser-import/export/cancel") return reply({ cancelled: true });
  if (path === "/security/browser-import/folder") { mode = "success"; return reply({ selected: true, source: "chrome:work" }); }
  if (path === "/security/browser-import/undo") return reply({ bookmarks: 120, passwords: 34 });
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
const uiDist = resolve("packages/butler-app/client/ui/dist");
const savedUi = before ? mkdtempSync(join(tmpdir(), "import-before-ui-")) : null;
try {
  if (savedUi) { renameSync(uiDist, join(savedUi, "dist")); cpSync(before!, uiDist, { recursive: true }); }
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address(); assert.ok(address && typeof address !== "string");
  app = await firstRunElectron(server, `http://127.0.0.1:${address.port}`);
  page = app.page;
  for (const locale of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) {
    cell = `${locale}-${theme}-1440`;
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme,
      onboarding: { consent_version: null, accepted_at: null, completed_at: null }, wallpaper: { source: { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
    await page.reload(); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator("#first-run-language").selectOption(locale);
    await capture("welcome");
    await page.getByRole("button", { name: copy.firstRun.start, exact: true }).click();
    await page.getByRole("button", { name: copy.firstRun.agree, exact: true }).click();
    if (!before) {
      await page.locator('[data-first-run-screen="import"]').waitFor();
      await capture("wizard-import");
      await page.getByRole("button", { name: copy.settings.browserImport.skip, exact: true }).click();
    }
    await page.locator("#first-run-connect-title").waitFor();
    await capture("connect");
    const current = await server.api<{ onboarding: Record<string, unknown> }>("/settings");
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ onboarding: { ...current.onboarding, completed_at: new Date().toISOString() } }) });
    await page.goto("app://butler/");
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
    await section.waitFor(); await section.scrollIntoViewIfNeeded();
    await capture("sources");
    if (before) continue;
    assert.equal(await section.locator("[data-import-source]").count(), 4);
    await section.getByRole("button", { name: copy.settings.browserImport.chooseItems, exact: true }).click();
    for (const label of [copy.settings.browserImport.bookmarks, copy.settings.browserImport.passwords]) assert.equal(await section.getByRole("checkbox", { name: label, exact: true }).getAttribute("aria-checked"), "true");
    await section.locator('[data-import-source="chrome:work"]').click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5), { exact: true }).waitFor();
    await capture("result");
    await section.getByRole("button", { name: copy.settings.browserImport.undo, exact: true }).click();
    await section.getByText(copy.settings.browserImport.undone).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    mode = "permission"; await section.locator('[data-import-source="chrome:work"]').click();
    await section.locator('[data-test-class="import-permission"]').waitFor(); await capture("permission");
    await section.getByRole("button", { name: copy.settings.browserImport.pickFolder, exact: true }).click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5), { exact: true }).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    mode = "primary"; await section.locator('[data-import-source="firefox:default"]').click();
    await section.getByLabel(copy.settings.browserImport.primaryPassword, { exact: true }).fill("fixture-primary");
    await section.getByRole("button", { name: copy.settings.browserImport.run, exact: true }).click();
    await section.getByText(copy.settings.browserImport.result(120, 34, 5), { exact: true }).waitFor();
    assert.equal(await section.locator('input[type="password"]').count(), 0);
    mode = "success";
    await section.getByRole("button", { name: copy.settings.browserImport.more, exact: true }).click();
    csvReady = false; csvDeleted = false;
    await section.locator('[data-import-source="safari:default"]').click();
    await section.getByText(copy.settings.browserImport.waitingCsv, { exact: true }).waitFor();
    await capture("csv-waiting");
    csvReady = true;
    await section.getByText(copy.settings.browserImport.result(120, 34, 5), { exact: true }).waitFor();
    await section.getByRole("button", { name: copy.settings.browserImport.deleteCsv, exact: true }).click();
    await section.getByRole("button", { name: copy.settings.browserImport.deleteCsv, exact: true }).waitFor({ state: "detached" });
    assert.equal(csvDeleted, true, "CSV deletion needs the owner's click");
    for (const width of [320, 390, 430]) { await page.setViewportSize({ width, height: 1000 }); await capture(`result-${width}`); }
  }
  assert.equal(server.stubModelCalls.length, 0);
  writeFileSync(join(output, stage, "functional-results.json"), JSON.stringify({ stage, captures, runs, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, stage, screenshots: captures.length, modelCalls: 0 }));
} finally {
  await app?.stop(); proxy.closeAllConnections(); proxy.close(); await server.stop();
  if (savedUi) { rmSync(uiDist, { recursive: true, force: true }); renameSync(join(savedUi, "dist"), uiDist); rmSync(savedUi, { recursive: true, force: true }); }
}
