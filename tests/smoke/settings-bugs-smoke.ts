// Public UI -> isolated native gateway, with injected transport failures only.
// UI smoke coverage for #218–#221; all model providers are stubbed.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { createNativeAppServer } from "../support/native-app-server";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";

let copy = getAppCopy("ko-KR");
const screenshots = resolve(".tmp/settings-bugs");
mkdirSync(screenshots, { recursive: true });
const matrix = [[375, "light", "ko"], [375, "dark", "ko"], [1280, "light", "ko"], [1280, "dark", "ko"], [1280, "light", "en"]] as const;
// As in the crash smoke, each matrix group owns its gateway and driver process.
// Restricted Chromium must not accumulate closed CDP surfaces in one Bun loop.
if (!process.argv.includes("--case")) {
  const captured: string[] = [];
  for (let index = 0; index <= matrix.length; index += 1) {
    await runIsolatedCase(index);
    const result = JSON.parse(readFileSync(resolve(screenshots, `manifest-${index}.json`), "utf8"));
    assert.equal(result.cases, 1);
    assert.equal(result.modelCalls, 0);
    captured.push(...result.screenshots);
  }
  writeFileSync(resolve(screenshots, "manifest.json"), `${JSON.stringify({ screenshots: captured, cases: 6, modelCalls: 0 }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, cases: 6, screenshots: captured.length, modelCalls: 0 }));
  process.exit(0);
}
const caseIndex = Number(process.argv[process.argv.indexOf("--case") + 1]);
assert(Number.isInteger(caseIndex) && caseIndex >= 0 && caseIndex <= matrix.length);

async function runIsolatedCase(index: number) {
  const isolation = mkdtempSync(join(tmpdir(), "butler-settings-case-"));
  mkdirSync(join(isolation, "home")); mkdirSync(join(isolation, "data"));
  try {
    const child = spawn(process.execPath, [import.meta.path, "--case", String(index)], {
      env: { ...process.env, HOME: join(isolation, "home"), BUTLER_DATA: join(isolation, "data") }, stdio: "inherit",
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    assert.equal(code, 0, `settings case ${index} failed`);
  } finally { rmSync(isolation, { recursive: true, force: true }); }
}
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const evidence: string[] = [];
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);
const toast = (page: Page) => page.locator('[data-sonner-toast][data-type="error"]').last();

async function capture(page: Page, prefix: string, state: string) {
  await page.bringToFront();
  assert.equal(await page.evaluate(() => document.hidden), false, `${state}: capture page is visible`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${state}: no page overflow`);
  const name = `${prefix}-${state}.png`;
  console.log(`capture ${name}`);
  await page.screenshot({ path: resolve(screenshots, name), animations: "allow", timeout: 10_000 });
  // Sonner deliberately pauses expiry on hover; leave the toast region after capture.
  await page.mouse.move(0, 0);
  evidence.push(name);
}

async function search(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(query);
  return dialog;
}

async function openSection(page: Page, query: string, label: string) {
  const dialog = await search(page, query);
  await dialog.getByRole("option").filter({ hasText: label }).click();
}

