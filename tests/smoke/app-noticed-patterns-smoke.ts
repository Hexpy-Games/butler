// test-category: race
// Product renderer -> isolated native gateway; patterns use the durable storage format.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { installSmokeUiAssets } from "../support/smoke-ui-assets";
import { installMemoryDesktopBridge } from "../support/memory-desktop-bridge";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const output = process.env.BUTLER_SMOKE_EVIDENCE ?? mkdtempSync(join(tmpdir(), "butler-noticed-patterns-"));
process.env.BUTLER_SMOKE_EVIDENCE = output;
mkdirSync(output, { recursive: true });
const matrix = ["ko-light-1280", "ko-dark-1280", "ko-light-375", "ko-dark-375", "en-light-1280", "en-dark-1280", "en-light-375", "en-dark-375"];
if (await runSmokeCases(matrix, "BUTLER_PATTERNS_CELL", import.meta.path, { isolate: true })) process.exit(0);
const cell = process.env.BUTLER_PATTERNS_CELL!;
const [language, theme, size] = cell.split("-") as ["ko" | "en", "light" | "dark", string];
const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
const data = process.env.BUTLER_DATA;
assert(data, "smoke needs isolated BUTLER_DATA");
seedPatterns(data);
const server = await createNativeAppServer({ butlerData: data, uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
  // Fail clearly if the supplied executable predates S3. No endpoint responses are faked.
  const initial = await server.api<{ revision: number; patterns: { id: string }[] }>("/memory/patterns");
  assert.equal(initial.patterns.length, 3);
  if (process.env.BUTLER_SMOKE_BASELINE_UI_ROOT) await captureBaseline(process.env.BUTLER_SMOKE_BASELINE_UI_ROOT);
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profiling: { mode: "basic" } }) });
  const context = await browser.newContext({ viewport: { width: Number(size), height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  await server.signIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.url}?settings=memory`);
  const section = page.locator('[data-settings-section-id="noticed-patterns"]');
  await section.locator('[data-test-class="pattern-row"]').nth(2).waitFor();
  assert.equal(await section.locator('[data-test-class="pattern-row"]').count(), 3);
  for (const text of [copy.settings.memory.patternDays(5), copy.settings.memory.patternWeeks(3), copy.settings.memory.patternMonths(3)])
    await section.getByText(`${text} · ${copy.settings.memory.patternCount(11)}`, { exact: true }).waitFor();
  await section.scrollIntoViewIfNeeded();
  await capture(page, "settings");
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profiling: { mode: "off" } }) });
  await page.reload();
  await section.locator('[data-test-class="pattern-row"]').nth(2).waitFor();
  await section.getByText(copy.settings.memory.profileBuildingOff, { exact: true }).waitFor();
  await section.scrollIntoViewIfNeeded();
  if (cell === "ko-light-1280") await capture(page, "settings-learning-off");
  const pickerRects = await section.locator('[data-slot="time-picker"]').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, width: rect.width };
  }));
  assert.equal(pickerRects.length, 2);
  assert(Math.abs(pickerRects[0].top - pickerRects[1].top) < 1, "quiet hours share one row");
  assert(pickerRects[0].right < pickerRects[1].left, "time fields have room for the dash");
  await installMemoryDesktopBridge(page, server);
  await checkControls(page, server);
  await checkDelete(page, server);
  if (language === "ko" && theme === "light" && size === "1280") {
    await checkConflict(page, server);
    while (await section.locator('[data-test-class="pattern-row"]').count()) await deleteFirst(page);
    await section.getByText(copy.settings.memory.patternsEmpty, { exact: true }).waitFor();
    await capture(page, "empty");
    assert.equal(await section.getByRole("radiogroup").count(), 1, "empty list keeps settings");
  }
  await checkIntro(page, server);
  assert.deepEqual(errors, []);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ result: "PASS", cell, patterns: 3, modelCalls: 0, evidence: output }));
} finally { await browser.close(); await server.stop(); }

async function captureBaseline(root: string) {
  const page = await browser.newPage({ viewport: { width: Number(size), height: 960 }, colorScheme: theme, reducedMotion: "reduce" });
  try {
    await server.signIn(page);
    await installSmokeUiAssets(page, root);
    await page.route("**/*", route => new URL(route.request().url()).pathname === "/"
      ? route.fulfill({ contentType: "text/html", body: readFileSync(join(root, "index.html"), "utf8") }) : route.fallback());
    await page.goto(`${server.url}?settings=memory`);
    const instructions = page.locator('[data-settings-section-id="instructions"]');
    await instructions.waitFor();
    await instructions.scrollIntoViewIfNeeded();
    await capture(page, "before-settings");
    if (language === "ko") {
      await page.goto(server.url);
      await openChats(page);
      await page.locator('[data-test-class~="composer-card"]').waitFor();
      assert.equal(await page.locator('[data-test-class="chats-intro"]').count(), 0);
      await capture(page, "before-intro");
    }
  } finally { await page.close(); }
}

async function openChats(page: Page) {
  const general = page.getByRole("button", { name: copy.space.general, exact: true });
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
  await show.or(page.getByRole("button", { name: copy.titlebar.hideLeftPanel, exact: true })).first().waitFor();
  if (await show.isVisible()) await show.click();
  await general.click();
}

function seedPatterns(directory: string) {
  const folder = join(directory, "cognition/patterns");
  mkdirSync(folder, { recursive: true });
  const now = new Date().toISOString();
  const patterns = [5, 21, 95].map((days, index) => ({
    id: `pat_${crypto.randomUUID()}`, title: ["아침 소식 확인", "주간 문서 정리", "월간 일정 검토"][index], intent: "정기적으로 확인하기",
    window: { days: ["mon", "tue", "wed", "thu", "fri"], start: "08:00", end: "09:00" },
    evidence: { count: 11, first_at: new Date(Date.now() - (days - 0.1) * 86_400_000).toISOString(), last_at: now },
    created_at: now, updated_at: now, proposed_at: null,
  }));
  writeFileSync(join(folder, "patterns.json"), JSON.stringify({ schema: "butler.cognition.patterns.v1", revision: 3, patterns, removed: [], bundles: [] }));
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no page overflow");
  await page.screenshot({ path: join(output, `${name}-${cell}.png`), animations: "disabled" });
}

async function checkControls(page: Page, host: NativeAppServerHandle) {
  for (const [value, label] of [["off", copy.settings.memory.proactiveOff], ["often", copy.settings.memory.proactiveOften]] as const) {
    const saved = page.waitForResponse(response => response.url().endsWith("/settings") && response.request().method() === "PATCH");
    await page.getByRole("radio", { name: label, exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal((await host.api<SettingsView>("/settings")).proactive_level, value);
    await page.waitForFunction(() => !document.querySelector('[role="radio"]:disabled'));
    // Quiet hours remain enabled even when consolidation proposals are off.
    assert.equal(await page.locator('[data-setting-id="quiet-hours"] [aria-disabled="true"]').count(), 0);
  }
  for (const [label, key, expected] of [[copy.settings.memory.quietHoursStart, "quiet_hours_start", "22:01"], [copy.settings.memory.quietHoursEnd, "quiet_hours_end", "07:01"]] as const) {
    const minute = page.getByRole("group", { name: label, exact: true }).locator('[data-segment="minute"]');
    const saved = page.waitForResponse(response => response.url().endsWith("/settings") && response.request().method() === "PATCH");
    await minute.press("ArrowUp");
    assert.equal((await saved).status(), 200);
    assert.equal((await host.api<SettingsView>("/settings"))[key], expected);
    await page.waitForFunction(() => !document.querySelector('[role="radio"]:disabled'));
  }
}

async function deleteFirst(page: Page) {
  const rows = page.locator('[data-test-class="pattern-row"]');
  const count = await rows.count();
  await rows.first().getByRole("button", { name: copy.common.delete, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: copy.settings.memory.deletePatternTitle, exact: true });
  const deleted = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/memory/patterns/"));
  await dialog.getByRole("button", { name: copy.common.delete, exact: true }).click();
  const response = await deleted;
  assert.equal(response.status(), 200);
  assert.equal(typeof response.request().postDataJSON().expected_revision, "number");
  await page.waitForFunction(count => document.querySelectorAll('[data-test-class="pattern-row"]').length === count - 1, count);
}

async function checkDelete(page: Page, host: NativeAppServerHandle) {
  const first = page.locator('[data-test-class="pattern-row"]').first();
  const title = await first.locator('[id^="pattern-text-"]').innerText();
  await first.getByRole("button", { name: copy.common.delete, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: copy.settings.memory.deletePatternTitle, exact: true });
  await dialog.getByText(title, { exact: true }).waitFor();
  await dialog.getByText(copy.settings.memory.deletePatternBody, { exact: true }).waitFor();
  if (cell === "ko-light-1280") await capture(page, "delete-confirm");
  await dialog.getByRole("button", { name: copy.common.cancel, exact: true }).click();
  assert.equal((await host.api<{ patterns: unknown[] }>("/memory/patterns")).patterns.length, 3, "cancel preserves patterns");
  await deleteFirst(page);
  assert.equal((await host.api<{ patterns: unknown[] }>("/memory/patterns")).patterns.length, 2);
  await page.waitForFunction(() => document.querySelector('[data-test-class="pattern-row"]')?.contains(document.activeElement));
}

async function checkConflict(page: Page, host: NativeAppServerHandle) {
  const rows = page.locator('[data-test-class="pattern-row"]');
  await rows.first().getByRole("button", { name: copy.common.delete, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: copy.settings.memory.deletePatternTitle, exact: true });
  await dialog.waitFor();
  const current = await host.api<{ revision: number; patterns: { id: string }[] }>("/memory/patterns");
  const last = current.patterns.at(-1)!;
  await host.api(`/memory/patterns/${last.id}`, { method: "DELETE", body: JSON.stringify({ expected_revision: current.revision }) });
  await page.locator(`[id="pattern-${last.id}"]`).waitFor({ state: "detached" });
  assert.equal(await rows.count(), 1, "memory event reloads the open list");
  const rejected = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/memory/patterns/"));
  await dialog.getByRole("button", { name: copy.common.delete, exact: true }).click();
  assert.equal((await rejected).status(), 409);
  await page.getByText(copy.settings.memory.deleteFailed, { exact: true }).waitFor();
  assert.equal(await rows.count(), 1, "conflict keeps the remaining pattern");
}

async function checkIntro(page: Page, host: NativeAppServerHandle) {
  await page.goto(host.url);
  const patches: unknown[] = [];
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().endsWith("/settings") && request.postDataJSON().chats_intro_seen) patches.push(request.postDataJSON());
  });
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/settings") && response.request().postDataJSON().chats_intro_seen);
  await openChats(page);
  const intro = page.locator('[data-test-class="chats-intro"]');
  await intro.waitFor();
  assert.equal(await intro.innerText(), copy.conversation.chatsIntro);
  assert.equal((await saved).status(), 200);
  assert.equal((await host.api<SettingsView>("/settings")).chats_intro_seen, true);
  assert.equal(await intro.count(), 1);
  assert.equal(await intro.locator("xpath=ancestor::article").locator('[data-test-class~="assistant-footer"]').count(), 0);
  const geometry = await intro.evaluate(node => {
    const bubble = node.closest('[data-test-class="assistant-bubble"]')!.getBoundingClientRect();
    const row = node.closest("article")!.getBoundingClientRect();
    return { width: bubble.width, left: bubble.left, maxWidth: Math.min(440, row.width * 0.68), rowLeft: row.left };
  });
  assert(geometry.width <= geometry.maxWidth + 0.5, "intro uses the Chats bubble width");
  assert(Math.abs(geometry.left - geometry.rowLeft) < 1, "intro aligns with Butler replies");
  if (language === "ko") await capture(page, "intro");
  assert.equal(patches.length, 1, "intro saves once");
  const view = await host.api<{ messages: unknown[] }>("/session-view?session_id=general");
  assert.equal(view.messages.length, 0, "intro is never a stored message");
  await page.reload();
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  assert.equal(await intro.count(), 0, "next app session respects the durable flag");
}
