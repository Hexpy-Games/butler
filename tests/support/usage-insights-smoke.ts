import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { HARNESS_MESSAGES, HARNESS_PRIMARY_MODEL } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { getAppCopy, type AppLocale } from "../../packages/butler-i18n/src";
import { compactTokens } from "../../packages/butler-app/client/ui/src/components/usage/compactTokens";
import { historyFixture, insightsCatalog, insightsMonitor, INSIGHTS_NOW, INSIGHTS_PROVIDERS } from "./usage-insights-fixtures";
import { canonFocusResponse } from "./canon-sidebar-fixture";
import { probeFocusRingFrames } from "./focus-ring-clipping";

const BASE = "http://insights.localhost";
const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
type State = { empty: boolean; failure: boolean; noProviders: boolean; reads: number; release?: Promise<void> };

async function stubPage(page: Page, dist: string, state: State) {
  await page.clock.setFixedTime(INSIGHTS_NOW);
  await page.addInitScript(({ catalog, messages }) => {
    Object.assign(window, { butlerConversationFixture: { messages, modelCatalog: catalog } });
  }, { catalog: insightsCatalog(), messages: HARNESS_MESSAGES });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== BASE) return route.abort();
    const file = normalize(join(dist, url.pathname === "/" ? "index.html" : url.pathname));
    if (file.startsWith(dist + sep) && existsSync(file)) return route.fulfill({ contentType: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    const canon = canonFocusResponse(url.pathname);
    if (canon !== undefined) return route.fulfill({ json: { ok: true, data: canon } });
    if (url.pathname === "/usage-history") {
      state.reads++;
      if (state.release) await state.release;
      return state.failure ? route.fulfill({ status: 503, json: { ok: false, error: "unavailable" } })
        : route.fulfill({ json: { ok: true, data: historyFixture(state.empty) } });
    }
    if (url.pathname === "/usage-monitor") return route.fulfill({ json: { ok: true, data: insightsMonitor(state.noProviders, state.empty) } });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: {
      session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1",
      controls: { model: HARNESS_PRIMARY_MODEL.model_ref, reasoning_effort: "none", access_mode: "full_access", plan_mode: false },
    } } });
    if (url.pathname === "/personalization") return route.fulfill({ json: { ok: true, data: {
      persona: "", eol: "", persona_presets: [], profile: {}, profiling: { mode: "off" },
    } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    return route.fulfill({ json: { ok: true, data: {} } });
  });
}

async function openUsage(page: Page, theme: string, locale: AppLocale) {
  const copy = getAppCopy(locale);
  await page.goto(`${BASE}/?visual=components&theme=${theme}&locale=${locale.startsWith("ko") ? "ko" : "en"}&auth=api_key`);
  const closeInspector = page.locator('[data-test-class="workspace"]').getByRole("button", { name: copy.titlebar.hideRightPanel, exact: true }).first();
  if (await closeInspector.isVisible()) await closeInspector.click();
  await page.locator('[data-test-class="workspace"]').waitFor();
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  await page.locator('[data-test-class="context-donut-button"]').click();
  await page.locator('[data-test-class="context-popover"]').getByRole("button", { name: copy.composer.usage.details, exact: true }).click();
  await page.locator('[data-settings-section-id="usage-overview"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function assertFilledRows(section: Locator) {
  const rows = await section.locator('[data-slot="metric-grid"]').evaluate(grid => {
    const bounds = grid.getBoundingClientRect();
    const rows = new Map<number, DOMRect[]>();
    for (const tile of grid.children) {
      const rect = tile.getBoundingClientRect(), key = Math.round(rect.top);
      rows.set(key, [...rows.get(key) ?? [], rect]);
    }
    return [...rows.values()].map(tiles => ({ count: tiles.length,
      left: Math.abs(tiles[0]!.left - bounds.left - 1), right: Math.abs(tiles.at(-1)!.right - bounds.right + 1),
      gap: tiles.slice(1).map((tile, i) => Math.abs(tile.left - tiles[i]!.right - 1)) }));
  });
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 5);
  for (const row of rows) assert(row.left <= 1 && row.right <= 1 && row.gap.every(gap => gap <= 1), `stat row fills: ${JSON.stringify(rows)}`);
  return rows.map(row => row.count);
}

