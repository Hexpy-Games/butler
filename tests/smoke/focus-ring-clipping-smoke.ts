// test-category: race
// Focus rings are never clipped. The built app's real shell (VisualHarness:
// product Sidebar, Conversation with answer cards and the agent tab rail, new
// chat, browser, command palette, menus, Settings, plus the drag-enabled
// KanbanBoard, StackDeck, StepSortableList, editable Tag and FilteredSelectPopover row-actions stories of
// the DS viewer) over an offline gateway
// stub, plus real session/dashboard inline-edit panes through an isolated
// native App; no model calls. Run `npm --prefix
// packages/butler-app/client/ui run build` first (`bun run app:focus-ring:smoke`).
//
// Every screen is walked with the keyboard (Tab, and arrow keys inside menus
// and lists). At each stop the focus indicator's rectangle must sit inside
// every ancestor that clips its painting (overflow, clip-path, mask including
// the scroll-edge fades) and the viewport. Each screen's overflowing scrollers
// are also scrolled so an edge fade is on, then the control at that edge takes
// focus and is probed frame by frame (#1017). Settings › Usage and the context
// popover run with a delegating chat, so its linked split rows are walked too.
// Light and dark, wallpaper and plain, desktop and phone width.
//
// BUTLER_FOCUS_RING_SHOTS=<dir> saves a capture of each clipped stop.
import { historyFixture } from "../support/usage-insights-fixtures";
import { canonFocusResponse } from "../support/canon-sidebar-fixture.ts";
import { auditInlinePanes } from "../support/session-pane-focus.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts";
import type { MessageRecord, UsageMonitorView } from "../../packages/butler-app/client/ui/src/app/types";
import { delegatedUsageView } from "../../packages/butler-app/client/ui/src/components/conversation/contextUsage.fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { auditTabOrder, formatClips, probeFocusRing, probeFocusRingFrames, type FocusRingClip } from "../support/focus-ring-clipping";

import { textSizeFactor } from "../../packages/butler-app/client/ui/src/app/textSize";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types";

const textSize = process.env.BUTLER_SMOKE_TEXT_SIZE ?? "default";
assert(["default", "large", "larger"].includes(textSize), "invalid smoke text size");
const uiScale = textSizeFactor(textSize as SettingsView["text_size"]);
/** The CSS viewport the App shows in a window of `cell` DIPs under its page zoom, never below the App's minimum window. */
const cssViewport = (cell: { width: number; height: number }) =>
  ({ width: Math.max(Math.round(cell.width / uiScale), 344), height: Math.max(Math.round(cell.height / uiScale), 480) });
const root = process.cwd();
const copy = getAppCopy("ko-KR");
const shots = process.env.BUTLER_FOCUS_RING_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const mock = JSON.parse(readFileSync(join(root, "tests/smoke/answer-blocks-mock.json"), "utf8")) as AnswerBlocks;
const answer: MessageRecord = { id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered",
  artifacts: [{ id: "doc-focus", title: "Focus document", kind: "doc", session_id: "butler-client", message_id: "answer", created_at: "2026-10-25T00:00:00Z" }],
  text: "조건에 맞는 후보를 비교했습니다.", created_at: "2026-10-12T08:51:00Z", answer_blocks: [{ call_id: "blocks", set_ids: [], spec: mock }] };
const myTabs = ["https://news.ycombinator.com/", "https://developer.mozilla.org/"].map((url, index) => ({
  id: `m${index + 1}`, owner: "mine", url, title: `My tab ${index + 1}`, favicon: "", status: "idle", canBack: false, canForward: false,
}));
const agentTabs = ["https://www.musinsa.com/products/4471209", "https://map.naver.com/", "https://example.com/a-very-long-path", "https://example.org/"].map((url, index) => ({
  id: `t${index + 1}`, owner: "conversation:butler-client", url, title: `Tab ${index + 1}`, favicon: "", agent: true, holder: "agent",
  agentAt: 1_760_000_000_000 - index, status: "idle", canBack: false, canForward: false, ...(index === 0 ? { waiting: true } : {}),
}));