async function paletteChecks(page: Page, prefix: string) {
  for (const [query, id] of [[copy.settings.sections.models, "models"], ["models", "models"], [copy.settings.sections.skills, "skills"], ["mcp", "mcp"]] as const) {
    const dialog = await search(page, query);
    const result = dialog.getByRole("option").filter({ has: page.getByText(copy.settings.sections[id], { exact: true }) });
    await result.waitFor();
    await dialog.getByText(copy.commandPalette.loading, { exact: true }).waitFor({ state: "hidden" });
    if (query === "models") {
      const titles = (await dialog.getByRole("option").allTextContents())
        .flatMap((text) => text.match(/models regression \d+/u)?.[0] ?? []);
      assert.equal(await dialog.getByRole("option").count(), 31, "30 server chats plus localized Models; no consumed server slots");
      assert.deepEqual(new Set(titles), new Set(Array.from({ length: 30 }, (_, index) => `models regression ${index}`)));
    }
    await capture(page, prefix, `palette-${query}`);
    await result.click();
    await page.locator('[data-test-class~="settings-detail-title"]').filter({ hasText: copy.settings.sections[id] }).waitFor();
    await page.getByRole("button", { name: copy.settings.back, exact: true }).click();
  }
  for (const query of [copy.settings.sectionDescriptions.skills, copy.settings.sectionAliases.skills[0]!]) {
    const dialog = await search(page, query);
    await dialog.getByRole("option").filter({ hasText: copy.settings.sections.skills }).waitFor();
    await page.keyboard.press("Escape");
  }
  let dialog = await search(page, "");
  // #537: merged main declares fifteen sections, including Hooks and Server. Assert every entry.
  const expectedSections = ["general", "appearance", "personalization", "memory", "models", "updates", "usage", "security", "system", "archives", "about", "mcp", "hooks", "skills", "server"] as const;
  assert.equal(await dialog.getByRole("option").filter({ hasText: copy.commandPalette.kindLabels.settings }).count(), expectedSections.length);
  for (const id of expectedSections) assert.equal(await dialog.getByRole("option").filter({ has: page.getByText(copy.settings.sections[id], { exact: true }) }).count(), 1);
  await capture(page, prefix, "palette-all-sections");
  await dialog.getByRole("combobox").fill("logs");
  await page.getByText(copy.commandPalette.empty, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("option").count(), 0, "logs hidden outside developer mode");
  await page.keyboard.press("Escape");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ diagnostics_enabled: true }) });
  await page.route("**/app-info", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    (payload.data ?? payload).developer_mode_enabled = true;
    await route.fulfill({ response, json: payload });
  });
  await page.reload();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  dialog = await search(page, "logs");
  await dialog.getByRole("option").filter({ hasText: copy.settings.sections.logs }).waitFor();
  await capture(page, prefix, "palette-developer-logs");
  await page.keyboard.press("Escape");
  await page.unroute("**/app-info");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ diagnostics_enabled: false }) });
  await page.reload();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
}