async function gridGeometry(section: Locator) {
  return section.locator('[data-cell="compact"]').evaluate(root => {
    const cell = root.querySelector<HTMLElement>("[data-index]")!;
    const grid = cell.parentElement!, viewport = grid.parentElement!.parentElement!;
    const rect = grid.getBoundingClientRect();
    return { width: rect.width, height: rect.height, scroll: viewport.scrollLeft, max: viewport.scrollWidth - viewport.clientWidth,
      columns: Math.round((rect.width + 3) / 13), cells: grid.querySelectorAll("[data-index]").length };
  });
}

async function assertViews(page: Page, locale: AppLocale, empty: boolean, state: State) {
  const copy = getAppCopy(locale).composer.usage;
  const section = page.locator('[data-settings-section-id="usage-history"]');
  const daily = await gridGeometry(section);
  assert.equal(daily.columns, 53);
  assert.equal(daily.cells, 368, "Daily omits the future Thursday through Saturday");
  assert(Math.abs(daily.scroll - daily.max) <= 1, "latest week opens in view");
  const beforeReads = state.reads;
  const rows = await assertFilledRows(section);
  const width = page.viewportSize()!.width;
  assert.deepEqual(rows, width === 1280 ? [5] : width === 800 ? [3, 2] : width === 390 ? [2, 2, 1] : [1, 1, 1, 1, 1]);
  const cells = section.locator("[data-index]");
  assert.match(await cells.last().getAttribute("aria-label") ?? "", empty ? /(?:9월 16일|Sep 16) · (?:사용 없음|No usage)/u : /(?:9월 16일|Sep 16) · (?:700만|7M)/u);
  if (empty) assert.equal(await section.locator('[data-level]:not([data-level="0"])').count(), 0);
  await cells.last().focus();
  assert.deepEqual(await probeFocusRingFrames(page, () => page.keyboard.press("ArrowUp")), [], "heatmap focus ring across six frames");
  const activeLabel = await page.locator(":focus").getAttribute("aria-label");
  await page.getByRole("tooltip").filter({ hasText: activeLabel! }).waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  // Let the DS's deferred focus-ring reveal finish before simulating a later user scroll.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // A user scroll must survive switches, not merely remain anchored at the end.
  await cells.first().evaluate(cell => { const viewport = cell.parentElement!.parentElement!.parentElement!; viewport.scrollLeft /= 2; });
  const scrolled = await gridGeometry(section);
  const first = await cells.first().elementHandle();
  for (const label of [copy.viewWeekly, copy.viewCumulative, copy.viewDaily]) {
    await section.getByRole("radio", { name: label, exact: true }).click();
    const geometry = await gridGeometry(section);
    assert.equal(geometry.width, daily.width); assert.equal(geometry.height, daily.height);
    assert.equal(geometry.scroll, scrolled.scroll);
    assert.equal(geometry.cells, label === copy.viewDaily ? 368 : 371);
    assert(await first!.evaluate(node => node.isConnected), "switch retains the cell and calendar instance");
    if (label !== copy.viewDaily) {
      const name = await cells.last().getAttribute("aria-label");
      assert.match(name!, locale.startsWith("ko") ? /9월 13일 주(?:까지)? · /u : /(?:Week of|Through week of) Sep 13 · /u);
    }
  }
  assert.equal(state.reads, beforeReads, "view switches never fetch");
  return rows;
}