const dist = join(root, "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "build the UI first: npm --prefix packages/butler-app/client/ui run build");
// Served through page.route from the build: no server, no dev-time module reloads.
const base = "http://focus-ring.localhost/";
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".html": "text/html", ".wasm": "application/wasm" };
function distFile(pathname: string): string | null {
  const path = normalize(join(dist, decodeURIComponent(pathname)));
  return path.startsWith(dist + sep) && existsSync(path) && statSync(path).isFile() ? path : null;
}
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const failures: string[] = [];
let checked = 0;
let scrolledStops = 0;

type Cell = { width: number; height: number; theme: "light" | "dark"; background: "plain" | "wallpaper" };
let fixture: { messages: MessageRecord[]; background: string } = { messages: [answer], background: "plain" };

async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

function record(cell: Cell, screen: string, result: { stops: number; clipped: FocusRingClip[]; visited?: string[]; unmarked?: string[] }) {
  checked += result.stops;
  if (process.env.BUTLER_FOCUS_RING_VERBOSE) {
    console.error(`${screen} @ ${cell.width}px ${cell.theme} ${cell.background}: ${result.stops} stops: ${(result.visited ?? []).join(" | ")}`);
    if (result.unmarked?.length) console.error(`  no indicator: ${result.unmarked.join(" | ")}`);
  }
  assert(result.stops > 0, `${screen}: the keyboard reached no control`);
  if (result.clipped.length) {
    const failure = `${screen} @ ${cell.width}px${uiScale === 1 ? "" : ` (${cssViewport(cell).width} CSS px at ${uiScale})`} ${cell.theme} ${cell.background}: ${result.clipped.length} clipped ring(s)\n${formatClips(result.clipped)}`;
    failures.push(failure);
    if (process.env.BUTLER_FOCUS_RING_VERBOSE) console.error(failure);
  }
}

/** A chat whose work was delegated; only a chat's view splits by role and carries the subtask slot values. */
function usageMonitor(url: URL): UsageMonitorView {
  const view = delegatedUsageView();
  const now = Date.parse(view.generated_at);
  const hours = Number(url.searchParams.get("since_hours")) || 0;
  const session = url.searchParams.get("session_id");
  view.filters = { sessionId: session, sinceTs: hours ? now - hours * 3_600_000 : null, untilTs: hours ? now : null };
  view.topSessions = [{ sessionId: "s1", title: "Login form refactor", kind: "chat", totalTokens: view.model.totalTokens,
    requests: view.model.requestCount, lastUsedMs: now }];
  if (!session) {
    delete view.model.byRole;
    view.timeline.slots = view.timeline.slots.map(([start, requests, prompt, cached, output]) => [start, requests, prompt, cached, output]);
  }
  return view;
}

/** `auth` picks the harness model's billing; a tracked one (api_key) shows usage in the context popover. */
async function open(page: Page, cell: Cell, auth?: string) {
  fixture = { messages: [answer], background: cell.background };
  await page.setViewportSize(cssViewport(cell));
  await page.goto(`${base}?visual=components&theme=${cell.theme}&locale=ko${auth ? `&auth=${auth}` : ""}`);
  await page.locator('[data-slot="item-card"]').first().waitFor();
  await page.locator('[data-slot="tab-rail"]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function openSidebar(page: Page) {
  const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel });
  if (await show.count()) await show.first().click();
  await page.locator('[data-test-class="app-sidebar"]').waitFor();
  await page.waitForTimeout(150);
}

/** Starts keyboard order just before `selector` so Tab enters it first. */
async function focusBefore(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) throw new Error(`missing ${selector}`);
    const anchor = document.createElement("span");
    anchor.tabIndex = -1;
    anchor.setAttribute("data-focus-audit-anchor", "");
    scope.parentElement!.insertBefore(anchor, scope);
    anchor.focus();
    anchor.addEventListener("blur", () => anchor.remove(), { once: true });
  }, selector);
}

