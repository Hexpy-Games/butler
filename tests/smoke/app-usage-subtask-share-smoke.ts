// Real gateway and UI, usage rows seeded on disk: a chat's bars and rows show its subtask share, in the
// context popover and Settings › Usage; a chat without subtasks and an incomplete response show no wrong split.
import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import type { UsageMonitorView } from "../../packages/butler-app/client/ui/src/app/types";
import { timeBasedFiniteAnimationsSettled } from "../support/animation-settle";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { SOLO_CHAT, SPLIT_BAR, SPLIT_CHAT, startUsageSubtaskFixture } from "../support/usage-subtask-fixture";

const fixture = await startUsageSubtaskFixture(process.env.BUTLER_SMOKE_UI_ROOT);
const { server } = fixture;
const browser = await launchSmokeBrowser();
const errors: string[] = [];

/**
 * The seeded bars, whatever else an hour boundary adds around them (the stub turn's own bar, an
 * empty current hour): the chat's own earlier bar stays solid, and only the delegating bar is
 * hatched, each type's part being its subtask share of the column within 1px.
 */
async function assertSeededBarShare(chart: Locator, label: string) {
  const columns = await chart.evaluate(root => [...root.querySelectorAll<HTMLElement>("[data-usage-bars-column]")]
    .filter(column => column.dataset.zero !== "true").map(column => ({
      height: column.getBoundingClientRect().height,
      hatches: [...column.querySelectorAll("[data-usage-bars-hatch]")].map(part => ({
        type: part.getAttribute("data-usage-bars-hatch")!.split("/")[1]!, height: part.getBoundingClientRect().height })),
    })));
  const hatched = columns.filter(column => column.hatches.length);
  assert.equal(hatched.length, 1, `${label}: only the delegating bar is hatched`);
  const bar = hatched[0]!;
  assert(columns.indexOf(bar) > 0, `${label}: the chat's own earlier bar is drawn solid before it`);
  assert.deepEqual(bar.hatches.map(hatch => hatch.type).sort(), ["cache", "new", "output"], `${label}: every type shows its share`);
  for (const hatch of bar.hatches) {
    const expected = bar.height * SPLIT_BAR.subtask[hatch.type]! / SPLIT_BAR.total;
    assert(Math.abs(hatch.height - expected) <= 1, `${label}: ${hatch.type} part is ${hatch.height}px, expected ${expected}px`);
  }
}

const hatchCount = (chart: Locator) => chart.locator("[data-usage-bars-hatch]").count();
const usageResponse = (page: Page, id: string) => page.waitForResponse(response => {
  const url = new URL(response.url());
  return url.pathname === "/usage-monitor" && url.searchParams.get("session_id") === id;
});
const settled = (page: Page) => page.waitForFunction(timeBasedFiniteAnimationsSettled);
/** The readout showing this chat's total: its view has rendered. */
const readoutShows = (scope: Locator, total: string) =>
  scope.locator('[data-test-class="usage-readout"]').filter({ hasText: total }).waitFor();

/**
 * End, then back over bars that don't match: the hour can roll over mid-run and leave an empty
 * bar, or the stub turn's own, after the seeded one.
 */
async function selectLatestBar(page: Page, chart: Locator, match = ':not([data-zero="true"])') {
  await chart.focus();
  await page.keyboard.press("End");
  const selected = chart.locator(`[data-usage-bars-column][data-selected="true"]${match}`);
  for (let step = 0; step < 3 && !await selected.count(); step += 1) await page.keyboard.press("ArrowLeft");
  assert.equal(await selected.count(), 1, `the latest bar matching ${match} is selected`);
}

async function openChat(page: Page, title: string) {
  const show = page.getByRole("button", { name: getAppCopy("ko-KR").titlebar.showLeftPanel, exact: true });
  const showEnglish = page.getByRole("button", { name: getAppCopy("en-US").titlebar.showLeftPanel, exact: true });
  if (await show.count()) await show.first().click();
  else if (await showEnglish.count()) await showEnglish.first().click();
  await page.getByText(title, { exact: true }).first().click();
}

