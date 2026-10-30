// Real gateway and UI, usage rows seeded on disk: a chat's bars and rows show its subtask share, in the
// context popover and Settings › Usage; a chat without subtasks and an older response show no split.
import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import type { UsageMonitorView } from "../../packages/butler-app/client/ui/src/app/types";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { SOLO_CHAT, SPLIT_BAR, SPLIT_CHAT, startUsageSubtaskFixture } from "../support/usage-subtask-fixture";

const fixture = await startUsageSubtaskFixture(process.env.BUTLER_SMOKE_UI_ROOT);
const { server } = fixture;
const browser = await launchSmokeBrowser();
const errors: string[] = [];

/** Latest bar's hatched parts: each is its type's subtask share of the column, within 1px. */
async function assertLatestBarShare(chart: Locator, label: string) {
  const columns = await chart.evaluate(root => [...root.querySelectorAll<HTMLElement>("[data-usage-bars-column]")]
    .filter(column => column.dataset.zero !== "true").map(column => ({
      height: column.getBoundingClientRect().height,
      hatches: [...column.querySelectorAll("[data-usage-bars-hatch]")].map(part => ({
        type: part.getAttribute("data-usage-bars-hatch")!.split("/")[1]!, height: part.getBoundingClientRect().height })),
    })));
  assert.equal(columns.length, 2, `${label}: two painted bars`);
  assert.equal(columns[0]!.hatches.length, 0, `${label}: the chat's own earlier bar stays solid`);
  const latest = columns[1]!;
  assert.deepEqual(latest.hatches.map(hatch => hatch.type).sort(), ["cache", "new", "output"], `${label}: every type shows its share`);
  for (const hatch of latest.hatches) {
    const expected = latest.height * SPLIT_BAR.subtask[hatch.type]! / SPLIT_BAR.total;
    assert(Math.abs(hatch.height - expected) <= 1, `${label}: ${hatch.type} part is ${hatch.height}px, expected ${expected}px`);
  }
}

const hatchCount = (chart: Locator) => chart.locator("[data-usage-bars-hatch]").count();

async function openChat(page: Page, title: string) {
  const show = page.getByRole("button", { name: getAppCopy("ko-KR").titlebar.showLeftPanel, exact: true });
  const showEnglish = page.getByRole("button", { name: getAppCopy("en-US").titlebar.showLeftPanel, exact: true });
  if (await show.count()) await show.first().click();
  else if (await showEnglish.count()) await showEnglish.first().click();
  await page.getByText(title, { exact: true }).first().click();
}

async function openPopover(page: Page) {
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  await page.locator('[data-test-class="context-donut-button"]').click();
  const popover = page.locator('[data-test-class="context-popover"]');
  await popover.waitFor();
  await popover.locator('[data-slot="usage-bars"][data-state="ready"]').waitFor();
  return popover;
}

async function closePopover(page: Page, popover: Locator) {
  await page.keyboard.press("Escape");
  if (await popover.isVisible()) await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
}

async function popoverFlows(page: Page, expected: Expected) {
  await openChat(page, SPLIT_CHAT);
  let popover = await openPopover(page);
  const parts = popover.locator('[data-test-class="usage-parts"]');
  await parts.waitFor();
  await page.waitForTimeout(300);
  assert.match(await parts.innerText(), expected.popoverWhole, "popover: the chat's own and subtask parts");
  const chart = popover.locator('[data-slot="usage-bars"]');
  await assertLatestBarShare(chart, "popover");
  await chart.focus();
  await page.keyboard.press("End");
  assert.match(await parts.innerText(), expected.popoverBar, "popover: a selected bar splits its own total");
  await closePopover(page, popover);

  await openChat(page, SOLO_CHAT);
  popover = await openPopover(page);
  await page.waitForTimeout(300);
  assert.equal(await popover.locator('[data-test-class="usage-parts"]').count(), 0, "popover: no split without subtasks");
  assert.equal(await hatchCount(popover.locator('[data-slot="usage-bars"]')), 0, "popover: solid bars without subtasks");
  await closePopover(page, popover);
}

async function openUsage(page: Page, language: Language) {
  await page.keyboard.press("ControlOrMeta+k");
  const copy = getAppCopy(language);
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(copy.settings.sections.usage);
  await dialog.getByRole("option").filter({ has: page.getByText(copy.settings.sections.usage, { exact: true }) }).click();
  const section = page.locator('[data-settings-section-id="usage-overview"]');
  await section.locator('[data-slot="usage-bars"][data-state="ready"]').waitFor();
  return section;
}

async function selectChat(page: Page, section: Locator, id: string, title: string) {
  await Promise.all([page.waitForResponse(response => new URL(response.url()).searchParams.get("session_id") === id),
    section.getByRole("tabpanel").getByRole("button", { name: new RegExp(title, "u") }).click()]);
  await page.waitForTimeout(400);
}

