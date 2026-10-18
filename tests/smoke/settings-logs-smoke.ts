// Settings › 로그 on the structured /logs API: public UI -> isolated native gateway.
// The gateway's own records feed the list; a few fixture rows are added to the
// first page (static, HTTP with and without a stored body, error) so every row
// shape renders. No model calls.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { auditTabOrder, formatClips } from "../support/focus-ring-clipping";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = ["1280-light", "1280-dark", "390-light", "390-dark"];
if (await runSmokeCases(cases, "BUTLER_LOGS_CASE", import.meta.path)) process.exit(0);
const selected = process.env.BUTLER_LOGS_CASE;
const shots = resolve(process.env.BUTLER_LOGS_SHOTS ?? ".tmp/settings-logs");
mkdirSync(shots, { recursive: true });
const copy = getAppCopy("ko-KR");
const logs = copy.settings.logs;
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);
const rows = (page: Page) => section(page, "logs-viewer").locator('[data-test-class="log-row"]');
const row = (page: Page, title: string) => rows(page).filter({ has: page.getByText(title, { exact: true }) });
const BODY_REF = "smoke-body:0:32";

function fixtureRows(): unknown[] {
  const ts = (offset: number) => new Date(Date.now() - offset * 1000).toISOString();
  const base = { process: "agent", attrs: {} };
  return [
    { ...base, ts: ts(1), level: "INFO", category: "smoke.static", event: "smoke.static", msg: "Static smoke row" },
    { ...base, ts: ts(2), level: "INFO", category: "http.client", event: "http.client", msg: "Smoke model request",
      duration_ms: 412, trace_id: "tr_smoke_1", body_ref: BODY_REF,
      attrs: { method: "POST", url: "https://api.example.test/v1/chat", status: 200,
        request_headers: { authorization: "[redacted]", "content-type": "application/json" },
        response_headers: { "content-type": "application/json" } } },
    { ...base, ts: ts(3), level: "DEBUG", category: "http.client", event: "http.client", msg: "Smoke upload",
      attrs: { method: "PUT", url: "https://uploads.example.test/file", headers: { "content-type": "text/plain" } } },
    { ...base, ts: ts(4), level: "ERROR", category: "smoke.error", event: "smoke.error", msg: "Smoke failure",
      error: { message: "stub failure" } },
    ...Array.from({ length: 30 }, (_, index) => ({ ...base, ts: ts(10 + index), level: "INFO", category: "smoke.filler",
      event: "smoke.filler", msg: `Filler row ${index}`, attrs: { index } })),
  ];
}

/** First unfiltered page: the gateway's rows after the fixtures. Bodies: the fixture body. */
async function routeFixtures(page: Page) {
  await page.route((url) => url.pathname === "/logs", async (route) => {
    const url = new URL(route.request().url());
    // Route fetches leave the browser's fetch metadata behind; name the page's origin.
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: url.origin } });
    const payload = await response.json() as { data?: { rows: unknown[] } };
    if (!response.ok() || !payload.data) {
      console.error(`GET /logs ${response.status()} ${JSON.stringify(payload)}`);
      return route.fulfill({ response });
    }
    const plain = route.request().method() === "GET" && !url.searchParams.has("cursor") && !url.searchParams.has("q") && !url.searchParams.has("level")
      && !url.searchParams.has("category") && url.searchParams.get("source") === "all";
    if (plain) payload.data.rows = [...fixtureRows(), ...payload.data.rows];
    await route.fulfill({ response, json: payload });
  });
  await page.route((url) => url.pathname.startsWith("/logs/bodies/"), async (route) => {
    assert.equal(decodeURIComponent(new URL(route.request().url()).pathname.slice("/logs/bodies/".length)), BODY_REF);
    await route.fulfill({ contentType: "application/octet-stream", body: JSON.stringify({ reply: "smoke body text" }) });
  });
}