async function skillChecks(page: Page, prefix: string) {
  await openSection(page, copy.settings.sections.skills, copy.settings.sections.skills);
  await page.getByRole("button", { name: copy.settings.actions.importSkill, exact: true }).click();
  let imports = 0;
  page.on("request", (request) => { if (request.url().includes("/skills/import")) imports += 1; });
  const file = { name: "invalid.zip", mimeType: "application/zip", buffer: Buffer.from("invalid zip") };
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByText(copy.settings.skillErrors.invalid, { exact: true }).waitFor();
  await capture(page, prefix, "skill-import-error");
  assert.equal(await page.locator('input[type="file"]').inputValue(), "", "file input cleared for retry");
  await page.getByRole("button", { name: copy.settings.actions.importSkill, exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="file"]')?.value === "");
  assert.equal(imports, 2, "same file imports twice");
  assert.equal(await toast(page).count(), 0, "skill failure is inline");
  await page.getByRole("button", { name: copy.settings.back, exact: true }).click();
}

async function formChecks(page: Page, prefix: string) {
  await page.getByRole("button", { name: copy.settings.actions.addMcpServer, exact: true }).click();
  const form = section(page, "mcp-server-form");
  const save = form.getByRole("button", { name: copy.common.save, exact: true });
  assert.equal(await save.isDisabled(), true);
  await capture(page, prefix, "mcp-id-required");
  await page.locator("#mcp-server-id").fill("깃허브");
  assert.equal(await save.isDisabled(), true);
  await capture(page, prefix, "mcp-id-invalid");
  await page.locator("#mcp-server-id").fill("GitHub");
  await page.locator("#mcp-server-name").fill("입력을 유지합니다");
  await page.getByText(copy.settings.mcpIdPreview("github"), { exact: true }).waitFor();
  await capture(page, prefix, "mcp-id-preview");
  // Hold the request to prove pending controls, then reach the real gateway.
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route("**/mcp-servers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });
  await save.click();
  assert.equal(await save.isDisabled(), true);
  await capture(page, prefix, "mcp-save-pending");
  release();
  await form.getByText(copy.settings.mcpCommandRequired, { exact: true }).waitFor();
  await page.unroute("**/mcp-servers");
  assert.equal(await page.locator("#mcp-server-name").inputValue(), "입력을 유지합니다");
  assert.equal(await page.locator("#mcp-server-id").inputValue(), "GitHub");
  await capture(page, prefix, "mcp-save-error-retained");
  await form.getByRole("button", { name: copy.common.cancel, exact: true }).click();
  assert.equal(await toast(page).count(), 0, "MCP field error has no toast");
}

async function mcpChecks(page: Page, prefix: string) {
  await openSection(page, "mcp", copy.settings.sections.mcp);
  const list = section(page, "mcp-servers");
  const toggle = list.getByRole("switch");
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), true);
  await list.getByText(copy.settings.mcpEnabled, { exact: true }).waitFor();
  assert.equal(await list.getByText(copy.settings.actions.disableMcpServer, { exact: true }).count(), 0);
  await capture(page, prefix, "mcp-enabled");
  await toggle.click();
  await list.getByText(copy.settings.mcpDisabled, { exact: true }).waitFor();
  assert.equal(await toggle.isChecked(), false);
  await capture(page, prefix, "mcp-disabled");
  await toggle.click();
  await list.getByText(copy.settings.mcpEnabled, { exact: true }).waitFor();
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  await page.route("**/mcp-servers/settings-smoke", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.fulfill({ status: 503, json: { error: { message: "Transport unavailable" } } });
  });
  await toggle.click();
  assert.equal(await toggle.isDisabled(), true);
  await capture(page, prefix, "mcp-toggle-pending");
  release();
  await toast(page).waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled === false);
  assert.equal(await toggle.isChecked(), true, "failed toggle retains persisted state");
  await capture(page, prefix, "mcp-toggle-error");
  await page.unroute("**/mcp-servers/settings-smoke");
  await toast(page).waitFor({ state: "hidden" });
  await page.route("**/mcp-servers/settings-smoke/probe", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "Probe unavailable" } } }));
  await list.getByRole("button", { name: copy.settings.actions.testMcpServer }).click();
  await toast(page).waitFor();
  await capture(page, prefix, "mcp-probe-error");
  await page.unroute("**/mcp-servers/settings-smoke/probe");
  await toast(page).waitFor({ state: "hidden" });
  await formChecks(page, prefix);
  let deletes = 0;
  page.on("request", (request) => { if (request.method() === "DELETE" && request.url().includes("/mcp-servers/")) deletes += 1; });
  await list.getByRole("button", { name: copy.settings.actions.deleteMcpServer }).click();
  const confirm = page.getByRole("alertdialog", { name: copy.common.delete, exact: true });
  await confirm.getByText(copy.settings.deleteMcpServer("검증 서버"), { exact: true }).waitFor();
  await capture(page, prefix, "mcp-delete-confirm");
  assert.equal(deletes, 0, "opening confirmation sends no DELETE");
  await confirm.getByRole("button", { name: copy.common.cancel, exact: true }).click();
  assert.equal(deletes, 0, "cancel sends no DELETE");
  await page.route("**/mcp-servers/settings-smoke", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 503, json: { error: { message: "Delete unavailable" } } })
      : route.continue());
  await list.getByRole("button", { name: copy.settings.actions.deleteMcpServer }).click();
  await confirm.getByRole("button", { name: copy.common.delete, exact: true }).click();
  await toast(page).waitFor();
  assert.equal(await list.getByRole("switch").count(), 1, "failed delete keeps the row");
  await capture(page, prefix, "mcp-delete-error");
  await page.unroute("**/mcp-servers/settings-smoke");
  await toast(page).waitFor({ state: "hidden" });
  await list.getByRole("button", { name: copy.settings.actions.deleteMcpServer }).click();
  await confirm.getByRole("button", { name: copy.common.delete, exact: true }).click();
  await list.getByText(copy.interfaceDetails.noMcp, { exact: true }).waitFor();
  assert.equal(deletes, 2, "each confirmed action sends exactly one DELETE (one injected failure, one success)");
  await page.getByRole("button", { name: copy.settings.back, exact: true }).click();
}

async function scheduleChecks(page: Page, prefix: string) {
  const dialog = await search(page, "삭제 검증");
  await dialog.getByRole("option").filter({ hasText: "삭제 검증" }).click();
  const detail = page.locator('[data-test-class~="automation-detail-view"]');
  await detail.waitFor();
  let deletes = 0;
  page.on("request", (request) => { if (request.method() === "DELETE" && request.url().includes("/automations/")) deletes += 1; });
  await detail.getByRole("button", { name: copy.common.more, exact: true }).click();
  await page.getByRole("menuitem", { name: copy.common.delete, exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: copy.common.delete, exact: true });
  await confirm.getByText(copy.settings.deleteSchedule("삭제 검증"), { exact: true }).waitFor();
  await capture(page, prefix, "schedule-delete-confirm");
  assert.equal(deletes, 0);
  await page.keyboard.press("Escape");
  assert.equal(deletes, 0, "dismissal sends no DELETE");
  await detail.getByRole("button", { name: copy.common.more, exact: true }).click();
  await page.getByRole("menuitem", { name: copy.common.delete, exact: true }).click();
  await confirm.getByRole("button", { name: copy.common.delete, exact: true }).click();
  await detail.waitFor({ state: "hidden" });
  assert.equal(deletes, 1, "confirmation deletes once");
}

