// Product usage surfaces in VisualHarness, offline gateway, no model calls.
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";
import { probeFocusRing } from "../support/focus-ring-clipping";
import { launchSmokeBrowser } from "../support/smoke-browser";
import type { Locator, Page } from "playwright";
import { usageView, quota, delegatedUsageView, chatGptUsageFixtures } from "../../packages/butler-app/client/ui/src/components/conversation/contextUsage.fixtures";
import type { UsageMonitorView } from "../../packages/butler-app/client/ui/src/app/types";

const dist = join(process.cwd(), "packages/butler-app/client/ui/dist");
const shots = process.env.BUTLER_USAGE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const auth = process.env.BUTLER_USAGE_AUTH ?? "api_key";
const planState = process.env.BUTLER_USAGE_PLAN_STATE ?? "headers";
function planQuota() {
  return planState === "limit" ? chatGptUsageFixtures.limit : planState === "no-headers" ? chatGptUsageFixtures.noHeaders : quota();
}
const before = process.env.BUTLER_USAGE_BEFORE === "1";
const base = "http://usage.localhost";
const browser = await launchSmokeBrowser();
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html" };
let state = "ready";
let reads = 0;
let allReads = 0;
let cells = 0;
let backendTitle = "Login form refactor";
const heights = new Map<string, number>();
const heightDeltas: number[] = [];
let maxGapDelta = 0;
let maxShareDelta = 0;
const popoverHeights: Record<string, number> = {};
const chartHeights = new Map<string, number>();
const splitHeightDeltas: number[] = [];
/** Serve the delegated chat's slots without their subtask values: same totals and split rows, no hatch. */
let trimSlots = false;
type Slot = UsageMonitorView["timeline"]["slots"][number];
const alignmentDeltas: number[] = [];
let releaseLoading: (() => void)[] = [];
function monitor(url: URL) {
  const delegated = state === "delegated" && !before;
  const view = delegated ? delegatedUsageView({ quota: planQuota(), usd: 0.1563 }) : usageView({ quota: planQuota(), usd: 0.0842 });
  const now = Date.parse(view.generated_at);
  const hours = Number(url.searchParams.get("since_hours")) || 0;
  const session = url.searchParams.get("session_id");
  view.filters = { sessionId: session, sinceTs: hours ? now - hours * 3600000 : null, untilTs: hours ? now : null };
  // Slots append the delegated total, then that work's requests, cached and output. The first
  // hour's subtask parts are drawn; the last hour's are too thin and merge into solid. The
  // gateway sends these only for a session; the all-chats view gets them here too, so only the
  // client's session-scope gate keeps its bars solid.
  const delegatedSlots: Slot[] = [[now - 3600000, 1, 20000, 10000, 1000, 0, 0, 0, 0], [now - 1800000, 8, 41200, 28100, 3500, 44700, 8, 28100, 3500],
    [now - 600000, 2, 28200, 21900, 2420, 320, 1, 0, 20]];
  view.timeline.slots = state === "empty" ? [] : delegated
    ? delegatedSlots.map(slot => trimSlots && session ? slot.slice(0, 5) as Slot : slot)
    : [[now - 3600000, 1, 20000, 10000, 1000], [now - 600000, 2, 28200, 21900, 2420]];
  // As in the gateway, only a session view splits its usage by role.
  if (!session) delete view.model.byRole;
  view.topSessions = [{ sessionId: "s1", title: backendTitle, kind: "chat", totalTokens: delegated ? 96320 : 51620, requests: delegated ? 11 : 3, lastUsedMs: now },
    { sessionId: "s2", title: "Daily review", kind: "schedule", totalTokens: 1200, requests: 1, lastUsedMs: now - 3600000 }];
  if (state !== "empty") view.topSessions.push(...Array.from({ length: 6 }, (_, i) => ({ sessionId: `s${i + 3}`, title: `Review ${i + 3}`, kind: "chat" as const, totalTokens: 1000 - i * 100, requests: 1, lastUsedMs: now })));
  view.previousPeriod = { totalTokens: 40000 };
  view.model.byModel = { "openai/gpt-6-luna": { ...view.model } };
  view.tools = { calls: 3, results: 3, successes: 2, failures: 1, byTool: { read_file: { calls: 3, results: 3, successes: 2, failures: 1 } } };
  if (state === "empty") { view.cost.estimatedUsd = 0; view.model.totalTokens = 0; view.model.requestCount = 0; view.model.promptTokens = 0;
    view.model.cachedTokens = 0; view.topSessions = []; view.model.byModel = {}; view.tools.byTool = {}; }
  return view;
}
/** The first delegated hour (04:00Z): its total and each type's subtask tokens. */
const splitHour = { key: String(Date.parse("2026-09-28T04:00:00Z")), total: 65700, subtask: { new: 13100, cache: 28100, output: 3500 } as Record<string, number> };
/**
 * Painted columns of a chart: no gap inside a column, each hatched part sized
 * by its type's subtask share, and every split part at least 2px (thinner ones
 * merge into the larger part's style). Returns the hatch keys drawn.
 */
