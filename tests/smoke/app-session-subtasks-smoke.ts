// Stub/replay UI smoke through the real native App, isolated from the owner's data:
// unfinished subtasks in 세션 정보 and nested in the sidebar tree, resume, the
// observer, the attention dot, finished subtasks leaving, and the inset hover fill.
// BUTLER_SMOKE_BASELINE=1 (a main build) captures only the screens both builds share.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";
import { COPY, hoverInset, installSubtaskPage, replaySubtasks, subtaskFixtures, densityDeltas, markDeltas, titleDeltas, type SubtaskReplay } from "../support/session-subtasks-fixtures.ts";
import { SESSION_INFO_COPY } from "../../packages/butler-i18n/src/locales/session-info.ts";
import type { EpicDetail } from "../../packages/butler-app/client/shared/canon-contracts.ts";

const cells = ["light-ko", "dark-ko", "light-en", "dark-en"];
if (await runSmokeCases(cells, "BUTLER_SUBTASKS_CELL", import.meta.path, { isolate: true })) process.exit(0);
const [theme, lang] = (process.env.BUTLER_SUBTASKS_CELL ?? "light-ko").split("-") as ["light" | "dark", "ko" | "en"];
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? join(tmpdir(), "butler-subtasks-shots"));
mkdirSync(shots, { recursive: true });
const copy = SESSION_INFO_COPY[lang === "ko" ? "ko-KR" : "en-US"];
const text = lang === "ko"
  ? { working: "작업 중", resume: "이어서 진행", attention: "확인 필요", ask: COPY.ko.ask, showSidebar: "사이드바 보기" }
  : { working: "Working", resume: "Resume", attention: "Needs attention", ask: COPY.en.ask, showSidebar: "Show sidebar" };
const name = (shot: string) => join(shots, `${baseline ? "main-" : ""}${shot}-${theme}-${lang}.png`);
const aside = (page: Page) => page.getByRole("complementary", { name: copy.title, exact: true });
const sidebar = (page: Page) => page.locator('[data-test-class="app-sidebar"]');
async function shot(locator: Locator | Page, file: string) {
  await locator.screenshot({ path: name(file), animations: "disabled", caret: "hide" });
}

const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const results: Record<string, unknown> = { theme, lang, baseline };
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: lang, appearance_theme: theme, reduce_motion: true,
    wallpaper: { source: { kind: "none" } } }) });
  const epicSession = await linkedEpicSession(server);
  await chat(server, COPY[lang].other);
  const parentId = await chat(server, COPY[lang].parent);
  await unchangedScreens(epicSession, parentId);
  if (!baseline) await subtaskScreens(parentId);
  assert.deepEqual(errors, [], "no page errors");
  console.log(JSON.stringify({ ok: true, ...results }));
} catch (error) {
  const pages = browser.contexts().flatMap(context => context.pages());
  for (const [index, page] of pages.entries()) await page.screenshot({ path: name(`failure-${index}`) }).catch(() => undefined);
  throw error;
} finally {
  await browser.close();
  await server.stop();
}

async function chat(server: NativeAppServerHandle, title: string): Promise<string> {
  return (await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) })).session.id;
}

/** A canon task conversation: its panel has no subtasks and the same inline-edit rows on both builds. */
async function linkedEpicSession(server: NativeAppServerHandle): Promise<string> {
  const { project } = await server.api<{ project: { id: string } }>("/projects", { method: "POST", body: JSON.stringify({ source: "scratch", display_name: "Butler" }) });
  const plan = await server.api<{ id: string }>(`/projects/${project.id}/canon/plans`, { method: "POST", body: JSON.stringify({ title: "Preview 14" }) });
  const epic = await server.api<EpicDetail>(`/projects/${project.id}/canon/epics`, { method: "POST", body: JSON.stringify({ title: "Release notes", description: "Collect the changes.", assignee: "app-user", plan_id: plan.id }) });
  const linked = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
  return linked.session_id;
}

async function openPage(active: string, replay: SubtaskReplay, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  await installSubtaskPage(page, active);
  await replaySubtasks(page, replay, new URL(server.url).origin);
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class~="conversation"]').waitFor();
  if (width >= 1024) await page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Sidebar and panel without subtasks, plus the canon inline-edit hover: compared against main. */
