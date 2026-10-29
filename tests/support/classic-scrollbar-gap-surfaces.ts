import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { HARNESS_MESSAGES, HARNESS_MODEL_CATALOG, HARNESS_NAVIGATION, HARNESS_PRIMARY_MODEL, HARNESS_SS03_OBSERVER_VIEW } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { canonFocusResponse } from "./canon-sidebar-fixture.ts";
import { installSessionBrowser } from "./session-info-fixtures.ts";

const copy = getAppCopy("ko-KR");
export type State = "fits" | "overflows";
export type Surface = {
  name: string; s: string; c: string; note: string;
  route?: string; width?: number; heights?: [number, number];
  storage?: (state: State) => Record<string, string>;
  axis?: "x";
  navigate?: (page: Page, state: State) => Promise<void>;
  leave?: (page: Page) => Promise<void>;
};
const test = (name: string) => `[data-test-class~="${name}"]`;
const slot = (name: string) => `[data-slot="${name}"]`;
const scroll = 'div[class*="_scroll_"]';
const transcript = test("conversation-scroll");
const aside = slot("conversation-aside-scroll");
const popover = slot("popover-content");
async function sidebar(page: Page) {
  const show = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
  if (await show.count()) await show.first().click();
  await page.locator(test("app-sidebar")).waitFor();
}
async function settings(page: Page) {
  await sidebar(page);
  await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).first().click();
  await page.locator(test("settings-view")).waitFor();
}
async function info(page: Page) { await page.locator(test("session-info-toggle")).click(); }
async function engaged(page: Page) {
  await page.locator(slot("composer-compact-preview")).click();
  await page.locator(test("composer-card") + ' [contenteditable="true"]').waitFor();
}
const child = ":scope > :first-child";
export const surfaces: Surface[] = [
  { name: "sidebar", s: test("sidebar-scroll"), c: child, note: "in-flow scrollContent wrapper", navigate: sidebar },
  { name: "transcript", s: transcript, c: test("message-list"), note: "message column wrapper" },
  { name: "transcript-aside", s: transcript, c: test("message-list"), note: "message column beside docked aside", navigate: info },
  { name: "aside-docked", s: aside, c: ":scope > :first-child > :first-child", note: "session section list inside the aside padding wrapper", heights: [2400, 400], navigate: info },
  { name: "aside-floating", s: aside, c: ":scope > :first-child > :first-child", note: "session section list inside the aside padding wrapper; 1024px floating layout", width: 1024, heights: [2400, 400], navigate: info },
  { name: "settings-nav", s: test("settings-navigation-scroll"), c: child, note: "ScrollArea content wrapper", heights: [2400, 360], navigate: settings },
  { name: "settings-detail", s: test("settings-detail-scroll"), c: child, note: "Server page ScrollArea content wrapper", heights: [860, 300],
    navigate: async p => { await settings(p); await p.getByRole("button", { name: copy.settings.sections.server, exact: true }).click();
      await p.locator('[data-settings-section-id="connection"]').waitFor(); } },
  { name: "composer", s: test("composer-card") + ' [contenteditable="true"]', c: ":scope > p:last-child", note: "Lexical editor scroller and last full-width paragraph; product composer is contenteditable",
    storage: state => ({ "butler:composer-draft:v1:butler-client": JSON.stringify({ schema: "butler.composer-draft.v1", session_id: "butler-client",
      text: draftText(state), updated_at: "2026-10-27T00:00:00Z" }) }),
    navigate: async (p, state) => {
      await engaged(p);
      await p.waitForFunction(text => document.querySelector('[data-test-class="composer-card"] [contenteditable="true"]')?.textContent === text, draftText(state));
    } },
  { name: "model-picker", s: slot("filtered-select-results"), c: child, note: "FilteredSelectPopover results content",
    navigate: async p => { await engaged(p); await p.locator(test("model-button")).click(); } },
  { name: "attachment-menu", s: popover, c: child, note: "OptionMenu root; mobile sheet is the vertical scroller", width: 390, heights: [860, 240],
    navigate: async p => { await engaged(p); await p.locator(test("attachment-button")).click(); } },
  { name: "permission-menu", s: popover, c: child, note: "OptionMenu root; mobile sheet is the vertical scroller", width: 390, heights: [860, 240],
    navigate: async p => { await engaged(p); await p.locator(test("access-button")).click(); } },
  { name: "sidebar-menu", s: '[role="menu"]', c: child, note: "first in-flow menu group", heights: [860, 160],
    navigate: async p => { await sidebar(p); await p.getByRole("button", { name: copy.space.menu, exact: true }).click();
      await p.getByRole("menuitem", { name: copy.sidebar.newProject, exact: true }).waitFor(); } },
  { name: "command-palette", s: '[role="dialog"] div:has(> [role="listbox"])', c: '[role="listbox"]', note: "results listbox; query narrows built-in settings results",
    navigate: async (p, state) => { await sidebar(p); await p.getByRole("button", { name: copy.sidebar.search, exact: true }).first().click();
      await p.locator('[role="dialog"] input').fill(state === "fits" ? "Gap" : ""); await p.waitForTimeout(300); } },
  { name: "document", s: scroll + ':has([data-test-class="document-reading-page"])', c: child, note: "document reading ScrollArea content",
    route: "&doc=doc-focus", heights: [1600, 400] },
  { name: "project-folder-list", s: '[role="dialog"] ' + scroll, c: child, note: "folder list ScrollArea content",
    navigate: async p => { await sidebar(p); await p.getByRole("button", { name: copy.space.menu, exact: true }).click();
      await p.getByRole("menuitem", { name: copy.sidebar.newProject, exact: true }).click();
      await p.getByRole("button", { name: copy.sidebar.chooseProjectFolder, exact: true }).click(); } },
  { name: "dialog-self", s: '[role="dialog"]', c: ":scope > div", note: "ProjectCreateDialog in-flow Stack after its visually hidden title; resize, no synthetic dialog", heights: [860, 180],
    navigate: async p => { await sidebar(p); await p.getByRole("button", { name: copy.space.menu, exact: true }).click();
      await p.getByRole("menuitem", { name: copy.sidebar.newProject, exact: true }).click(); } },
  { name: "dialog-scroll-body", s: test("steward-observer-transcript"), c: child, note: "SessionObserverDialog product ScrollArea content",
    route: "&surface=ss03", heights: [2400, 360] },
  { name: "autoGrow-textarea", s: '[data-canon-inline-editor] textarea', c: ":scope", note: "native textarea border box; product epic description edit",
    navigate: async (p, state) => { await info(p); await p.getByRole("button", { name: copy.canon.inlineEdit.description, exact: true }).click();
      await p.locator('[data-canon-inline-editor] textarea').fill(lines(state)); }, leave: async p => { await p.keyboard.press("Escape"); } },
  { name: "file-viewer", s: test("file-viewer-scroll"), c: child, note: "FileViewerPage ScrollArea content",
    navigate: async p => { await p.locator(test("message-artifact-list")).getByText("Layout file.txt", { exact: true }).click();
      await p.locator(test("artifact-viewer") + " pre").waitFor(); } },
  { name: "timezone-picker", s: slot("filtered-select-results"), c: child, note: "Settings timezone FilteredSelectPopover content; search makes it fit",
    navigate: async (p, state) => { await settings(p); await p.locator(test("settings-searchable-select-trigger")).click();
      if (state === "fits") await p.getByRole("textbox", { name: copy.settings.options.timezoneSearch, exact: true }).fill("Asia/Seoul"); } },
  { name: "settings-select", s: '[data-radix-select-viewport]', c: child, note: "Search provider Radix Select viewport and its in-flow option wrapper", heights: [860, 240],
    navigate: async p => { await settings(p); const trigger = p.getByRole("combobox", { name: copy.settings.fields.searchProvider, exact: true });
      await trigger.focus(); await p.keyboard.press("Space"); } },
  { name: "browser-TabRail", s: slot("tab-rail-shelf-scroll"), c: child, note: "shelf ScrollArea wrapper; fit/overflow on horizontal axis, gap formula remains vertical", axis: "x", width: 390 },
  { name: "browser-TabStrip", s: slot("tab-strip") + ' [class*="_scroller_"]', c: '[data-test-class="tab-strip-tab"]:last-of-type', note: "last in-flow tab button (group wrappers use display:contents); horizontal states, vertical gap formula", axis: "x",
    navigate: async p => { await sidebar(p); await p.locator(test("app-sidebar")).getByRole("button", { name: copy.browser.title, exact: true }).click(); } },
  { name: "project-document-picker", s: slot("filtered-select-results"), c: child, note: "composer nested project-document results content",
    navigate: async p => { await engaged(p); await p.locator(test("attachment-button")).click();
      await p.getByRole("button", { name: copy.interfaceDetails.projectDocuments, exact: true }).click(); } },
];