async function assertBars(chart: Locator, label: string) {
  const columns = await chart.evaluate(root => [...root.querySelectorAll<HTMLElement>("[data-usage-bars-column]")]
    .filter(column => column.dataset.zero !== "true").map(column => {
      const height = (element: Element) => element.getBoundingClientRect().height;
      const segments = [...column.firstElementChild!.children];
      return { height: height(column), segments: segments.map(height),
        parts: segments.filter(segment => segment.getAttribute("data-split") === "true").flatMap(segment => [...segment.children].map(height)),
        hatches: [...column.querySelectorAll("[data-usage-bars-hatch]")].map(part => ({ key: part.getAttribute("data-usage-bars-hatch")!, height: height(part) })) };
    }));
  assert(columns.length > 0, `${label}: painted columns`);
  for (const column of columns) {
    const sum = column.segments.reduce((total, value) => total + value, 0);
    maxGapDelta = Math.max(maxGapDelta, Math.abs(sum - column.height));
    assert(Math.abs(sum - column.height) <= 1, `${label}: segments fill their column without gaps (${sum} of ${column.height})`);
    assert(column.parts.every(part => part >= 1.9), `${label}: split parts are at least 2px (${column.parts})`);
    for (const hatch of column.hatches) {
      const [key, series] = hatch.key.split("/");
      assert.equal(key, splitHour.key, `${label}: only the first delegated hour draws subtask parts; thin ones merge`);
      const expected = column.height * splitHour.subtask[series!]! / splitHour.total;
      maxShareDelta = Math.max(maxShareDelta, Math.abs(hatch.height - expected));
      assert(Math.abs(hatch.height - expected) <= 1, `${label}: ${series} subtask part ${hatch.height}px, expected ${expected}px`);
    }
  }
  return columns.flatMap(column => column.hatches.map(hatch => hatch.key));
}

/** A linked legend row's hover or keyboard focus sets the chart's emphasis; leaving clears it. */
async function assertEmphasis(page: Page, parts: Locator, chart: Locator, label: string) {
  const rows = parts.locator('[data-test-class="key-value-row"][data-linked="true"]');
  assert.equal(await rows.count(), 2, `${label}: both split rows link to the chart`);
  await rows.nth(1).hover();
  assert.equal(await chart.getAttribute("data-emphasis"), "subtask", `${label}: subtask row hover`);
  await page.mouse.move(0, 0);
  assert.equal(await chart.getAttribute("data-emphasis"), null, `${label}: leaving the row clears the emphasis`);
  // Keyboard focus (:focus-visible) highlights; the rows are adjacent tab stops.
  await rows.nth(0).focus(); await page.keyboard.press("Tab");
  assert(await rows.nth(1).evaluate(row => row === document.activeElement), `${label}: Tab reaches the subtask row`);
  assert.equal(await chart.getAttribute("data-emphasis"), "subtask", `${label}: subtask row focus`);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await chart.getAttribute("data-emphasis"), "conversation", `${label}: conversation row focus`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  assert.equal(await chart.getAttribute("data-emphasis"), null, `${label}: blur clears the emphasis`);
}