async function auditScope(page: Page, cell: Cell, screen: string, selector: string, maxStops = 120) {
  await focusBefore(page, selector);
  const result = await auditTabOrder(page, { within: selector, maxStops });
  record(cell, screen, result);
  if (result.clipped.length) await capture(page, `${screen}-${cell.width}-${cell.theme}-${cell.background}`);
  await auditScrolledFades(page, cell, screen, selector);
}

/** Arrow keys walk a menu or list whose items take focus (or aria-activedescendant). */
async function auditArrows(page: Page, cell: Cell, screen: string, steps: number) {
  const clipped: FocusRingClip[] = [];
  let stops = 0;
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(40);
    const probe = await probeFocusRing(page);
    if (!probe) continue;
    stops += 1;
    clipped.push(...probe.clips);
  }
  record(cell, screen, { stops, clipped });
  if (clipped.length) await capture(page, `${screen}-${cell.width}-${cell.theme}-${cell.background}`);
}

/**
 * Scrolled scrollers: each scroll-fade scroller in `scope` that overflows and
 * holds keyboard stops is scrolled to one end, so the other edge's fade is on,
 * then the control at that faded edge takes keyboard focus (Tab in from before,
 * Shift+Tab from after) and focus scrolls it back to its edge. Its ring is
 * probed on every frame from focus on, while the fade catches up, and settled.
 */
async function auditScrolledFades(page: Page, cell: Cell, screen: string, scope: string) {
  const count = await page.evaluate((scope) => {
    const tabbable = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const scrollers = [...document.querySelectorAll<HTMLElement>(`${scope} [data-scroll-fade]`)].filter((element) => {
      const x = element.dataset.scrollFade === "x";
      const overflow = x ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
      return overflow > 1 && element.getClientRects().length > 0 && element.querySelector(tabbable);
    });
    scrollers.forEach((element, index) => element.setAttribute("data-focus-audit-scroller", String(index)));
    return scrollers.length;
  }, scope);
  for (let index = 0; index < count; index += 1) {
    for (const edge of ["start", "end"] as const) {
      const scroller = `[data-focus-audit-scroller="${index}"]`;
      // Scroll to the far end; the edge entered next then has its fade on.
      await page.evaluate(({ scroller, edge }) => {
        const element = document.querySelector<HTMLElement>(scroller)!;
        const far = edge === "start" ? 1e6 : 0;
        if (element.dataset.scrollFade === "x") element.scrollLeft = far;
        else element.scrollTop = far;
      }, { scroller, edge });
      await page.waitForFunction(({ scroller, edge }) => Number.parseFloat(getComputedStyle(document.querySelector(scroller)!)
        .getPropertyValue(`--scroll-fade-${edge}`)) > 0, { scroller, edge });
      const faded = await page.evaluate(({ scroller, edge }) => Number.parseFloat(getComputedStyle(document.querySelector(scroller)!)
        .getPropertyValue(`--scroll-fade-${edge}`)) > 0, { scroller, edge });
      assert(faded, `${screen}: ${scroller} scrolled away from its ${edge} has no ${edge} fade`);
      await page.evaluate(({ scroller, edge }) => {
        const element = document.querySelector(scroller)!;
        const anchor = document.createElement("span");
        anchor.tabIndex = -1;
        anchor.style.position = "absolute";
        element.parentElement!.insertBefore(anchor, edge === "start" ? element : element.nextSibling);
        anchor.focus();
        anchor.addEventListener("blur", () => anchor.remove(), { once: true });
      }, { scroller, edge });
      const clipped = await probeFocusRingFrames(page, () => page.keyboard.press(edge === "start" ? "Tab" : "Shift+Tab"));
      if (!await page.evaluate((scroller) => Boolean(document.activeElement?.closest(scroller)), scroller)) continue;
      await page.waitForTimeout(100);
      if (edge === "start" && await page.locator(scroller).evaluate(element => element.matches('[data-test-class~="conversation-scroll"]'))) {
        const focusedControl = await page.evaluateHandle(() => document.activeElement);
        await page.waitForTimeout(200);
        assert(await focusedControl.evaluate(element => element === document.activeElement),
          "conversation focus must survive the settling pin");
        await focusedControl.dispose();
        const focused = await probeFocusRing(page);
        assert(focused, "conversation control retains keyboard focus after settling");
        clipped.push(...focused.clips);
      }
      clipped.push(...(await probeFocusRing(page))?.clips ?? []);
      scrolledStops += 1;
      // The same cut on several frames is reported once.
      const unique = [...new Map(clipped.map((clip) => [`${clip.target} ${clip.clippedBy} ${JSON.stringify(clip.cut)}`, clip])).values()];
      record(cell, `${screen} scrolled to its ${edge === "start" ? "end" : "start"}`, { stops: 1, clipped: unique });
      if (clipped.length) await capture(page, `${screen}-scrolled-${index}-${edge}-${cell.width}-${cell.theme}-${cell.background}`);
    }
  }
  await page.evaluate(() => document.querySelectorAll("[data-focus-audit-scroller]").forEach((element) => element.removeAttribute("data-focus-audit-scroller")));
}