// These are coverage limitations, not zero-gap passes. The audit also inventories
// every overflow declaration (including horizontal-only and viewer-only surfaces).
export const unavailable = [
  { name: "예약 작업 list/detail/form and schedule menus", reason: "VisualHarness dispatches session/browser/library/plan/dashboard only; AutomationsView is mounted only by AppShell." },
  { name: "Tabs, SegmentedControl, attachment tiles, suggestion strip, KanbanBoard, ActivityHeatmap, ChangedLineDiff", reason: "Horizontal-only overflow; remaining product navigation is not covered by this table. Browser TabRail / TabStrip are covered with horizontal state checks." },
  { name: "underline fields", reason: "Product multiline inline-edit route not included; bordered autoGrow EpicFieldInput is covered separately." },
  { name: "Select menus; remaining FilteredSelectPopover / DropdownMenu / Popover instances", reason: "Measured: composer model/project documents, timezone, Settings search-provider Select, permission, attachment and sidebar menus. Remaining instances need navigation and fixtures; shared-component coverage is not claimed as per-instance coverage." },
  { name: "browser history/bookmarks/library, PageCard, ArtifactPreview, MarkdownContent, WorkActivityBlock, CardList, TimePicker", reason: "Require additional product navigation and data fixtures; overflow declarations retained in report inventory." },
  { name: "design-system viewer and foundation specimen scrollers", reason: "Documentation surfaces; no product route and no viewer fallback navigation entry yet." },
];