/** Records every transform animation a chart starts (column grow, FLIP, part grow), however short. */
function recordChartTransforms() {
  const animate = Element.prototype.animate;
  const started: string[] = [];
  (window as unknown as { usageBarsTransforms: string[] }).usageBarsTransforms = started;
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    const frames = Array.isArray(keyframes) ? keyframes : keyframes ? [keyframes] : [];
    if (this.closest('[data-slot="usage-bars"]') && frames.some(frame => "transform" in frame || "scale" in frame)) started.push(this.className);
    return animate.call(this, keyframes, options);
  };
}

/** Reduced motion draws the final heights at once: no chart ever started a transform animation. */
async function assertNoTransformMotion(page: Page, label: string) {
  const started = await page.evaluate(() => (window as unknown as { usageBarsTransforms: string[] }).usageBarsTransforms.length);
  assert.equal(started, 0, `${label}: ${started} transform animation(s) under reduced motion`);
}

/** Settings › Usage splits a delegating chat like the popover, with each part's requests. */
async function delegatedSettings(page: Page, locale: string, cell: string) {
  const parts = page.locator('[data-settings-section-id="usage-overview"] [data-test-class="usage-parts"]');
  await page.locator('[data-settings-section-id="usage-overview"]').waitFor();
  await page.getByRole("tabpanel").getByText("Login form refactor", { exact: true }).waitFor();
  assert.equal(await parts.count(), 0, "all chats have no split");
  const chart = page.locator('[data-settings-section-id="usage-overview"] [data-slot="usage-bars"]');
  assert.deepEqual(await assertBars(chart, "all chats"), [], "all-chats bars have no hatch");
  await Promise.all([page.waitForResponse(r => new URL(r.url()).searchParams.get("session_id") === "s1"),
    page.getByRole("tabpanel").getByRole("button", { name: /Login form refactor/u }).click()]);
  await parts.waitFor();
  await page.waitForTimeout(400);
  assert.equal(await parts.locator('[data-test-class="key-value-row"]').count(), 2);
  if (locale === "ko") assert.match(await parts.innerText(), /대화[\s\S]*5\.2만 · 53\.6% · 요청 3회[\s\S]*하위 작업[\s\S]*4\.5만 · 46\.4% · 요청 8회/u);
  else assert.match(await parts.innerText(), /Conversation[\s\S]*53\.6% · 3 requests[\s\S]*Subtasks[\s\S]*46\.4% · 8 requests/u);
  if (shots) await page.screenshot({ path: join(shots, `after-usage-${locale}-${cell}-delegated-chat.png`) });
  await assertNoTransformMotion(page, "settings chat");
  assert.equal((await assertBars(chart, "settings chat")).length, 3, "the first delegated hour splits all three types");
  await assertEmphasis(page, parts, chart, "settings");
  await chart.focus(); await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  const bar = await parts.innerText();
  assert.match(bar, locale === "ko" ? /2\.1만 · 32% · 요청 1회[\s\S]*4\.5만 · 68% · 요청 8회/u : /32% · 1 request[\s\S]*68% · 8 requests/u,
    "a selected bar splits its own total and requests");
  assert.equal((await assertBars(chart, "settings selected")).length, 3, "a selected bar keeps its subtask parts");
  assert.deepEqual((await probeFocusRing(page))?.clips, [], "delegated chart focus ring");
  if (shots) await page.screenshot({ path: join(shots, `after-usage-${locale}-${cell}-delegated-bar.png`) });
  await page.keyboard.press("Escape");
}