async function settingsFlows(page: Page, language: Language, expected: Expected) {
  const section = await openUsage(page, language);
  const parts = section.locator('[data-test-class="usage-parts"]');
  const chart = section.locator('[data-slot="usage-bars"]');
  await section.getByRole("tabpanel").getByText(SPLIT_CHAT, { exact: true }).waitFor();
  assert.equal(await parts.count(), 0, "settings: all chats have no split");
  assert.equal(await hatchCount(chart), 0, "settings: all-chats bars stay solid");

  await selectChat(page, section, fixture.splitChat, SPLIT_CHAT);
  await parts.waitFor();
  assert.match(await parts.innerText(), expected.settingsWhole, "settings: parts with their requests");
  await assertLatestBarShare(chart, "settings");

  // Hovering a part's row links to the chart.
  const rows = parts.locator('[data-test-class="key-value-row"][data-linked="true"]');
  await rows.nth(1).hover();
  assert.equal(await chart.getAttribute("data-emphasis"), "subtask");
  await page.mouse.move(0, 0);
  assert.equal(await chart.getAttribute("data-emphasis"), null);

  await selectChat(page, section, fixture.soloChat, SOLO_CHAT);
  assert.equal(await parts.count(), 0, "settings: no split without subtasks");
  assert.equal(await hatchCount(chart), 0, "settings: solid bars without subtasks");
}

/** A response without the new fields: slots without per-type values and no `subtasks`. No hatch, no split rows, no share at all. */
async function olderResponseFlow(page: Page, language: Language) {
  await page.route("**/usage-monitor?*", async route => {
    const url = new URL(route.request().url());
    const view = await server.api<UsageMonitorView>(`${url.pathname}${url.search}`);
    view.timeline.slots = view.timeline.slots.map(slot => slot.slice(0, 6) as typeof slot);
    delete view.model.subtasks;
    await route.fulfill({ json: { data: view } });
  });
  try {
    const section = await openUsage(page, language);
    await selectChat(page, section, fixture.splitChat, SPLIT_CHAT);
    assert.equal(await section.locator('[data-test-class="usage-parts"]').count(), 0, "older response: no split rows");
    assert.equal(await hatchCount(section.locator('[data-slot="usage-bars"]')), 0, "older response: no hatched part");
    assert.equal(await section.locator('[data-slot="usage-bars"] [data-usage-bars-column]:not([data-zero="true"])').count(), 2, "older response: the bars still draw");
  } finally { await page.unroute("**/usage-monitor?*"); }
}

type Language = "ko-KR" | "en-US";
type Expected = { popoverWhole: RegExp; popoverBar: RegExp; settingsWhole: RegExp };

const cells: { language: Language; setting: string; theme: string; width: number; expected: Expected }[] = [
  { language: "ko-KR", setting: "ko", theme: "light", width: 1280, expected: {
    popoverWhole: /대화[\s\S]*6\.4만 · 64%[\s\S]*하위 작업[\s\S]*3\.6만 · 36%/u,
    popoverBar: /대화[\s\S]*5\.3만 · 59\.6%[\s\S]*하위 작업[\s\S]*3\.6만 · 40\.4%/u,
    settingsWhole: /대화[\s\S]*6\.4만 · 64% · 요청 \d+회[\s\S]*하위 작업[\s\S]*3\.6만 · 36% · 요청 2회/u } },
  { language: "en-US", setting: "en", theme: "dark", width: 375, expected: {
    popoverWhole: /Conversation[\s\S]*64K · 64%[\s\S]*Subtasks[\s\S]*36K · 36%/u,
    popoverBar: /Conversation[\s\S]*53K · 59\.6%[\s\S]*Subtasks[\s\S]*36K · 40\.4%/u,
    settingsWhole: /Conversation[\s\S]*64K · 64% · \d+ requests[\s\S]*Subtasks[\s\S]*36K · 36% · 2 requests/u } },
];

try {
  for (const cell of cells) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: cell.setting, appearance_theme: cell.theme }) });
    const context = await browser.newContext({ viewport: { width: cell.width, height: 1000 }, locale: cell.language, reducedMotion: "reduce" });
    await server.signIn(context);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url);
    await page.locator('[data-test-class~="composer-card"]').waitFor();
    await popoverFlows(page, cell.expected);
    await settingsFlows(page, cell.language, cell.expected);
    await page.goto(server.url);
    await page.locator('[data-test-class~="composer-card"]').waitFor();
    await olderResponseFlow(page, cell.language);
    await context.close();
    console.log(JSON.stringify({ cell: `${cell.setting}-${cell.theme}-${cell.width}`, pass: true }));
  }
  assert.deepEqual(errors, [], "no renderer errors");
  assert.equal(server.stubModelCalls.length, 0, "no call reached the generic stub");
} finally {
  await browser.close();
  await fixture.stop();
}