async function openSettings(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(label);
  const option = dialog.getByRole("option").filter({ has: page.getByText(label, { exact: true }) }).first();
  await option.click();
  await page.locator('[data-test-class~="settings-detail-title"]').filter({ hasText: label }).first().waitFor();
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no page overflow`);
  await page.screenshot({ path: resolve(shots, `${name}.png`), animations: "allow", timeout: 10_000 });
  await page.mouse.move(0, 0);
}

async function newPage(browser: Browser, server: NativeAppServerHandle, width: number, theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ko-KR", colorScheme: theme, acceptDownloads: true });
  await server.signIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await routeFixtures(page);
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  const close = async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  };
  return { page, errors, close };
}

async function expectZipDownload(page: Page, click: () => Promise<void>) {
  const download = page.waitForEvent("download");
  await click();
  const path = await (await download).path();
  assert(path, "export downloads a file");
  assert.equal(readFileSync(path).subarray(0, 2).toString("latin1"), "PK", "export is a zip");
}

/** Developer mode off: no 로그 page, no 보안 › 진단; 정보 offers 진단 내보내기. */
async function developerOffChecks(page: Page, prefix: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(copy.settings.sections.logs);
  await page.waitForTimeout(400);
  assert.equal(await dialog.getByRole("option").filter({ has: page.getByText(copy.settings.sections.logs, { exact: true }) }).count(), 0,
    "로그 is hidden outside developer mode");
  await page.keyboard.press("Escape");
  await openSettings(page, copy.settings.sections.security);
  await section(page, "grants").waitFor();
  assert.equal(await section(page, "diagnostics").count(), 0, "보안 has no 진단 section");
  await capture(page, `${prefix}-security`);
  await openSettings(page, copy.settings.sections.about);
  const exportButton = section(page, "diagnostics").getByRole("button", { name: logs.diagnosticsExport, exact: true });
  await exportButton.waitFor();
  await capture(page, `${prefix}-about`);
  await expectZipDownload(page, () => exportButton.click());
  await page.getByText(logs.exported, { exact: true }).first().waitFor();
}

async function levelChecks(page: Page, prefix: string) {
  const level = section(page, "logs-level");
  await level.getByText(logs.levelMeta.standard, { exact: true }).waitFor();
  await level.getByRole("radio", { name: logs.levels.full, exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: logs.fullConfirmTitle, exact: true });
  await confirm.getByText(logs.fullConfirmBody, { exact: true }).waitFor();
  await capture(page, `${prefix}-full-confirm`);
  await confirm.getByRole("button", { name: logs.fullConfirm, exact: true }).click();
  await level.getByText(/^전체 기록 중 · (59|60)분 남음$/u).waitFor();
  const off = level.getByRole("button", { name: logs.turnOff, exact: true });
  await capture(page, `${prefix}-full-active`);
  await off.click();
  await page.locator("[data-sonner-toast]").first().waitFor();
  await level.getByText(logs.levelMeta.standard, { exact: true }).waitFor();
  assert.equal(await off.count(), 0, "끄기 leaves with the lease");
  await level.getByRole("radio", { name: logs.levels.minimal, exact: true }).click();
  await page.locator("[data-sonner-toast]").filter({ hasText: /비웠습니다|저장됨/u }).first().waitFor();
  await level.getByText(logs.levelMeta.minimal, { exact: true }).waitFor();
  await level.getByRole("radio", { name: logs.levels.standard, exact: true }).click();
  await level.getByText(logs.levelMeta.standard, { exact: true }).waitFor();
}

async function rowChecks(page: Page, prefix: string) {
  const staticRow = row(page, "Static smoke row");
  await staticRow.waitFor();
  assert.equal(await staticRow.locator('[data-static="true"]').count(), 1, "nothing to reveal: static row");
  assert.equal(await staticRow.getByRole("button").count(), 0, "static row has no button");
  await row(page, "Smoke failure").getByRole("button").click();
  await row(page, "Smoke failure").getByText("stub failure", { exact: true }).waitFor();
  const http = row(page, "Smoke model request");
  await http.getByRole("button", { expanded: false }).click();
  for (const tab of [logs.tabs.request, logs.tabs.response, logs.tabs.json]) await http.getByRole("tab", { name: tab, exact: true }).waitFor();
  await http.getByText(/authorization: \[redacted\]/u).waitFor();
  await http.getByRole("tab", { name: logs.tabs.response, exact: true }).click();
  await http.getByText(/"reply": "smoke body text"/u).waitFor();
  await capture(page, `${prefix}-row-open`);
  await http.getByRole("tab", { name: logs.tabs.json, exact: true }).click();
  await http.getByText(/"trace_id": "tr_smoke_1"/u).waitFor();
  const upload = row(page, "Smoke upload");
  await upload.getByRole("button", { expanded: false }).click();
  await upload.getByText(logs.bodyUnavailable, { exact: true }).waitFor();
}

/** Live rows: at the top they join the list; scrolled away they wait behind 새 줄 N개. */
async function liveChecks(page: Page, server: NativeAppServerHandle) {
  const viewer = section(page, "logs-viewer");
  await viewer.getByRole("switch", { name: logs.live, exact: true }).click();
  await page.waitForTimeout(500);
  const before = await rows(page).count();
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  await page.waitForFunction(([selector, count]) => document.querySelectorAll(selector as string).length > (count as number),
    ['[data-settings-section-id="logs-viewer"] [data-test-class="log-row"]', before] as const);
  await rows(page).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const scrolled = await rows(page).count();
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  const pending = page.locator('[data-test-class="logs-new-lines"]');
  await pending.waitFor();
  assert.match(await pending.innerText(), /^새 줄 \d+개$/u);
  assert.equal(await rows(page).count(), scrolled, "the list keeps its rows while scrolled away");
  await pending.click();
  await pending.waitFor({ state: "hidden" });
  assert(await rows(page).count() > scrolled, "새 줄 adds the waiting rows");
  await viewer.getByRole("switch", { name: logs.live, exact: true }).click();
}

async function storageChecks(page: Page) {
  const storage = section(page, "logs-storage");
  await storage.getByText(logs.stores.main, { exact: true }).waitFor();
  for (const store of [logs.stores.app, logs.stores.debug, logs.stores.bodies]) await storage.getByText(store, { exact: true }).waitFor();
  assert.equal(await storage.getByRole("progressbar").count(), 4, "앱, 에이전트, 자세히, 본문");
  await storage.getByRole("button", { name: logs.exportMenu, exact: true }).click();
  const dialog = page.locator('[data-test-class="logs-export-dialog"]');
  await dialog.getByRole("switch", { name: logs.includeBodies, exact: true }).click();
  await capture(page, "1280-light-export-dialog");
  await expectZipDownload(page, () => dialog.getByRole("button", { name: logs.exportAction, exact: true }).click());
  await dialog.waitFor({ state: "hidden" });
  await storage.getByRole("button", { name: logs.clearMenu, exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: logs.clearTitle, exact: true });
  await confirm.getByRole("button", { name: copy.common.delete, exact: true }).click();
  await page.locator("[data-sonner-toast]").filter({ hasText: /비웠습니다/u }).first().waitFor();
}

async function emptyCheck(page: Page) {
  const viewer = section(page, "logs-viewer");
  await viewer.getByRole("searchbox", { name: logs.search }).fill("zz-no-such-log-line");
  await viewer.getByText(logs.empty, { exact: true }).waitFor();
  await viewer.getByRole("searchbox", { name: logs.search }).fill("");
  await rows(page).first().waitFor();
}

async function focusChecks(page: Page) {
  await section(page, "logs-level").getByRole("radio", { name: logs.levels.standard, exact: true }).focus();
  const audit = await auditTabOrder(page, { maxStops: 24, within: '[data-settings-section-id^="logs-"]' });
  assert(audit.stops > 5, `focus reaches the log controls (${audit.visited.join(", ")})`);
  assert.equal(audit.clipped.length, 0, `log focus rings are whole\n${formatClips(audit.clipped)}`);
  assert.deepEqual(audit.unmarked, [], "every log stop shows a focus ring");
}

async function runCase(cell: string) {
  const [widthText, theme] = cell.split("-") as [string, "light" | "dark"];
  const width = Number(widthText);
  const functional = cell === "1280-light";
  const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
  const browser = await launchSmokeBrowser();
  try {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    const off = await newPage(browser, server, width, theme);
    await developerOffChecks(off.page, `${cell}-developer-off`);
    assert.deepEqual(off.errors, [], "no renderer errors (developer mode off)");
    await off.close();
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ diagnostics_enabled: true }) });
    const { page, errors, close } = await newPage(browser, server, width, theme);
    await openSettings(page, copy.settings.sections.logs);
    await rows(page).first().waitFor();
    const ids = await page.locator("[data-settings-section-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-settings-section-id")));
    assert.deepEqual(ids, ["logs-level", "logs-viewer", "logs-storage", "developer-context-estimates"]);
    await capture(page, `${cell}-logs`);
    await section(page, "logs-storage").getByRole("progressbar").first().waitFor();
    await section(page, "logs-storage").scrollIntoViewIfNeeded();
    await capture(page, `${cell}-storage`);
    await rowChecks(page, cell);
    if (functional) {
      await levelChecks(page, cell);
      await liveChecks(page, server);
      await emptyCheck(page);
      await focusChecks(page);
      await storageChecks(page);
    }
    assert.deepEqual(errors, [], "no renderer errors (developer mode on)");
    await close();
    assert.equal(server.stubModelCalls.length, 0, "logs need no model calls");
  } finally {
    await browser.close();
    await server.stop();
  }
}

const selectedCases = selected ? [selected] : cases;
for (const cell of selectedCases) await runCase(cell);
writeFileSync(resolve(shots, `manifest-${selected ?? "all"}.json`), `${JSON.stringify({ cases: selectedCases, modelCalls: 0 }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, cases: selectedCases }));