try {
  const page = await browser.newPage({ locale: "ko-KR", timezoneId: "Asia/Seoul", reducedMotion: "reduce" });
  await page.addInitScript(recordChartTransforms);
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    const file = normalize(join(dist, url.pathname === "/" ? "index.html" : url.pathname));
    if (file.startsWith(dist + sep) && existsSync(file)) return route.fulfill({ contentType: types[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    if (url.pathname === "/usage-monitor") {
      reads += 1;
      if (url.searchParams.has("since_hours") && !url.searchParams.has("session_id")) allReads += 1;
      if (state === "loading") await new Promise<void>(resolve => releaseLoading.push(resolve));
      return route.fulfill({ json: { ok: true, data: monitor(url) } });
    }
    if (url.pathname === "/provider-quota") return route.fulfill({ json: { ok: true, data: planQuota() } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0,
      catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    return route.fulfill({ json: { ok: true, data: {} } });
  });
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const scenario of ["ready", "empty", "loading", "delegated"]) {
    releaseLoading.forEach(resolve => resolve()); releaseLoading = [];
    if (process.env.BUTLER_USAGE_WIDTH && width !== Number(process.env.BUTLER_USAGE_WIDTH)) continue;
    if (process.env.BUTLER_USAGE_STATE && scenario !== process.env.BUTLER_USAGE_STATE) continue;
    cells += 1;
    state = scenario;
    backendTitle = "Login form refactor";
    await page.setViewportSize({ width, height: 1000 });
    const locale = process.env.BUTLER_USAGE_LOCALE ?? "ko";
    await page.goto(`${base}/?visual=components&theme=${theme}&locale=${locale}&auth=${auth}`);
    const closeInspector = page.getByRole("button", { name: "오른쪽 패널 숨기기", exact: true }).first();
    if (await closeInspector.isVisible()) await closeInspector.click();
    await page.locator('[data-slot="composer-compact-preview"]').click();
    const trigger = page.locator('[data-test-class="context-donut-button"]');
    await trigger.click();
    const popover = page.locator('[data-test-class="context-popover"]');
    try { await popover.waitFor(); } catch (error) {
      if (shots) await page.screenshot({ path: join(shots, "popover-failure.png"), timeout: 5000 });
      console.error({ errors,  reads });
      throw error;
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const height = (await popover.boundingBox())!.height;
    const heightKey = `${width}/${theme}`;
    popoverHeights[`${heightKey}/${scenario}`] = Math.round(height * 10) / 10;
    if (scenario === "ready") heights.set(heightKey, height);
    if (!before && scenario === "loading" && heights.has(heightKey)) {
      const delta = Math.abs(height - heights.get(heightKey)!);
      heightDeltas.push(delta);
      assert(delta < 3, `loading popover height differs by ${delta}px`);
    }
    if (!before && scenario === "ready" && auth === "api_key") assert.match(await popover.innerText(), /(?:^|\s)\$0\.08/u);
    if (shots) await page.screenshot({ path: join(shots, `${before ? "before" : "after"}${auth === "subscription" ? "-subscription" : ""}-popover-${theme}-${width}-${scenario}.png`) });
    if (shots) await popover.screenshot({ path: join(shots, `crop-${before ? "before" : "after"}-${locale}-${theme}-${width}-${scenario}.png`) });
    const parts = popover.locator('[data-test-class="usage-parts"]');
    const popoverChart = popover.locator('[data-slot="usage-bars"]');
    if (!before && scenario !== "delegated") assert.equal(await parts.count(), 0, "no split without delegated usage");
    if (!before && scenario === "ready") chartHeights.set(heightKey, (await popoverChart.boundingBox())!.height);
    if (!before && scenario === "ready") assert.deepEqual(await assertBars(popoverChart, "popover ready"), [], "no hatch without delegated usage");
    if (scenario === "delegated") {
      if (!before) {
        // The same chat without its subtask values keeps the split rows but draws no hatch; the
        // split must not change the popover's height.
        const reopen = async () => {
          await page.keyboard.press("Escape"); await popover.waitFor({ state: "hidden" });
          await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/usage-monitor"), trigger.click()]);
          await popover.waitFor(); await page.waitForTimeout(400);
        };
        trimSlots = true; await reopen();
        assert.deepEqual(await assertBars(popoverChart, "popover without subtask values"), [], "trimmed slots draw no hatch");
        assert.equal(await parts.locator('[data-test-class="key-value-row"]').count(), 2, "trimmed slots keep the split rows");
        const solidHeight = (await popover.boundingBox())!.height;
        trimSlots = false; await reopen();
        const splitDelta = Math.abs((await popover.boundingBox())!.height - solidHeight);
        splitHeightDeltas.push(splitDelta);
        assert(splitDelta <= 2, `the split changes the popover height by ${splitDelta}px`);
        await assertNoTransformMotion(page, "popover live update");
        assert.equal(await parts.locator('[data-test-class="key-value-row"]').count(), 2);
        if (locale === "ko") assert.match(await parts.innerText(), /대화[\s\S]*5\.2만 · 53\.6%[\s\S]*하위 작업[\s\S]*4\.5만 · 46\.4%/u);
        await assertNoTransformMotion(page, "popover");
        assert.equal((await assertBars(popoverChart, "popover")).length, 3, "the first delegated hour splits all three types");
        if (chartHeights.has(heightKey)) {
          const chartDelta = Math.abs((await popoverChart.boundingBox())!.height - chartHeights.get(heightKey)!);
          assert(chartDelta <= 1, `the split keeps the popover chart height (${chartDelta}px)`);
        }
        await assertEmphasis(page, parts, popoverChart, "popover");
        await popoverChart.focus(); await page.keyboard.press("Home");
        if (locale === "ko") assert.match(await parts.innerText(), /2\.1만 · 32%[\s\S]*4\.5만 · 68%/u, "a selected bar splits its own total");
        await page.waitForTimeout(400);
        assert.equal(await parts.locator('[data-test-class="key-value-row"]').count(), 2, "selection keeps the split rows");
        assert.equal((await assertBars(popoverChart, "popover selected")).length, 3, "a selected bar keeps its subtask parts");
        const selectedDelta = Math.abs((await popover.boundingBox())!.height - height);
        heightDeltas.push(selectedDelta);
        assert(selectedDelta <= 2, `selecting a split bar keeps the popover height (${selectedDelta}px)`);
        if (shots) await popover.screenshot({ path: join(shots, `crop-after-${locale}-${theme}-${width}-delegated-selected.png`) });
      }
      if (before) { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); continue; }
      await page.keyboard.press("Escape");
      await popover.locator('[data-test-class="context-usage-details"]').click();
      await delegatedSettings(page, locale, `${theme}-${width}`);
      continue;
    }
    if (!before && scenario === "empty") assert.equal(await popover.locator('[data-test-class="usage-readout"]').count(), 0);
    if (auth === "subscription") {
      const plan = popover.locator('[data-test-class="chatgpt-plan-usage"]');
      await plan.getByText("버틀러 사용량", { exact: true }).waitFor();
      assert.equal(await plan.getByText("계정 한도", { exact: true }).count(), planState === "headers" ? 1 : 0);
      assert.equal(await plan.getByText("추정", { exact: true }).count(), planState === "headers" ? 2 : 0);
      assert.equal(await plan.getByRole("button", { name: "사용량 관리", exact: true }).count(), 1);
      assert.equal(await plan.getByText(/사용 한도 도달/u).count(), planState === "limit" ? 1 : 0);
      assert.equal(await plan.locator('[data-test-class="key-value-row"]').count(), 3);
    }
    if (!before && scenario === "ready") {
      const chart = popover.locator('[data-slot="usage-bars"]');
      assert.match(await popover.innerText(), /요청 3회/u);
      // Hover with focus still on the pinned donut: first Esc clears, second closes.
      assert(await trigger.evaluate(element => element === document.activeElement));
      await chart.locator(":scope > div").first().hover({ position: { x: 5, y: 5 } });
      assert.equal(await chart.getAttribute("data-selected"), "true");
      await page.keyboard.press("Escape");
      assert(await popover.isVisible());
      assert.equal(await chart.getAttribute("data-selected"), null);
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "hidden" });
      await trigger.click(); await popover.waitFor();
      await chart.focus(); await page.keyboard.press("End");
      assert.deepEqual((await probeFocusRing(page))?.clips, [], "popover chart focus ring");
      assert.match(await popover.innerText(), /요청 2회/u);
      assert(!((await popover.innerText()).includes("US$")), "bucket selection hides the cost");
      assert.equal(await chart.getAttribute("data-selected"), "true");
      await page.waitForTimeout(400);
      if (shots) await page.screenshot({ path: join(shots, `after${auth === "subscription" ? "-subscription" : ""}-popover-${theme}-${width}-selected.png`) });
      await page.keyboard.press("Escape"); assert(await popover.isVisible());
      assert.equal(await chart.getAttribute("data-selected"), null);
      const previous = reads; await page.waitForTimeout(200); assert.equal(reads, previous, "selection does not fetch");
    }
    await popover.getByRole("button", { name: "자세히", exact: true }).click();
    await page.locator('[data-settings-section-id="usage-overview"]').waitFor();
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: join(shots, `${before ? "before" : "after"}${auth === "subscription" ? "-subscription" : ""}-usage-${theme}-${width}-${scenario}.png`) });
    if (!before && scenario === "loading") {
      assert(await page.getByRole("tab", { name: "대화", exact: true }).isVisible(), "loading preserves breakdown tabs");
      assert(await page.getByRole("tabpanel").locator('[data-slot="skeleton-rows"]').isVisible(), "only breakdown rows load inside the tab panel");
    }
    if (!before && scenario === "ready") {
      const chart = page.locator('[data-slot="usage-bars"]'); await chart.focus(); await page.keyboard.press("End");
      assert.deepEqual((await probeFocusRing(page))?.clips, [], "panel chart focus ring");
      await page.waitForTimeout(400);
      if (shots) await page.screenshot({ path: join(shots, `after${auth === "subscription" ? "-subscription" : ""}-usage-${theme}-${width}-selected.png`) });
      await page.keyboard.press("Escape");
      await Promise.all([page.waitForResponse(r => new URL(r.url()).searchParams.get("since_hours") === "720"),
        page.getByRole("radio", { name: "30일", exact: true }).click()]);
      const headlineX = (await page.locator('[data-test-class="usage-readout"]').boundingBox())!.x;
      const rowXs: number[] = [];
      const rowHeights: number[] = [];
      for (const [tab, title] of [["대화", "Login form refactor"], ["모델", "openai/gpt-6-luna"], ["도구", "파일 읽기"]]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        const row = page.getByRole("tabpanel").getByText(title!, { exact: true });
        await row.waitFor();
        await page.waitForTimeout(400);
        rowXs.push((await row.boundingBox())!.x);
        rowHeights.push((await row.locator("xpath=../../..").boundingBox())!.height);
        if (shots && tab !== "대화") await page.screenshot({ path: join(shots, `after${auth === "subscription" ? "-subscription" : ""}-${tab === "모델" ? "models" : "tools"}-${theme}-${width}.png`) });
      }
      const deltas = rowXs.map(x => Math.abs(x - headlineX));
      alignmentDeltas.push(...deltas);
      assert(deltas.every(delta => delta < 3), `rows align with headline: ${deltas}`);
      assert(Math.max(...rowHeights) - Math.min(...rowHeights) < 3, "all breakdown tabs share vertical rhythm");
      await page.getByRole("tab", { name: "도구", exact: true }).click();
      await page.getByText("파일 읽기", { exact: true }).waitFor();
      await page.getByRole("tab", { name: "대화", exact: true }).click();
      assert.equal(await page.getByRole("tabpanel").getByRole("button", { name: /Review 8/u }).count(), 0);
      await page.getByRole("button", { name: "모두 보기 8개", exact: true }).click();
      const fullPicker = page.locator('[data-slot="filtered-select-popover"]');
      await fullPicker.getByRole("textbox", { name: "대화 검색" }).fill("Review 8");
      await Promise.all([page.waitForResponse(r => new URL(r.url()).searchParams.get("session_id") === "s8"), fullPicker.getByRole("button", { name: /Review 8/u }).click()]);
      await page.getByRole("tabpanel").getByRole("button", { name: /Review 8/u }).waitFor();
      const cachedReads = allReads;
      await page.getByRole("tabpanel").getByRole("button", { name: /Review 8/u }).click();
      await page.waitForTimeout(200); assert.equal(allReads, cachedReads, "returning to all uses the cached revision");
      await Promise.all([page.waitForResponse(r => new URL(r.url()).searchParams.get("session_id") === "s1"),
        page.getByRole("button", { name: /Login form refactor/u }).click()]);
      assert.equal(allReads, cachedReads, "chat switches reuse all-chat totals");
      const selectedChat = page.getByRole("tabpanel").getByRole("button", { name: /Login form refactor/u });
      await selectedChat.focus();
      await page.waitForTimeout(400);
      assert.equal(await selectedChat.getAttribute("aria-pressed"), "true");
      assert.equal(await selectedChat.getAttribute("data-selected"), "true");
      const fill = await selectedChat.evaluate(element => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--selection-strong)";
        element.append(probe);
        const expected = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { actual: getComputedStyle(element).backgroundColor, expected };
      });
      assert.notEqual(fill.actual, "rgba(0, 0, 0, 0)");
      assert.equal(fill.actual, fill.expected, "selected chat uses the strong selection fill");
      assert.deepEqual((await probeFocusRing(page))?.clips, [], "selected chat focus ring");
      if (shots) await page.screenshot({ path: join(shots, `after${auth === "subscription" ? "-subscription" : ""}-usage-${theme}-${width}-selected-chat.png`) });
      await page.getByRole("tabpanel").getByRole("button", { name: /Login form refactor/u }).click();
      await page.getByRole("button", { name: "대화", exact: true }).click();
      const picker = page.locator('[data-slot="filtered-select-popover"]');
      await picker.getByRole("textbox", { name: "대화 검색" }).fill("");
      assert.equal(await picker.locator('[data-slot="filtered-select-group-title"]').count(), 1);
      assert.equal(await picker.locator('[data-slot="filtered-select-group-title"]').innerText(), "사용량순");
      await page.waitForTimeout(400);
      if (shots) await page.screenshot({ path: join(shots, `after${auth === "subscription" ? "-subscription" : ""}-picker-${theme}-${width}.png`) });
      await picker.getByRole("textbox", { name: "대화 검색" }).fill("no matching title");
      await picker.getByText("일치하는 대화가 없습니다", { exact: true }).waitFor();
      await picker.getByRole("textbox", { name: "대화 검색" }).fill("");
      await picker.getByRole("button", { name: "예약 작업", exact: true }).click();
      assert.equal(await picker.getByRole("button", { name: /Login form refactor/u }).count(), 0);
      await picker.getByRole("textbox", { name: "대화 검색" }).fill("Daily");
      await picker.getByRole("button", { name: /Daily review/u }).waitFor();
      await page.keyboard.press("Escape");
      // Leave the usage mount, change the gateway response, and revisit through Details.
      backendTitle = "Updated backend conversation";
      if (width === 375) await page.getByRole("button", { name: "돌아가기", exact: true }).first().click();
      await page.locator('[data-test-class="settings-header settings-titlebar"]').getByRole("button", { name: "돌아가기", exact: true }).click();
      await page.locator('[data-slot="composer-compact-preview"]').click();
      await trigger.click();
      const revisitReads = allReads;
      await popover.getByRole("button", { name: "자세히", exact: true }).click();
      await page.getByRole("tabpanel").getByText(backendTitle, { exact: true }).waitFor();
      assert(allReads > revisitReads, "revisit fetches fresh all-chat data");
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, cells, reads, allReads, before, heightDeltas, alignmentDeltas, popoverHeights, splitHeightDeltas, maxGapDelta, maxShareDelta }));
} finally {
  // The last loading cell deliberately holds a route. Settle it before teardown.
  releaseLoading.forEach(resolve => resolve());
  await Promise.all(browser.contexts().flatMap(context => context.pages().map(page => page.unrouteAll({ behavior: "wait" }))));
  await browser.close();
}