async function unchangedScreens(epicSession: string, parentId: string) {
  const page = await openPage(epicSession, { parentId, lang, subtasks: [], asksOn: false, resumed: [] });
  assert.equal(await page.locator('[data-test-class="subtask-lines"]').count(), 0);
  await shot(sidebar(page), "none-sidebar");
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await aside(page).locator('[data-test-class="canon-epic-detail"]').waitFor();
  assert.equal(await aside(page).locator('[data-session-section="subtasks"]').count(), 0, "no section without subtasks");
  await page.mouse.move(0, 0);
  await shot(aside(page), "none-panel");
  const field = aside(page).locator('[data-test-class="canon-epic-detail"] [data-slot="clickable"]').first();
  results.canonHoverInset = await hoverInset(field);
  await shot(aside(page).locator('[data-session-section="task"]'), "hover-canon");
  await page.close();
}

async function subtaskScreens(parentId: string) {
  const replay: SubtaskReplay = { parentId, lang, subtasks: subtaskFixtures(lang), asksOn: false, resumed: [] };
  let page = await openPage(parentId, replay);
  const toggle = page.locator('[data-test-class="session-info-toggle"]');
  // The approval reaches the dot through the subtask alone.
  await toggle.locator('[data-slot="icon-button-indicator"]').waitFor();
  await page.close();
  replay.asksOn = true;
  page = await openPage(parentId, replay);
  await verifyPanel(page);
  await verifySidebar(page);
  await shot(page.locator('[data-test-class~="composer-wrap"]').first(), "composer");
  assert.equal(await page.locator('[data-test-class="steward-composer-capsules"]').count(), 0, "the composer has no subtask capsules");
  await verifyResumeAndObserver(page, replay);
  await verifyFinished(page, replay);
  await page.close();
  replay.subtasks = subtaskFixtures(lang);
  page = await openPage(parentId, replay, 390, 844);
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await aside(page).locator('[data-session-section="subtasks"]').waitFor();
  assert.equal(await aside(page).getAttribute("data-layout"), "floating");
  await page.mouse.move(0, 0);
  await shot(page, "info-phone");
  results.phoneHoverInset = await hoverInset(aside(page).locator('[data-test-class="subtask-row"]').first());
  await page.locator('[data-test-class="session-info-toggle"]').click();
  await page.getByRole("button", { name: text.showSidebar, exact: true }).first().click();
  await sidebar(page).locator('[data-test-class="subtask-line"]').first().waitFor();
  await verifyMarkColumn(page, "390");
  await page.close();
}

/**
 * Every child mark (working, alert, resume) centres on the parent spinner, ±0.5px, at the app's
 * sidebar density. The guide line centres on the parent icon and child titles start at the
 * parent title at every DS density (the shell's density switched in place).
 */
async function verifyMarkColumn(page: Page, width: string) {
  const deltas = await markDeltas(sidebar(page));
  results[`markDeltas${width}`] = deltas;
  assert.deepEqual(Object.keys(deltas).sort(), ["attention", "progress", "resume"], "every state has a mark");
  const densities = await densityDeltas(sidebar(page));
  results[`densityDeltas${width}`] = densities;
  for (const [mark, delta] of Object.entries(deltas)) {
    assert(Math.abs(delta) <= 0.5, `${mark} centres on the parent spinner at ${width}: ${delta}px`);
  }
  for (const [density, { line, title }] of Object.entries(densities)) {
    assert(Math.abs(line) <= 0.5, `guide line centres on the parent icon at ${width} ${density}: ${line}px`);
    assert(Math.abs(title) <= 0.5, `child title starts at the parent title at ${width} ${density}: ${title}px`);
  }
}