async function openPopover(page: Page, id: string, total: string) {
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  // Listen first: on a narrow window the expanding composer puts the donut under the pointer, and hover opens and fetches.
  await Promise.all([usageResponse(page, id), (async () => {
    if (await preview.isVisible()) await preview.click();
    await page.locator('[data-test-class="context-donut-button"]').click();
  })()]);
  const popover = page.locator('[data-test-class="context-popover"]');
  await popover.locator('[data-slot="usage-bars"][data-state="ready"]').waitFor();
  await readoutShows(popover, total);
  await settled(page);
  return popover;
}

async function closePopover(page: Page, popover: Locator) {
  await page.keyboard.press("Escape");
  if (await popover.isVisible()) await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });
}

async function popoverFlows(page: Page, expected: Expected) {
  await openChat(page, SPLIT_CHAT);
  let popover = await openPopover(page, fixture.splitChat, expected.splitTotal);
  const parts = popover.locator('[data-test-class="usage-parts"]');
  await parts.waitFor();
  assert.match(await parts.innerText(), expected.popoverWhole, "popover: the chat's own and subtask parts");
  const chart = popover.locator('[data-slot="usage-bars"]');
  await assertSeededBarShare(chart, "popover");
  await selectLatestBar(page, chart, ":has([data-usage-bars-hatch])");
  assert.match(await parts.innerText(), expected.popoverBar, "popover: a selected bar splits its own total");
  await closePopover(page, popover);

  await openChat(page, SOLO_CHAT);
  popover = await openPopover(page, fixture.soloChat, expected.soloTotal);
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

async function selectChat(page: Page, section: Locator, id: string, title: string, total: string) {
  await Promise.all([usageResponse(page, id),
    section.getByRole("tabpanel").getByRole("button", { name: new RegExp(title, "u") }).click()]);
  await readoutShows(section, total);
  await settled(page);
}

async function settingsFlows(page: Page, language: Language, expected: Expected) {
  const section = await openUsage(page, language);
  const parts = section.locator('[data-test-class="usage-parts"]');
  const chart = section.locator('[data-slot="usage-bars"]');
  await section.getByRole("tabpanel").getByText(SPLIT_CHAT, { exact: true }).waitFor();
  assert.equal(await parts.count(), 0, "settings: all chats have no split");
  assert.equal(await hatchCount(chart), 0, "settings: all-chats bars stay solid");

  await selectChat(page, section, fixture.splitChat, SPLIT_CHAT, expected.splitTotal);
  await parts.waitFor();
  assert.match(await parts.innerText(), expected.settingsWhole, "settings: parts with their requests");
  await assertSeededBarShare(chart, "settings");

  // Hovering a part's row links to the chart.
  const rows = parts.locator('[data-test-class="key-value-row"][data-linked="true"]');
  await rows.nth(1).hover();
  assert.equal(await chart.getAttribute("data-emphasis"), "subtask");
  await page.mouse.move(0, 0);
  assert.equal(await chart.getAttribute("data-emphasis"), null);

  await selectChat(page, section, fixture.soloChat, SOLO_CHAT, expected.soloTotal);
  await parts.waitFor({ state: "detached" });
  assert.equal(await hatchCount(chart), 0, "settings: solid bars without subtasks");
}

/** Serves real views cut down to an incomplete shape while `flow` runs. */
async function withResponses(page: Page, change: (view: UsageMonitorView) => void, flow: () => Promise<void>) {
  await page.route("**/usage-monitor?*", async route => {
    const url = new URL(route.request().url());
    const view = await server.api<UsageMonitorView>(`${url.pathname}${url.search}`);
    change(view);
    await route.fulfill({ json: { data: view } });
  });
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  try { await flow(); } finally { await page.unroute("**/usage-monitor?*"); }
}

const cutSlots = (view: UsageMonitorView, values: number) => {
  view.timeline.slots = view.timeline.slots.map(slot => slot.slice(0, values + 1) as typeof slot);
};

/** No `subtasks` and slots without per-type values: no hatch and no split rows. */
async function olderResponseFlow(page: Page, language: Language, expected: Expected) {
  await withResponses(page, view => { cutSlots(view, 5); delete view.model.subtasks; }, async () => {
    const section = await openUsage(page, language);
    await selectChat(page, section, fixture.splitChat, SPLIT_CHAT, expected.splitTotal);
    assert.equal(await section.locator('[data-test-class="usage-parts"]').count(), 0, "older response: no split rows");
    const chart = section.locator('[data-slot="usage-bars"]');
    assert.equal(await hatchCount(chart), 0, "older response: no hatched part");
    assert((await chart.locator('[data-usage-bars-column]:not([data-zero="true"])').count()) >= 2, "older response: the bars still draw");
  });
}

/** `subtasks` but slots without any subtask values: the chat's rows hold, and a selected bar can't claim 100% / 0%. */
async function partialResponseFlow(page: Page, language: Language, expected: Expected) {
  await withResponses(page, view => cutSlots(view, 4), async () => {
    const section = await openUsage(page, language);
    await selectChat(page, section, fixture.splitChat, SPLIT_CHAT, expected.splitTotal);
    const parts = section.locator('[data-test-class="usage-parts"]');
    await parts.waitFor();
    assert.match(await parts.innerText(), expected.settingsWhole, "partial response: the chat's parts come from its totals");
    const chart = section.locator('[data-slot="usage-bars"]');
    assert.equal(await hatchCount(chart), 0, "partial response: no hatched part");
    await selectLatestBar(page, chart);
    await parts.waitFor({ state: "detached", timeout: 5000 });
  });
}

type Language = "ko-KR" | "en-US";
type Expected = { splitTotal: string; soloTotal: string; popoverWhole: RegExp; popoverBar: RegExp; settingsWhole: RegExp };

const cells: { language: Language; setting: string; theme: string; width: number; expected: Expected }[] = [
  { language: "ko-KR", setting: "ko", theme: "light", width: 1280, expected: {
    splitTotal: "10만", soloTotal: "3.3만",
    popoverWhole: /대화[\s\S]*6\.4만 · 64%[\s\S]*하위 작업[\s\S]*3\.6만 · 36%/u,
    popoverBar: /대화[\s\S]*5\.3만 · 59\.6%[\s\S]*하위 작업[\s\S]*3\.6만 · 40\.4%/u,
    settingsWhole: /대화[\s\S]*6\.4만 · 64% · 요청 \d+회[\s\S]*하위 작업[\s\S]*3\.6만 · 36% · 요청 2회/u } },
  { language: "en-US", setting: "en", theme: "dark", width: 375, expected: {
    splitTotal: "100K", soloTotal: "33K",
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
    await olderResponseFlow(page, cell.language, cell.expected);
    await partialResponseFlow(page, cell.language, cell.expected);
    await context.close();
    console.log(JSON.stringify({ cell: `${cell.setting}-${cell.theme}-${cell.width}`, pass: true }));
  }
  assert.deepEqual(errors, [], "no renderer errors");
  // Routing is proved, not assumed: the seeded turns reached the local stub, and nothing tried to leave.
  assert(fixture.stubRequests() >= fixture.seededTurns, `the seeded turns reached the stub (${fixture.stubRequests()} requests)`);
  assert.deepEqual(fixture.egressAttempts, [], "no call tried to leave the machine");
  console.log(JSON.stringify({ stubRequests: fixture.stubRequests(), egressAttempts: fixture.egressAttempts.length }));
} finally {
  await browser.close();
  await fixture.stop();
}