async function auditShelf(page: Page, cell: Cell) {
  await open(page, cell);
  await page.keyboard.press("Escape");
  const shelf = '[data-slot="tab-rail"][data-mode="shelf"]';
  const pill = page.locator(`${shelf} button`).filter({ hasText: /^\+\d+$/u });
  await pill.waitFor();
  await focusBefore(page, `${shelf} button[aria-label^="탭 "]`);
  await page.keyboard.press("Tab");
  assert(await pill.evaluate(element => element === document.activeElement), "shelf overflow pill takes keyboard focus");
  const probe = await probeFocusRing(page);
  assert(probe, "shelf overflow pill has a focus ring");
  record(cell, "tab-rail-shelf", { stops: 1, clipped: probe.clips });
  await capture(page, `tab-rail-shelf-${cell.width}-${cell.theme}-${cell.background}`);
}

async function auditCell(page: Page, cell: Cell) {
  await open(page, cell);
  await openSidebar(page);
  await page.locator('[data-test-class="canon-sidebar-group"]').first().waitFor();
  // Sidebar: top items, favorites, the spaces tree, nested rows and groups.
  await auditScope(page, cell, "sidebar", '[data-test-class="app-sidebar"]', 200);
  await capture(page, `sidebar-${cell.width}-${cell.theme}-${cell.background}`);
  await page.locator('[data-canon-group="focus-plan"] [data-test-class="canon-sidebar-group"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: copy.canon.overview, exact: true }).click();
  await page.locator('[data-test-class="canon-plan-epics"]').waitFor();
  await auditScope(page, cell, "plan-overview", '[data-test-class="canon-plan-overview"]', 80);
  await capture(page, `plan-overview-${cell.width}-${cell.theme}-${cell.background}`);
  await open(page, cell);
  // Conversation: answer cards' buttons, the agent tab rail and the composer.
  if (cell.width < 768) await page.keyboard.press("Escape");
  await auditScope(page, cell, "conversation", '[data-test-class~="conversation"]', 160);
  await page.locator('[data-test-class="message-artifact-list"]').getByText("Focus document", { exact: true }).click();
  await page.getByRole("textbox", { name: copy.documents.title, exact: true }).waitFor();
  await auditScope(page, cell, "document-page", '[data-test-class="editable-document"]', 30);
  const documentMenu = page.locator('[data-slot="document-editor-menu"] button');
  if (await documentMenu.isVisible()) {
    await focusBefore(page, '[data-slot="document-editor-menu"]');
    await page.keyboard.press("Tab");
    const probe = await probeFocusRing(page);
    assert(probe, "document overflow trigger has a focus ring");
    record(cell, "document-overflow-trigger", { stops: 1, clipped: probe.clips });
    await page.keyboard.press("Enter"); await page.getByRole("menu").waitFor();
    await auditArrows(page, cell, "document-overflow-items", await page.getByRole("menuitem").count());
    await page.keyboard.press("Escape");
  }
  await open(page, cell);
  // A menu: a sidebar row's menu walked with arrow keys.
  await openSidebar(page);
  await page.locator('[data-test-class="app-sidebar"] [data-slot="dropdown-menu-trigger"]').first().focus();
  await page.keyboard.press("Enter");
  await page.locator('[role="menu"]').first().waitFor();
  await auditArrows(page, cell, "menu", 6);
  await page.keyboard.press("Escape");
  // Browser project folder navigation uses the existing scroll-area focus room.
  await page.getByRole("button", { name: copy.space.menu, exact: true }).click();
  await page.getByRole("menuitem", { name: copy.sidebar.newProject, exact: true }).click();
  await page.getByRole("button", { name: copy.sidebar.chooseProjectFolder, exact: true }).click();
  await page.locator('[data-test-class="project-folder-row"]').first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator('[data-test-class="project-folder-up"]').waitFor();
  await auditArrows(page, cell, "project-folder-browser-arrows", 6);
  await auditScope(page, cell, "project-folder-browser", '[role="dialog"]', 80);
  await page.keyboard.press("Escape");
  await page.getByLabel(copy.sidebar.projectName, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  // Command palette (search) walked with arrow keys.
  await openSidebar(page);
  await page.getByRole("button", { name: copy.sidebar.search }).first().click();
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor();
  await auditArrows(page, cell, "command-palette", 10);
  await auditScope(page, cell, "command-palette-tab", '[role="dialog"]', 40);
  await page.keyboard.press("Escape");
  // New chat: suggestion cards and the composer.
  await openSidebar(page);
  await page.locator('[data-test-class="app-sidebar"]').getByRole("button", { name: copy.sidebar.newChat, exact: true }).first().click();
  await page.locator('[data-slot="prompt-suggestion-title"]').first().waitFor();
  await auditScope(page, cell, "new-chat", '[data-test-class~="conversation"]', 60);
  // The browser: its tab strip (my tabs and Butler's group) and toolbar.
  await openSidebar(page);
  await page.locator('[data-test-class="app-sidebar"]').getByRole("button", { name: copy.browser.title, exact: true }).first().click();
  await page.locator('[data-test-class="browser-area"]').waitFor();
  await auditScope(page, cell, "browser", '[data-test-class="browser-area"]', 60);
  // Settings: its nav and the general page.
  await openSidebar(page);
  await page.getByRole("button", { name: copy.sidebar.settings }).first().click();
  await page.locator('[data-test-class~="settings-view"]').waitFor();
  await auditScope(page, cell, "settings", '[data-test-class~="settings-view"]', 160);
  await auditUsage(page, cell);
  // A drag-enabled KanbanBoard (DS viewer story): a wide lane and two sideways-scrolling boards of cards.
  await page.goto(`${base}?visual=design-system&page=blocks/KanbanBoard&theme=${cell.theme}&locale=ko`);
  await page.locator('[data-slot="kanban-drag-scope"] [data-kanban-item]').first().waitFor();
  await auditScope(page, cell, "kanban-drag-board", '[data-slot="kanban-drag-scope"]', 40);
  // StackDeck (DS viewer story): fanned decks of six whose rows scroll sideways, settle on whole cards and clip at rest.
  await page.goto(`${base}?visual=design-system&page=blocks/StackDeck&theme=${cell.theme}&locale=ko`);
  const deckStory = '[data-ds-story="Four or more cards (edge markers)"]';
  await page.locator(`${deckStory} [data-slot="stack-deck-fan"]`).first().waitFor();
  await auditScope(page, cell, "stack-deck-fanned", deckStory, 40);
  // StepSortableList (DS viewer story): grips, a collapsed 묶음 (the deck button) and ⋯ menus in two chains.
  await page.goto(`${base}?visual=design-system&page=blocks/StepSortableList&theme=${cell.theme}&locale=ko`);
  const stepStory = '[data-ds-story="Multiple chains"]';
  await page.locator(`${stepStory} [data-step-grip]`).first().waitFor();
  await auditScope(page, cell, "step-sortable-list", stepStory, 40);
  // Folded titles and each open pill's + are part of the strip's arrow order.
  await page.goto(`${base}?visual=design-system&page=blocks/TabStrip&theme=${cell.theme}&locale=ko`);
  const stripStory = '[data-ds-story="Folded group: three favicons and +N beside an open group"]';
  const stops = page.locator(`${stripStory} [data-tab-strip-stop]:not([inert] *)`);
  await stops.first().waitFor();
  await stops.first().focus();
  for (let index = 0; index < await stops.count(); index += 1) {
    const clipped = await probeFocusRingFrames(page, () => page.keyboard.press(index === 0 ? "Home" : "ArrowRight"));
    const probe = await probeFocusRing(page);
    assert(probe, "TabStrip arrow stop has a focus indicator");
    record(cell, "tab-strip-folded-group", { stops: 1, clipped: [...clipped, ...probe.clips] });
  }
  // Tag edit pencils (DS viewer stories): an editable Tag, and FilteredSelectPopover rows whose edit menu sits at the scroller's edge.
  await page.goto(`${base}?visual=design-system&page=components/Tag&theme=${cell.theme}&locale=ko`);
  await page.locator('[data-ds-story="Editable"] [aria-haspopup="menu"]').first().waitFor();
  await auditScope(page, cell, "tag-edit", '[data-ds-story="Editable"]', 20);
  await page.goto(`${base}?visual=design-system&page=blocks/FilteredSelectPopover&theme=${cell.theme}&locale=ko`);
  await page.locator('[data-ds-story="Rows with actions"] [data-slot="filtered-select-item-actions"]').first().waitFor();
  await auditScope(page, cell, "filtered-select-row-actions", '[data-ds-story="Rows with actions"]', 40);
  // The floating conversation aside (DS viewer story, unscaled): rows flush with its own scroller on glass.
  await page.goto(`${base}?visual=design-system&page=blocks/ConversationShell&theme=${cell.theme}&locale=ko`);
  const aside = '[data-ds-story="Aside floating"] [data-slot="conversation-aside"]';
  await page.locator(`${aside} [data-slot="clickable"]`).first().waitFor();
  await auditScope(page, cell, "conversation-aside-floating", aside, 20);
  await auditCardListControls(page, cell);
}

/** Settings › 브라우저: controls inside a CardList description (the sign-in switch, the payment site field), keyboard-focused. */
async function auditCardListControls(page: Page, cell: Cell) {
  await open(page, cell);
  await openSidebar(page);
  await page.getByRole("button", { name: copy.sidebar.settings }).first().click();
  await page.getByRole("button", { name: copy.settings.sections.browser, exact: true }).first().click();
  for (const [screen, selector] of [
    ["settings-sign-in-switch", '[data-test-class="sign-in-row"] [role="switch"]'],
    ["settings-payment-site-field", '[data-test-class="vault-card-row"] input'],
  ] as const) {
    const control = page.locator(selector).first();
    await control.waitFor();
    // Programmatic focus is not :focus-visible; step out and back in with the keyboard.
    await control.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
    assert(await control.evaluate((node) => node === document.activeElement), `${screen}: keyboard focus reached the control`);
    const probe = await probeFocusRing(page);
    assert(probe, `${screen}: focus indicator`);
    record(cell, screen, { stops: 1, clipped: probe.clips });
    if (probe.clips.length) await capture(page, `${screen}-${cell.width}-${cell.theme}-${cell.background}`);
  }
}

/** Settings › Usage with a delegating chat selected (linked split rows, the chart), then the context popover. */
async function auditUsage(page: Page, cell: Cell) {
  const section = '[data-settings-section-id="usage-overview"]';
  await page.getByRole("button", { name: copy.settings.sections.usage, exact: true }).first().click();
  await page.locator(section).getByRole("tabpanel").getByRole("button", { name: /Login form refactor/u }).click();
  await page.locator(`${section} [data-test-class="usage-parts"] [data-linked="true"]`).first().waitFor();
  await auditScope(page, cell, "settings-usage", section, 80);
  await open(page, cell, "api_key");
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[data-test-class="context-donut-button"]').click();
  const popover = '[data-test-class="context-popover"]';
  await page.locator(`${popover} [data-test-class="usage-parts"] [data-linked="true"]`).first().waitFor();
  await auditScope(page, cell, "context-popover", popover, 20);
  await page.keyboard.press("Escape");
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce", locale: "ko-KR", timezoneId: "Asia/Seoul" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((scale) => {
    document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--ui-scale", String(scale)), { once: true });
  }, uiScale);
  await page.addInitScript((tabs) => {
    const state = { enabled: true, blocked: false, activeId: "m1", nativeCovered: false, tabs };
    (window as Window & { butlerBrowser?: unknown }).butlerBrowser = {
      call: async (method: string) => method === "state" || method === "open" ? state : null,
      subscribe: (handler: (value: typeof state) => void) => { queueMicrotask(() => handler(state)); return () => {}; },
      onFrame: () => () => {}, onPointer: () => () => {}, onElementDrag: () => () => {}, onSelectionAction: () => () => {},
      onDownload: () => () => {}, onHistory: () => () => {}, onAddress: () => () => {},
    };
  }, [...myTabs, ...agentTabs]);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const body = readFileSync(join(dist, "index.html"), "utf8")
        .replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
      return route.fulfill({ contentType: "text/html", body });
    }
    const file = distFile(url.pathname);
    if (file) return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    const canon = canonFocusResponse(url.pathname);
    if (canon !== undefined) return route.fulfill({ json: { ok: true, data: canon } });
    // The gateway: just what the harness reads, offline.
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client",
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/documents/doc-focus") return route.fulfill({ json: { ok: true, data: {
      id: "doc-focus", title: "Focus document", body: "# Focus document\n\nEditable paragraph.\n", rev: 1, author: "user",
      created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z",
    } } });
    if (url.pathname === "/project-folders") return route.fulfill({ json: { ok: true, data: {
      root_name: "Workspace", path: url.searchParams.get("path") ?? "",
      folders: Array.from({ length: 40 }, (_, index) => ({ name: `Folder ${index + 1}` })), next_after: null,
    } } });
    if (url.pathname === "/security/signins") return route.fulfill({ json: { ok: true, data: { available: true, sites: [{ site: "example.test",
      entry: { id: "12345678-1234-1234-1234-123456789012", username: "reader@example.test", policy: "ask", last_used_at: null },
      conversations: 0, all_conversations: false, uses: [] }] } } });
    if (url.pathname === "/security/vault") return route.fulfill({ json: { ok: true, data: { available: true, reveal_available: true, purchase_sites: [],
      cards: [{ id: "card-1", nickname: "Test card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, holder_name: "Test Holder",
        extras: [], sites: [], uses: [], last_used_at: null }], profiles: [] } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    if (url.pathname === "/usage-history") return route.fulfill({ json: { ok: true, data: historyFixture() } });
    if (url.pathname === "/usage-monitor") return route.fulfill({ json: { ok: true, data: usageMonitor(url) } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
  });
  for (const theme of ["light", "dark"] as const) await auditShelf(page, { width: 344, height: 480, theme, background: "plain" });
  for (const [width, height] of [[1280, 860], [390, 844], [985, 662], [1280, 800]]) {
    for (const theme of ["light", "dark"] as const) {
      for (const background of ["plain", "wallpaper"] as const) {
        const only = process.env.BUTLER_FOCUS_RING_CELL;
        if (only && only !== `${width}-${theme}-${background}`) continue;
        await auditCell(page, { width, height, theme, background });
      }
    }
  }
  console.log(JSON.stringify({ inlinePanes: await auditInlinePanes(browser) }));
  console.log(JSON.stringify({ stops: checked, scrolledStops, clippedScreens: failures.length, rendererErrors: errors.length }));
  assert(scrolledStops > 0, "no scrolled scroller with keyboard stops was audited");
  assert.deepEqual(failures, [], `focus rings are clipped:\n${failures.join("\n")}`);
  assert.deepEqual(errors, [], "no uncaught renderer errors");
} finally {
  await browser.close();
}
