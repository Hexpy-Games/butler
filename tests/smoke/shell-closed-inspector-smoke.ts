// The closed AdaptiveShell inspector stays out of keyboard focus and never
// scrolls the shell (#1279). The built app's real shell (VisualHarness) over
// an offline gateway stub; no model calls, no native agent. Run `npm --prefix
// packages/butler-app/client/ui run build` first (`bun run app:shell-inspector:smoke`).
//
// The inspector is closed by the browser bridge's focus request (the store's
// setRightOpen(false), which moves no focus) while a control inside it holds
// focus. Focus must leave it at once, for the control that opened it (else the
// workspace). Tab or Shift+Tab is pressed 0, 60 and 150 ms into the slide;
// focus must stay outside the inspector and the shell must not scroll.
// scrollIntoView({ inline: "start" }) on rows inside the closed inspector and
// the workspace must not scroll the shell either. Light and dark, desktop and
// phone width, with the panel motion on.
//
// BUTLER_SHELL_INSPECTOR_SHOTS=<dir> saves the shell with the inspector open
// and closed for each cell.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";

const root = process.cwd();
const shots = process.env.BUTLER_SHELL_INSPECTOR_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const dist = join(root, "packages/butler-app/client/ui/dist");
assert(existsSync(join(dist, "index.html")), "build the UI first: npm --prefix packages/butler-app/client/ui run build");
const base = "http://shell-inspector.localhost/";
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".html": "text/html", ".wasm": "application/wasm" };
const agentTab = { id: "t1", owner: "conversation:butler-client", url: "https://example.com/", title: "Tab 1", favicon: "",
  agent: true, holder: "agent", agentAt: 1_760_000_000_000, status: "idle", canBack: false, canForward: false };
const INSPECTOR = '[data-slot="adaptive-shell-inspector"]';
const SHELL = "[data-panel-layout]";
const TOGGLE = '[data-test-class~="titlebar-right-panel-toggle"]';
// Long enough for the slide and its delayed visibility to settle.
const SETTLE_MS = 700;

type Cell = { width: number; height: number; theme: "light" | "dark" };
type Geometry = { scrollLeft: number; scrollTop: number; scrollWidth: number; clientWidth: number; documentLeft: number };

function distFile(pathname: string): string | null {
  const path = normalize(join(dist, decodeURIComponent(pathname)));
  return path.startsWith(dist + sep) && existsSync(path) && statSync(path).isFile() ? path : null;
}

const browser = await launchSmokeBrowser();
const errors: string[] = [];
const failures: string[] = [];
let probes = 0;

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((selector) => {
    const shell = document.querySelector<HTMLElement>(selector)!;
    return { scrollLeft: shell.scrollLeft, scrollTop: shell.scrollTop, scrollWidth: shell.scrollWidth,
      clientWidth: shell.clientWidth, documentLeft: document.scrollingElement?.scrollLeft ?? 0 };
  }, SHELL);
}

function check(label: string, value: Geometry) {
  probes += 1;
  if (value.scrollLeft !== 0 || value.scrollTop !== 0 || value.documentLeft !== 0) {
    failures.push(`${label}: shell scrolled to ${value.scrollLeft},${value.scrollTop} (document ${value.documentLeft}; scrollWidth ${value.scrollWidth}, clientWidth ${value.clientWidth})`);
  }
}