function lines(state: State) { return Array.from({ length: state === "fits" ? 1 : 60 }, (_, i) => `Layout measurement paragraph ${i + 1}.`).join("\n\n"); }
function draftText(state: State) { return state === "fits" ? "Layout input." : "Layout input. ".repeat(300); }

export function fixtureData(state: State, compact = false) {
  const count = state === "fits" ? 1 : 60;
  const navigation = structuredClone(HARNESS_NAVIGATION);
  const session = navigation.projects[0].sessions![0];
  navigation.projects[0].sessions = Array.from({ length: count }, (_, i) => ({ ...session, id: i ? `layout-${i}` : session.id, title: `Layout conversation ${i + 1}` }));
  navigation.space!.nodes = navigation.space!.nodes.filter(node => node.kind !== "session");
  navigation.space!.nodes.push(...navigation.projects[0].sessions.map((item, i) => ({ key: `s:${item.id}`, kind: "session" as const,
    entityId: item.id, parentKey: "p:butler", position: i, revision: 1, manualPlacement: false, scopeProjectId: "butler" })));
  const model = HARNESS_PRIMARY_MODEL;
  const models = Array.from({ length: count }, (_, i) => ({ ...model, model_ref: i ? `openai/layout-${i}` : model.model_ref,
    model_id: i ? `layout-${i}` : model.model_id, display_name: `Layout model ${i + 1}` }));
  const message = { ...HARNESS_MESSAGES[0], id: "layout-message", chat_id: "butler-client", role: "assistant", status: "delivered",
    text: lines(state), answer_blocks: [], artifacts: [{ id: "layout-file", title: "Layout file.txt", kind: "text", session_id: "butler-client",
      file_id: "file-00000000-0000-4000-8000-000000000001", url: "/message-files/file-00000000-0000-4000-8000-000000000001", deliverable: true,
      message_id: "layout-message", created_at: "2026-10-25T00:00:00Z" }] };
  const sessionView = { ...HARNESS_SS03_OBSERVER_VIEW, session_id: "butler-client", active_turn: null, latest_turn: null,
    parent_session_id: null, relation: null, steward_children: [], messages: [message], context: null, branch: null,
    artifacts: Array.from({ length: compact ? 0 : count }, (_, i) => ({ ...message.artifacts[0], id: `layout-file-${i}`, title: `Layout file ${i + 1}.txt` })),
    automations: [], pending_questions: [] };
  const browserTabs = Array.from({ length: compact ? 0 : count }, (_, i) => ({ id: `layout-tab-${i}`, owner: "conversation:butler-client",
    url: "https://example.invalid/", title: `Layout tab ${i + 1}`, favicon: "", agent: true, holder: "agent", agentAt: 1_760_000_000_000 - i,
    status: "idle", canBack: false, canForward: false }));
  const fixture = { messages: [message], sessionView, browserTabs, background: "plain", navigation,
    modelCatalog: { ...HARNESS_MODEL_CATALOG, models, providers: [{ ...HARNESS_MODEL_CATALOG.providers[0], models }] } };
  const replies: Record<string, unknown> = {};
  for (const path of ["/projects/butler/canon/sidebar", "/projects/butler/canon", "/canon/epics/focus-epic", "/canon/epics/focus-epic/progress"]) replies[path] = canonFocusResponse(path);
  for (const path of ["/session-view", "/summary", "/navigation", "/events/live", "/health"]) replies[path] = {};
  replies["/sessions/butler-client/controls"] = { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1",
    controls: { model: model.model_ref, reasoning_effort: "none", access_mode: "full_access", plan_mode: false } };
  replies["/session-queue"] = { queued_messages: [] };
  replies["/sessions/butler-client/pending-asks"] = { session_id: "butler-client", open_count: 0, asks: [] };
  replies["/documents/doc-focus"] = { id: "doc-focus", title: "Focus document", body: "# Focus document\n\n" + lines(state), rev: 1, author: "user",
    created_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z" };
  replies["/project-folders"] = { root_name: "Workspace", path: "", folders: Array.from({ length: count }, (_, i) => ({ name: `Folder ${i + 1}` })), next_after: null };
  replies["/command-palette"] = { results: Array.from({ length: count }, (_, i) => ({ id: `layout-${i}`, kind: "chat", title: `Gap ${i + 1}`, route: "session:butler-client" })) };
  replies["/projects/butler/dashboard/materials"] = { status: "ready", documents: Array.from({ length: count }, (_, i) => ({
    id: `layout-doc-${i}`, kind: "spec", title: `Layout document ${i + 1}`, safe_path_label: `document-${i}.md`, markdown: "Document content.", updated_at: "2026-10-25T00:00:00Z",
  })), nextCursor: null };
  return { fixture, replies, assets: { [message.artifacts[0].url]: { contentType: "text/plain", body: lines(state) } } };
}

export async function installBridge(page: Page) {
  await installSessionBrowser(page, Array.from({ length: 3 }, (_, i) => ({ id: `layout-tab-${i}`, owner: "conversation:butler-client",
    url: "https://example.invalid/", title: `Layout tab ${i + 1}`, favicon: "", agent: true, holder: "agent", agentAt: 1_760_000_000_000 - i,
    status: "idle", canBack: false, canForward: false })));
}
