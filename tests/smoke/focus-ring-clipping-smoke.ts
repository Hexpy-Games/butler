// Focus rings are never clipped. The built app's real shell (VisualHarness:
// product Sidebar, Conversation with answer cards and the agent tab rail, new
// chat, browser, command palette, menus, Settings) over an offline gateway
// stub; no model calls, no native agent. Run `npm --prefix
// packages/butler-app/client/ui run build` first (`bun run app:focus-ring:smoke`).
//
// Every screen is walked with the keyboard (Tab, and arrow keys inside menus
// and lists). At each stop the focus indicator's rectangle must sit inside
// every ancestor that clips its painting (overflow, clip-path, mask including
// the scroll-edge fades) and the viewport. Light and dark, wallpaper and
// plain, desktop and phone width.
//
// BUTLER_FOCUS_RING_SHOTS=<dir> saves a capture of each clipped stop.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { auditTabOrder, formatClips, probeFocusRing, type FocusRingClip } from "../support/focus-ring-clipping";

const root = process.cwd();
const copy = getAppCopy("ko-KR");
const shots = process.env.BUTLER_FOCUS_RING_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const mock = JSON.parse(readFileSync(join(root, "tests/smoke/answer-blocks-mock.json"), "utf8")) as AnswerBlocks;
const answer: MessageRecord = { id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered",
  text: "조건에 맞는 후보를 비교했습니다.", created_at: "2026-10-12T08:51:00Z", answer_blocks: [{ call_id: "blocks", set_ids: [], spec: mock }] };
const myTabs = ["https://news.ycombinator.com/", "https://developer.mozilla.org/"].map((url, index) => ({
  id: `m${index + 1}`, owner: "mine", url, title: `My tab ${index + 1}`, favicon: "", status: "idle", canBack: false, canForward: false,
}));
const agentTabs = ["https://www.musinsa.com/products/4471209", "https://map.naver.com/", "https://example.com/a-very-long-path"].map((url, index) => ({
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
    const failure = `${screen} @ ${cell.width}px ${cell.theme} ${cell.background}: ${result.clipped.length} clipped ring(s)\n${formatClips(result.clipped)}`;
    failures.push(failure);
    if (process.env.BUTLER_FOCUS_RING_VERBOSE) console.error(failure);
  }
}

async function open(page: Page, cell: Cell) {
  fixture = { messages: [answer], background: cell.background };
  await page.setViewportSize({ width: cell.width, height: cell.height });
  await page.goto(`${base}?visual=components&theme=${cell.theme}&locale=ko`);
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

async function auditCell(page: Page, cell: Cell) {
  await open(page, cell);
  await openSidebar(page);
  // Sidebar: top items, favorites, the spaces tree, nested rows and groups.
  await auditScope(page, cell, "sidebar", '[data-test-class="app-sidebar"]', 200);
  // Conversation: answer cards' buttons, the agent tab rail and the composer.
  if (cell.width < 768) await page.keyboard.press("Escape");
  await auditScope(page, cell, "conversation", '[data-test-class~="conversation"]', 160);
  // A menu: a sidebar row's menu walked with arrow keys.
  await openSidebar(page);
  await page.locator('[data-test-class="app-sidebar"] [data-slot="dropdown-menu-trigger"]').first().focus();
  await page.keyboard.press("Enter");
  await page.locator('[role="menu"]').first().waitFor();
  await auditArrows(page, cell, "menu", 6);
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
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce", locale: "ko-KR", timezoneId: "Asia/Seoul" });
  page.on("pageerror", (error) => errors.push(error.message));
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
    // The gateway: just what the harness reads, offline.
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client",
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
  });
  for (const [width, height] of [[1280, 860], [390, 844]]) {
    for (const theme of ["light", "dark"] as const) {
      for (const background of ["plain", "wallpaper"] as const) {
        const only = process.env.BUTLER_FOCUS_RING_CELL;
        if (only && only !== `${width}-${theme}-${background}`) continue;
        await auditCell(page, { width, height, theme, background });
      }
    }
  }
  console.log(JSON.stringify({ stops: checked, clippedScreens: failures.length, rendererErrors: errors.length }));
  assert.deepEqual(failures, [], `focus rings are clipped:\n${failures.join("\n")}`);
  assert.deepEqual(errors, [], "no uncaught renderer errors");
} finally {
  await browser.close();
}