async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** Presses the titlebar's inspector toggle from the keyboard and waits for the slide. */
async function pressToggle(page: Page, open: boolean) {
  await page.locator(TOGGLE).first().focus();
  await page.keyboard.press("Enter");
  await page.locator(`${INSPECTOR}[data-open="${open}"]`).waitFor();
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * The harness with its inspector open and settled, its rightmost control focused (the first the
 * slide hides). `fromToggle` opens it from the titlebar toggle, which then holds focus.
 */
async function openInspector(page: Page, cell: Cell, fromToggle = false) {
  await page.setViewportSize({ width: cell.width, height: cell.height });
  await page.goto(`${base}?visual=components&theme=${cell.theme}&locale=ko`);
  await page.locator(INSPECTOR).waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  const open = await page.locator(`${INSPECTOR}[data-open="true"]`).count() > 0;
  if (open && fromToggle) await pressToggle(page, false);
  if (!open || fromToggle) await pressToggle(page, true);
  await page.locator(`${INSPECTOR}[data-open="true"]`).waitFor();
  await page.waitForTimeout(SETTLE_MS);
  const focused = await page.evaluate((selector) => {
    const tabbable = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const right = (element: HTMLElement) => element.getBoundingClientRect().right;
    const target = [...document.querySelectorAll<HTMLElement>(`${selector} ${tabbable}`)]
      .filter((element) => element.getClientRects().length > 0)
      .reduce<HTMLElement | undefined>((best, element) => !best || right(element) > right(best) ? element : best, undefined);
    target?.focus();
    return Boolean(target && document.activeElement === target);
  }, INSPECTOR);
  assert(focused, `${cell.width}px ${cell.theme}: no control inside the open inspector took focus`);
}

/** Closes the inspector through the browser bridge's focus request: setRightOpen(false), focus untouched. */
async function closeFromBridge(page: Page) {
  await page.evaluate((tab) => {
    const push = (window as Window & { __smokeBrowserPush?: (state: unknown) => void }).__smokeBrowserPush;
    if (!push) throw new Error("the browser bridge never subscribed");
    push({ enabled: true, blocked: false, activeId: tab.id, nativeCovered: false, focusRequest: tab.id, tabs: [tab] });
  }, agentTab);
}

/** The focused element when it is inside the inspector, else null. */
async function focusInside(page: Page): Promise<string | null> {
  return page.evaluate((selector) => {
    const active = document.activeElement;
    if (!active || !document.querySelector(selector)?.contains(active)) return null;
    return `${active.tagName.toLowerCase()}[${active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 30) ?? ""}]`;
  }, INSPECTOR);
}

async function probeKey(page: Page, cell: Cell, key: "Tab" | "Shift+Tab", delay: number) {
  const label = `${cell.width}px ${cell.theme} ${key} at ${delay}ms`;
  await openInspector(page, cell);
  await closeFromBridge(page);
  if (delay > 0) await page.waitForTimeout(delay);
  await page.keyboard.press(key);
  const early = await focusInside(page);
  if (early) failures.push(`${label}: the key moved focus inside the closing inspector to ${early}`);
  await page.waitForTimeout(SETTLE_MS);
  assert.equal(await page.locator(`${INSPECTOR}[data-open="false"]`).count(), 1, `${label}: the bridge did not close the inspector`);
  check(label, await geometry(page));
  const inside = await focusInside(page);
  if (inside) failures.push(`${label}: focus stayed inside the closed inspector on ${inside}`);
}

/** Focus inside the closing inspector returns to the toggle that opened it; with no opener, to the workspace. */
async function probeFocusReturn(page: Page, cell: Cell) {
  for (const fromToggle of [true, false]) {
    await openInspector(page, cell, fromToggle);
    await closeFromBridge(page);
    const target = await page.evaluate(({ toggle, workspace }) => {
      const active = document.activeElement;
      return active?.matches(toggle) ? "toggle" : active?.matches(workspace) ? "workspace" : active?.tagName.toLowerCase() ?? "none";
    }, { toggle: TOGGLE, workspace: '[data-slot="adaptive-shell-workspace"]' });
    probes += 1;
    const expected = fromToggle ? "toggle" : "workspace";
    if (target !== expected) failures.push(`${cell.width}px ${cell.theme}: focus returned to ${target}, not the ${expected}`);
  }
}

/** scrollIntoView on rows of the closed inspector and of the workspace leaves the shell where it is. */
async function probeScrollIntoView(page: Page, cell: Cell) {
  await openInspector(page, cell);
  await capture(page, `${cell.width}-${cell.theme}-open`);
  await closeFromBridge(page);
  await page.waitForTimeout(SETTLE_MS);
  await capture(page, `${cell.width}-${cell.theme}-closed`);
  for (const scope of [INSPECTOR, '[data-slot="adaptive-shell-workspace"]']) {
    const found = await page.evaluate(({ scope, shell }) => {
      document.querySelector(shell)!.scrollLeft = 0;
      const rows = [...document.querySelectorAll<HTMLElement>(`${scope} [role="row"], ${scope} [role="tab"], ${scope} button`)];
      const row = rows.at(-1);
      row?.scrollIntoView({ block: "nearest", inline: "start" });
      return Boolean(row);
    }, { scope, shell: SHELL });
    assert(found, `${cell.width}px ${cell.theme}: no row in ${scope}`);
    await page.waitForTimeout(100);
    check(`${cell.width}px ${cell.theme} scrollIntoView in ${scope}`, await geometry(page));
  }
}

try {
  const page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((tab) => {
    const state = { enabled: true, blocked: false, activeId: null, nativeCovered: false, tabs: [tab] };
    const smokeWindow = window as Window & { butlerBrowser?: unknown; __smokeBrowserPush?: (state: unknown) => void };
    smokeWindow.butlerBrowser = {
      call: async (method: string) => method === "state" || method === "open" ? state : null,
      subscribe: (handler: (value: unknown) => void) => {
        smokeWindow.__smokeBrowserPush = handler;
        queueMicrotask(() => handler(state));
        return () => {};
      },
      onFrame: () => () => {}, onPointer: () => () => {}, onElementDrag: () => () => {}, onSelectionAction: () => () => {},
      onDownload: () => () => {}, onHistory: () => () => {}, onAddress: () => () => {},
    };
  }, agentTab);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: readFileSync(join(dist, "index.html"), "utf8") });
    const file = distFile(url.pathname);
    if (file) return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client",
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
  });
  for (const [width, height] of [[1440, 1000], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      const cell = { width, height, theme };
      await probeScrollIntoView(page, cell);
      await probeFocusReturn(page, cell);
      for (const key of ["Tab", "Shift+Tab"] as const) {
        for (const delay of [0, 60, 150]) await probeKey(page, cell, key, delay);
      }
    }
  }
  console.log(JSON.stringify({ probes, failures: failures.length, rendererErrors: errors.length }));
  assert.deepEqual(failures, [], `the closed inspector moved the shell or kept focus:\n${failures.join("\n")}`);
  assert.deepEqual(errors, [], "no uncaught renderer errors");
} finally {
  await browser.close();
}