async function verifyPanel(page: Page) {
  await page.locator('[data-test-class="session-info-toggle"]').click();
  const section = aside(page).locator('[data-session-section="subtasks"]');
  await section.waitFor();
  assert.equal(await aside(page).getAttribute("data-layout"), "docked");
  const ids = await aside(page).locator("[data-session-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-session-section")));
  assert.deepEqual(ids.slice(0, 2), ["asks", "subtasks"], "subtasks sit right after the asks");
  await section.getByText(copy.subtasks, { exact: true }).waitFor();
  const rows = section.locator('[data-test-class="subtask-row"]');
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-subtask-state"))), ["working", "paused", "needs_approval"]);
  await rows.nth(0).getByText(text.working, { exact: true }).waitFor();
  await rows.nth(0).getByText("3/5", { exact: true }).waitFor();
  await rows.nth(1).getByText(copy.subtaskPaused, { exact: true }).waitFor();
  await rows.nth(1).getByRole("button", { name: text.resume, exact: true }).waitFor();
  await rows.nth(2).getByText(copy.subtaskNeedsApproval, { exact: true }).waitFor();
  await rows.nth(2).locator('[data-test-class="subtask-attention"]').waitFor();
  // The gateway lists the subtask's approval as an owner ask as well (PA-03); both surfaces show it.
  await aside(page).locator('[data-session-section="asks"]').getByText(text.ask, { exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await shot(page, "info-docked");
  await shot(aside(page), "info-docked-panel");
  results.subtaskHoverInset = await hoverInset(rows.nth(0));
  const inset = results.subtaskHoverInset as { left: number; right: number };
  assert(inset.left >= 4 && inset.right >= 4, `hover fill stays inside the card: ${JSON.stringify(inset)}`);
  await shot(section, "hover-subtask");
  await rows.nth(2).hover();
  const truncated = await rows.nth(2).locator('[data-test-class="subtask-title"]').evaluate(node => node.scrollWidth > node.clientWidth);
  if (truncated) await page.getByRole("tooltip").getByText(subtaskFixtures(lang)[2]!.title, { exact: true }).waitFor();
  results.longTitleTruncated = truncated;
  await shot(section, "hover-long");
}

async function verifySidebar(page: Page) {
  const tree = sidebar(page);
  await tree.locator('[data-test-class="subtask-line"]').first().waitFor();
  assert.equal(await tree.locator('[data-test-class="subtask-line"]').count(), 3);
  const deltas = await titleDeltas(tree);
  results.titleDeltas = deltas;
  assert.deepEqual(deltas, [0, 0, 0], "subtask titles start where the parent title starts");
  await verifyMarkColumn(page, "1440");
  const parentRow = tree.locator('[data-test-class="subtask-lines"]').locator("xpath=preceding-sibling::*[1]");
  await parentRow.locator('[data-slot="spinner"]').waitFor();
  assert.equal(await parentRow.getByLabel(text.attention, { exact: true }).count(), 0, "the alert rests on the subtask line, not twice");
  await tree.locator('[data-test-class="subtask-line"]').nth(2).locator('[data-test-class="subtask-attention"]').waitFor();
  await tree.locator('[data-test-class="subtask-line"]').nth(0).getByText("3/5", { exact: true }).waitFor();
  await tree.locator('[data-test-class="subtask-line"]').nth(1).getByRole("button", { name: text.resume, exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await shot(tree, "sidebar-nesting");
}

async function verifyResumeAndObserver(page: Page, replay: SubtaskReplay) {
  const rows = aside(page).locator('[data-test-class="subtask-row"]');
  await rows.nth(1).getByRole("button", { name: text.resume, exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-test-class="subtask-row"][data-subtask-state="working"]').length === 2);
  assert.deepEqual(replay.resumed, [{ relation: "relation-paused", parent: replay.parentId }], "resume names the subtask and its parent");
  assert.equal(await page.locator('[data-test-class="steward-observer-dialog"]').count(), 0, "resume does not open the observer");
  await rows.nth(0).click();
  await page.locator('[data-test-class="steward-observer-dialog"]').waitFor();
  await page.keyboard.press("Escape");
  await page.locator('[data-test-class="steward-observer-dialog"]').waitFor({ state: "detached" });
  await sidebar(page).locator('[data-test-class="subtask-line"]').nth(2).click();
  await page.locator('[data-test-class="steward-observer-dialog"]').waitFor();
  await page.keyboard.press("Escape");
}

async function verifyFinished(page: Page, replay: SubtaskReplay) {
  replay.subtasks = [];
  await page.evaluate(parent => {
    const emit = (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent;
    emit({ id: 200, type: "subsession.changed", payload: { session_id: parent, child_session_id: "steward-subtask-working" } });
    emit({ id: 201, type: "pending_asks.changed", payload: { session_id: parent, ask_id: "approval:subtask", kind: "approval", state: "allowed", open_count: 0 } });
  }, replay.parentId);
  await aside(page).locator('[data-session-section="subtasks"]').waitFor({ state: "detached" });
  await sidebar(page).locator('[data-test-class="subtask-lines"]').waitFor({ state: "detached" });
  assert.equal(await page.locator('[data-test-class="session-info-toggle"] [data-slot="icon-button-indicator"]').count(), 0, "the dot clears");
}