async function assertProviders(page: Page, locale: AppLocale) {
  const copy = getAppCopy(locale).composer.usage;
  const providers = page.locator('[data-test-class="usage-provider"]');
  assert.deepEqual(await providers.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-provider"))), INSIGHTS_PROVIDERS);
  const payg = providers.nth(1);
  await payg.getByText(copy.payAsYouGo, { exact: true }).waitFor();
  await payg.getByText(copy.thisMonth, { exact: true }).waitFor();
  await payg.getByText(compactTokens(12400000, locale), { exact: true }).waitFor();
  assert.equal(await payg.getByRole("progressbar").count(), 0);
  await providers.last().getByText(copy.estimated, { exact: true }).waitFor();
  await providers.nth(2).getByText(copy.refreshFailedStale(locale.startsWith("ko") ? "12분" : "12m"), { exact: true }).waitFor();
  assert.equal(await providers.nth(2).locator('[data-stale="true"]').count(), 1);
  const plan = providers.first();
  for (const [i, value] of [82, 20, 64].entries()) {
    const meter = plan.getByRole("progressbar").nth(i);
    assert.equal(await meter.getAttribute("aria-valuenow"), String(value));
    const fill = meter.locator('[data-slot="progress-fill"]');
    const color = await fill.evaluate((element, tone) => {
      const expected = getComputedStyle(element).getPropertyValue(`--color-${tone}`).trim();
      const probe = document.createElement("span"); probe.style.color = expected; element.append(probe);
      const result = { actual: getComputedStyle(element).backgroundColor, expected: getComputedStyle(probe).color }; probe.remove(); return result;
    }, i === 1 ? "warning" : "danger");
    if (i === 1) assert.equal(color.actual, color.expected);
  }
  await providers.last().getByText(locale.startsWith("ko") ? "한도 도달 · 1시간 12분 후 재설정" : "Limit reached · resets in 1h 12m", { exact: true }).waitFor();
  assert(!/(?:남음|remaining)/u.test(await plan.innerText()), "percentages have no repeated suffix");
}

async function assertHistoryState(page: Page, locale: AppLocale, empty: boolean) {
  const copy = getAppCopy(locale).composer.usage;
  for (const title of [copy.overviewTitle, copy.historyTitle, copy.remaining]) await page.getByRole("heading", { name: title, exact: true }).waitFor();
  const section = page.locator('[data-settings-section-id="usage-history"]');
  const values = section.locator('[data-slot="metric-value"]');
  await values.first().locator('[data-slot="animated-number-final"]').filter({ hasText: empty ? "0" : compactTokens(4410000000, locale) }).waitFor({ state: "attached" });
  assert.equal(await values.count(), 5);
  assert.deepEqual(await metricTexts(section), empty ? ["0", "—", "—", copy.days(0), copy.days(0)]
    : [compactTokens(4410000000, locale), compactTokens(300000000, locale), locale.startsWith("ko") ? "6시간 41분" : "6h 41m", copy.days(41), copy.days(23)]);
  if (empty) assert.equal(await section.locator('[data-slot="metric-grid"]').getByText(/9월|Sep|Rewrite/u).count(), 0);
}

async function assertRefresh(page: Page, state: State, locale: AppLocale) {
  const copy = getAppCopy(locale), section = page.locator('[data-settings-section-id="usage-history"]');
  const refresh = page.locator('[data-settings-section-id="usage-overview"]').getByRole("button", { name: copy.common.refresh, exact: true });
  const before = await metricTexts(section);
  state.failure = true;
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/usage-history"), refresh.click()]);
  await page.locator("[data-sonner-toast]").filter({ hasText: copy.interfacePanels.usageFailed }).waitFor();
  assert.deepEqual(await metricTexts(section), before, "failed refresh keeps last good history");
  state.failure = false; state.noProviders = true;
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/usage-history"), refresh.click()]);
  await page.locator('[data-settings-section-id="usage-providers"]').waitFor({ state: "detached" });
}

async function assertLoading(page: Page, state: State, locale: AppLocale, shots: string, width: number) {
  let release!: () => void;
  state.release = new Promise<void>(resolve => { release = resolve; });
  state.failure = false; state.noProviders = false;
  try {
    await openUsage(page, "light", locale);
    const history = page.locator('[data-test-class="usage-history"]');
    await history.locator('[data-slot="metric-value"]').first().filter({ hasText: "—" }).waitFor();
    const before = (await history.boundingBox())!;
    await page.screenshot({ path: join(shots, `loading-${locale}-${width}.png`), fullPage: true });
    release(); state.release = undefined;
    await history.locator('[data-slot="animated-number-final"]').first().waitFor({ state: "attached" });
    const after = (await history.boundingBox())!;
    state.failure = true;
    await openUsage(page, "light", locale);
    await history.locator('[data-slot="metric-value"]').first().filter({ hasText: "—" }).waitFor();
    await page.locator("[data-sonner-toast]").filter({ hasText: getAppCopy(locale).interfacePanels.usageFailed }).waitFor();
    assert.equal(await history.locator('[role="alert"]').count(), 0);
    assert(Math.abs(before.height - after.height) <= 1, `loading history shifts ${after.height - before.height}px at ${width}`);
  } finally { release(); state.release = undefined; state.failure = false; }
}

async function capturePopulatedSections(page: Page, locale: AppLocale, theme: string, width: number, shots: string) {
  const usageCopy = getAppCopy(locale).composer.usage;
  const history = page.locator('[data-settings-section-id="usage-history"]');
  const views = [
    [usageCopy.viewDaily, "daily"],
    [usageCopy.viewWeekly, "weekly"],
    [usageCopy.viewCumulative, "cumulative"],
  ] as const;
  for (const [label, view] of views) {
    await history.getByRole("radio", { name: label, exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await history.locator("[data-index]").last().evaluate(cell => {
      const viewport = cell.parentElement!.parentElement!.parentElement!;
      viewport.scrollLeft = viewport.scrollWidth;
    });
    await history.screenshot({ path: join(shots, `view-${locale}-${theme}-${width}-${view}.png`) });
  }
  await history.getByRole("radio", { name: usageCopy.viewDaily, exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await history.locator("[data-index]").last().evaluate(cell => {
    const viewport = cell.parentElement!.parentElement!.parentElement!;
    viewport.scrollLeft = viewport.scrollWidth;
  });
  await page.locator('[data-settings-section-id="usage-providers"]').screenshot({ path: join(shots, `limits-${locale}-${theme}-${width}.png`) });
}

export async function runUsageInsightsSmoke(browser: Browser, dist: string, shots: string) {
  const baseline = process.env.BUTLER_USAGE_BASELINE_DIST;
  if (baseline) await captureUsageScreenshots(browser, baseline, shots);
  const failures: string[] = [];
  const results: { width: number; locale: AppLocale; theme: string; empty: boolean; rows: number[] }[] = [];
  for (const locale of ["ko-KR", "en-US"] as const) for (const width of [1280, 800, 390, 320]) {
    const page = await browser.newPage({ locale, timezoneId: "Asia/Seoul", viewport: { width, height: 2800 }, reducedMotion: "reduce" });
    const state: State = { empty: false, failure: false, noProviders: false, reads: 0 };
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      await stubPage(page, dist, state);
      for (const theme of ["light", "dark"]) for (const empty of [false, true]) {
        state.empty = empty;
        await openUsage(page, theme, locale);
        try {
          await assertHistoryState(page, locale, empty);
          await assertProviders(page, locale);
          const rows = await assertViews(page, locale, empty, state);
          results.push({ width, locale, theme, empty, rows });
        } catch (error) { failures.push(`${locale}/${width}/${theme}/${empty ? "empty" : "populated"}: ${String(error)}`); }
        await page.locator('[data-settings-section-id="usage-history"] [data-index]').last().evaluate(cell => {
          const viewport = cell.parentElement!.parentElement!.parentElement!;
          viewport.scrollLeft = viewport.scrollWidth;
        });
        await page.screenshot({ path: join(shots, `insights-${locale}-${theme}-${width}-${empty ? "empty" : "populated"}.png`), fullPage: true });
        if (!empty) await capturePopulatedSections(page, locale, theme, width, shots);
      }
      state.empty = false;
      if (locale === "en-US" && width === 1280) {
        try { await assertMotion(page, state, locale); } catch (error) { failures.push(`motion: ${String(error)}`); }
      }
      await assertRefresh(page, state, locale);
      try { await assertLoading(page, state, locale, shots, width); } catch (error) { failures.push(`${locale}/${width}/loading: ${String(error)}`); }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  console.log(JSON.stringify({ insights: failures.length ? "fail" : "pass", screenshots: shots, variants: results, failures }));
  assert.deepEqual(failures, [], "insights smoke failures");
}

export async function captureUsageScreenshots(browser: Browser, dist: string, shots: string, prefix = "baseline") {
  for (const locale of ["ko-KR", "en-US"] as const) for (const width of [1280, 800, 390, 320]) {
    const page = await browser.newPage({ locale, timezoneId: "Asia/Seoul", viewport: { width, height: 2800 }, reducedMotion: "reduce" });
    const state: State = { empty: false, failure: false, noProviders: false, reads: 0 };
    try {
      await stubPage(page, dist, state);
      for (const theme of ["light", "dark"]) for (const empty of [false, true]) {
        state.empty = empty;
        try { await openUsage(page, theme, locale); } catch (error) {
          await page.screenshot({ path: join(shots, `${prefix}-failure-${locale}-${width}.png`) });
          console.error((await page.locator("body").innerText()).slice(0, 2000)); throw error;
        }
        await page.locator('[data-test-class="usage-readout"]').waitFor();
        if (prefix === "insights") await page.locator('[data-slot="metric-value"]').first().waitFor();
        const bottom = await page.locator('[data-slot="settings-page"]').evaluate(node => node.getBoundingClientRect().bottom);
        await page.setViewportSize({ width, height: Math.ceil(bottom + 32) });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.screenshot({ path: join(shots, `${prefix}-${locale}-${theme}-${width}-${empty ? "empty" : "populated"}.png`), fullPage: true });
      }
    } finally { await page.close(); }
  }
}

function metricTexts(section: Locator) {
  return section.locator('[data-slot="metric-value"]').evaluateAll(nodes => nodes.map(node =>
    node.querySelector('[data-slot="animated-number-final"]')?.textContent ?? node.textContent));
}

async function assertMotion(page: Page, state: State, locale: AppLocale) {
  const copy = getAppCopy(locale).composer.usage;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openUsage(page, "light", locale);
  const section = page.locator('[data-settings-section-id="usage-history"]');
  const cells = section.locator("[data-index]");
  await cells.first().waitFor();
  const levels = await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-level")));
  const transition = await cells.nth(7).evaluate(node => ({ duration: getComputedStyle(node, "::before").transitionDuration, delay: getComputedStyle(node, "::before").transitionDelay }));
  assert(transition.duration.split(",").some(value => parseFloat(value) > 0), "normal motion transitions the levels");
  assert(transition.delay.split(",").some(value => parseFloat(value) > 0), "the wave staggers cells");
  for (const label of [copy.viewWeekly, copy.viewCumulative, copy.viewDaily]) await section.getByRole("radio", { name: label, exact: true }).click();
  assert.deepEqual(await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-level"))), levels, "mid-wave retarget finishes on Daily's levels");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await cells.first().evaluate(node => getComputedStyle(node, "::before").transitionDuration), "0s", "reduced motion is instant");
  assert.equal(state.failure, false);
}