async function runCase(width: number, theme: "light" | "dark", language: "ko" | "en" = "ko") {
  copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
  await server.api("/mcp-servers", { method: "POST", body: JSON.stringify({ id: "settings-smoke", display_name: "검증 서버", enabled: true, transport: "stdio", command: "false" }) });
  await server.api("/automations", { method: "POST", body: JSON.stringify({ title: "삭제 검증", prompt_body: "stub only", target_session_id: "general", interval_seconds: 86400 }) });
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: language === "ko" ? "ko-KR" : "en-US", colorScheme: theme });
  await server.signIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  const prefix = `${width}-${language}-${theme}`;
  try {
    await paletteChecks(page, prefix);
    await skillChecks(page, prefix);
    await mcpChecks(page, prefix);
    await scheduleChecks(page, prefix);
    assert.deepEqual(errors, [], "no unhandled renderer errors");
  } catch (error) {
    const visibility = !page.isClosed() ? await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() })).catch(() => null) : null;
    console.error(JSON.stringify({ case: prefix, url: page.url(), closed: page.isClosed(), visibility, rendererErrors: errors }));
    if (!page.isClosed()) await page.screenshot({ path: resolve(screenshots, `${prefix}-failure.png`), animations: "allow", timeout: 10_000 }).catch(() => undefined);
    throw error;
  } finally { await context.close(); }
}

async function englishChecks() {
  const en = getAppCopy("en-US");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  await server.api("/mcp-servers", { method: "POST", body: JSON.stringify({ id: "english-smoke", display_name: "Review server", enabled: false, transport: "stdio", command: "false" }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await server.signIn(context);
  const page = await context.newPage();
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: en.commandPalette.label });
  await palette.getByRole("combobox").fill("mcp");
  await palette.getByRole("option").filter({ hasText: en.settings.sections.mcp }).click();
  const list = section(page, "mcp-servers");
  await list.getByText(en.settings.mcpDisabled, { exact: true }).waitFor();
  assert.equal(await list.getByRole("switch", { name: "Review server: Enable" }).isChecked(), false);
  await page.getByRole("button", { name: en.settings.actions.addMcpServer, exact: true }).click();
  const form = section(page, "mcp-server-form");
  await form.getByText(en.settings.mcpIdRequired, { exact: true }).waitFor();
  assert.equal(await form.getByRole("button", { name: en.common.save }).isDisabled(), true);
  await form.getByRole("button", { name: en.common.cancel }).click();
  await list.getByRole("button", { name: en.settings.actions.deleteMcpServer }).click();
  const confirm = page.getByRole("alertdialog", { name: en.common.delete, exact: true });
  await confirm.getByText(en.settings.deleteMcpServer("Review server"), { exact: true }).waitFor();
  await confirm.getByRole("button", { name: en.common.cancel }).click();
  assert.equal(await list.getByRole("switch").count(), 1);
  await list.getByRole("button", { name: en.settings.actions.deleteMcpServer }).click();
  await confirm.getByRole("button", { name: en.common.delete, exact: true }).click();
  await list.getByText(en.interfaceDetails.noMcp, { exact: true }).waitFor();
  await context.close();
}

try {
  for (let index = 0; index < 30; index += 1) {
    await server.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: `models regression ${index}` }) });
  }
  const cell = matrix[caseIndex];
  if (cell) await runCase(cell[0], cell[1], cell[2]);
  else await englishChecks();
  assert.equal(server.stubModelCalls.length, 0, "settings need no model calls");
  writeFileSync(resolve(screenshots, `manifest-${caseIndex}.json`), `${JSON.stringify({ screenshots: evidence, cases: 1, modelCalls: 0 }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, cases: 1, screenshots: evidence.length, modelCalls: 0 }));
} finally {
  await browser.close();
  await server.stop();
}
