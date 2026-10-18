// Settings › 로그 › 메시지 추적 against an isolated native gateway whose model
// answers 429 (the send fails) and then 200. Opens the real trace from the
// failed message's 로그 보기, the answer's overflow menu, Cmd+K 로그 열기 and a
// log row's 메시지 전체 보기, and the D5 fixture trace for the full row shapes.
// The renderer's traceparent must name the trace the agent recorded. No
// model provider calls leave the machine.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page, Request } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding";
import { auditTabOrder, formatClips } from "../support/focus-ring-clipping";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";
import { spanPieces } from "../../packages/butler-app/client/ui/src/libs/design-system/blocks/SpanBar/spanGeometry";
import { FIXTURE_TRACE_ID, fixtureTrace, fixtureTraceRow } from "./settings-trace-fixture";

const cases = ["1280-light", "1280-dark", "390-light", "390-dark"];
if (await runSmokeCases(cases, "BUTLER_TRACE_CASE", import.meta.path)) process.exit(0);
const selected = process.env.BUTLER_TRACE_CASE;
const shots = resolve(process.env.BUTLER_TRACE_SHOTS ?? ".tmp/settings-trace");
mkdirSync(shots, { recursive: true });
const copy = getAppCopy("ko-KR");
const trace = copy.settings.logs.trace;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/u;
type ApiSpan = {
  span_id: string; parent_span_id: string | null; name: string; status: string; tone: string;
  start_offset_ms: number; duration_ms: number | null;
};
type ApiTrace = { trace_id: string; outcome: string; duration_ms: number; spans: ApiSpan[] };

/** OpenAI-compatible model: 429 while `failing`, else one streamed answer. */
async function startModel(): Promise<{ server: Server; port: number; failing: { value: boolean } }> {
  const failing = { value: true };
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "stub", object: "model" }] }));
      return;
    }
    if (failing.value) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Smoke rate limit", code: "RESOURCE_EXHAUSTED" } }));
      return;
    }
    const base = { id: "smoke", object: "chat.completion.chunk", created: 1, model: "stub" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Smoke answer." } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as { port: number }).port, failing };
}

async function routeFixture(page: Page) {
  await page.route((url) => url.pathname === `/logs/trace/${FIXTURE_TRACE_ID}`, (route) => route.fulfill({
    json: { protocol_version: "butler.app.v1", data: fixtureTrace() },
  }));
  await page.route((url) => url.pathname === "/logs", async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ headers: { ...route.request().headers(), origin: url.origin } });
    const payload = await response.json() as { data?: { rows: unknown[] } };
    const plain = !url.searchParams.has("cursor") && !url.searchParams.has("q") && !url.searchParams.has("trace_id");
    if (response.ok() && payload.data && plain) payload.data.rows = [fixtureTraceRow(), ...payload.data.rows];
    await route.fulfill({ response, json: payload });
  });
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no page overflow`);
  await page.screenshot({ path: resolve(shots, `${name}.png`), animations: "allow", timeout: 10_000 });
  await page.mouse.move(0, 0);
}

async function newPage(browser: Browser, server: NativeAppServerHandle, width: number, theme: "light" | "dark") {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ko-KR", colorScheme: theme });
  await server.signIn(context);
  const page = await context.newPage();
  const errors: string[] = [];
  const actions: Request[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/messages") actions.push(request);
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: LEGACY_FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await routeFixture(page);
  await page.goto(server.url);
  await page.locator('[data-test-class~="composer-card"]').waitFor();
  return { page, errors, actions, close: async () => { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close(); } };
}

async function send(page: Page, text: string) {
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await editor.fill(text);
  await page.locator('[data-test-class~="composer-card"]').getByRole("button", { name: copy.composer.send, exact: true }).click();
}

const steps = (page: Page) => page.locator('[data-test-class="trace-step"]');
const stepRow = (page: Page, id: string) => page.locator(`[data-test-class="trace-step"][data-span-id="${id}"]`);

/** Opens 메시지 추적 with `open` and returns the trace the page loaded. */
async function openTrace(page: Page, open: () => Promise<void>): Promise<ApiTrace> {
  const response = page.waitForResponse((answer) => new URL(answer.url()).pathname.startsWith("/logs/trace"));
  await open();
  const answer = await response.catch(async (error: unknown) => {
    await page.screenshot({ path: resolve(shots, "failure-open-trace.png") }).catch(() => undefined);
    throw error;
  });
  assert.equal(answer.status(), 200, `trace read: ${await answer.text()}`);
  const loaded = (await answer.json() as { data: ApiTrace }).data;
  await page.locator('[data-test-class="logs-trace-nav"]').getByText(trace.title, { exact: true }).waitFor();
  await steps(page).first().waitFor();
  return loaded;
}

/** The bar a span should draw: its direct children as segments, its own tone in the time they leave uncovered. */
function expectedPieces(loaded: ApiTrace, span: ApiSpan) {
  const total = Math.max(loaded.duration_ms, ...loaded.spans.map((item) => item.start_offset_ms + (item.duration_ms ?? 0)), 0);
  const place = (item: ApiSpan) => {
    const offset = Math.max(0, item.start_offset_ms);
    return { offset, duration: item.duration_ms === null ? Math.max(0, total - offset) : Math.max(0, item.duration_ms), tone: item.tone };
  };
  const own = place(span);
  const children = loaded.spans.filter((item) => item.parent_span_id === span.span_id).map(place);
  return spanPieces(own.offset, own.duration, own.tone, children);
}

/** Every visible row against the API: (N) and bar segments = direct children; dots only on error/wait rows; static rows. */
async function rowChecks(page: Page, loaded: ApiTrace) {
  const children = (id: string) => loaded.spans.filter((span) => span.parent_span_id === id).length;
  for (const row of await steps(page).all()) {
    const id = await row.getAttribute("data-span-id");
    const span = loaded.spans.find((candidate) => candidate.span_id === id);
    assert(span, `row ${id} is a span of the trace`);
    const count = children(span.span_id);
    const title = await row.locator('[data-slot="disclosure-row-title"]').first().locator("xpath=..").innerText();
    if (count > 0) assert(title.includes(`(${count})`), `${span.name}: (${count}) after the title: ${title}`);
    else assert(!/\(\d+\)/u.test(title), `${span.name}: no count on a leaf`);
    const drawn = await row.locator('[data-slot="span-bar"] [style*="--piece-start"]').evaluateAll((nodes) => nodes.map((node) => ({
      tone: node.getAttribute("data-tone"), start: Number.parseFloat((node as HTMLElement).style.getPropertyValue("--piece-start")),
    })));
    const expected = expectedPieces(loaded, span);
    assert.deepEqual(drawn.map((piece) => piece.tone), expected.map((piece) => piece.tone), `${span.name}: one segment per direct child`);
    drawn.forEach((piece, index) => assert(Math.abs(piece.start - expected[index]!.start * 100) < 0.01, `${span.name}: segment ${index} placed`));
    // Each direct child starts its own segment (턴 실행 (N): N segments). Overlapping
    // siblings share time, which the bar cuts at the earlier child's end, so only
    // children clear of their siblings are counted one by one.
    const own = loaded.spans.find((item) => item.span_id === span.span_id)!;
    const length = own.duration_ms ?? 0;
    const end = (item: ApiSpan) => item.start_offset_ms + (item.duration_ms ?? 0);
    const siblings = loaded.spans.filter((item) => item.parent_span_id === span.span_id);
    const starts = siblings.filter((item) => (item.duration_ms ?? 0) > 0 && length > 0
      && item.start_offset_ms >= own.start_offset_ms && end(item) <= own.start_offset_ms + length
      && !siblings.some((other) => other !== item && other.start_offset_ms < end(item) && item.start_offset_ms < end(other)));
    const childSegments = starts.filter((child) => drawn.some((piece) =>
      Math.abs(piece.start - ((child.start_offset_ms - own.start_offset_ms) / length) * 100) < 0.01)).length;
    assert.equal(childSegments, starts.length, `${span.name}: one segment per direct child (${starts.length}): ${JSON.stringify({
      drawn, own: [own.start_offset_ms, own.duration_ms], children: starts.map((child) => [child.start_offset_ms, child.duration_ms]) })}`);
    const dot = await row.locator('span[aria-hidden="true"]:has(+ [data-slot="disclosure-row-title"])').count();
    assert.equal(dot, ["error", "wait", "warn"].includes(span.status) ? 1 : 0, `${span.name} (${span.status}): dot only on problem rows`);
    if (await row.locator('[data-static="true"]').count()) {
      assert.equal(await row.getByRole("button").count(), 0, `${span.name}: a static row is no button`);
      assert.equal(await row.locator("[tabindex]").count(), 0, `${span.name}: a static row takes no focus`);
    }
    const depth = Number(await row.getAttribute("data-depth"));
    if (depth > 3) await row.getByText(new RegExp(trace.depth(depth), "u")).waitFor();
  }
}

/** The first (innermost) error row is open with its details. */
async function firstErrorOpen(page: Page, loaded: ApiTrace) {
  // In display order (each parent before its subtree), as the page shows them.
  const shown = await steps(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-span-id")));
  const error = shown.map((id) => loaded.spans.find((span) => span.span_id === id)!).find((span) => span.status === "error"
    && !loaded.spans.some((child) => child.parent_span_id === span.span_id && child.status === "error"));
  assert(error, "the trace shows an error");
  const row = stepRow(page, error.span_id);
  await row.waitFor();
  assert.equal(await row.locator('[aria-expanded="true"]').count(), 1, `${error.name}: the first error opens`);
}

async function realTraceChecks(page: Page, actions: Request[], cell: string) {
  const notice = page.locator(".failure-notice");
  const viewLogs = notice.getByRole("button", { name: trace.viewLogs, exact: true });
  await viewLogs.waitFor();
  assert.equal(actions.length, 1, "one send");
  const traceparent = await actions[0]!.headerValue("traceparent");
  assert.match(traceparent ?? "", TRACEPARENT, "send carries a W3C traceparent");
  await capture(page, `${cell}-failed-message`);
  const loaded = await openTrace(page, () => viewLogs.click());
  assert.equal(loaded.outcome, "error", "the failed send's trace failed");
  await page.locator('[data-test-class="trace-result"]').getByText(trace.outcome.error, { exact: true }).waitFor();
  const copyId = await page.getByRole("button", { name: trace.copyId, exact: true }).boundingBox();
  const card = await page.locator('[data-settings-section-id="trace-summary"]').boundingBox();
  assert(copyId && card && copyId.x + copyId.width <= card.x + card.width, "the trace ID and its copy button stay inside the card");
  await rowChecks(page, loaded);
  await firstErrorOpen(page, loaded);
  await page.locator('[data-settings-section-id="trace-steps"]').getByRole("tab", { name: copy.settings.logs.tabs.request, exact: true }).first().waitFor();
  await capture(page, `${cell}-trace-real`);
  return { loaded, sentTraceId: TRACEPARENT.exec(traceparent!)![1]! };
}

/** D5: 턴 실행 (8) with eight pieces, 429 · 대기 · 200 tags, depth cues past three levels. */
async function fixtureChecks(page: Page, cell: string) {
  await page.locator('[data-test-class="logs-trace-nav"]').getByRole("button", { name: copy.settings.sections.logs, exact: true }).click();
  const row = page.locator('[data-test-class="log-row"]').filter({ has: page.getByText("Smoke traced row", { exact: true }) });
  await row.getByRole("button", { expanded: false }).click();
  const loaded = await openTrace(page, () => row.getByRole("button", { name: trace.viewWhole, exact: true }).click());
  assert.equal(loaded.trace_id, FIXTURE_TRACE_ID);
  const turn = steps(page).filter({ has: page.getByText(trace.steps["turn.run"], { exact: true }) }).first();
  assert.match(await turn.innerText(), /\(8\)/u, "턴 실행 (8)");
  for (const tag of ["429", trace.wait, "200"]) await page.locator('[data-settings-section-id="trace-steps"]').getByText(tag, { exact: true }).first().waitFor();
  await page.getByText(`${trace.outcome.ok}`, { exact: false }).first().waitFor();
  await page.getByText(trace.retries(1), { exact: false }).first().waitFor();
  await rowChecks(page, loaded);
  await firstErrorOpen(page, loaded);
  await capture(page, `${cell}-trace-d5`);
  // Down to the MCP request: depth 4 and 5 show their depth instead of indenting further.
  for (const name of [`${trace.steps["tool.call"]} · ask_researcher`, trace.steps["turn.run"], `${trace.steps["tool.call"]} · docs.search`,
    `${trace.steps["mcp.call"]} · tools/call`]) {
    const target = steps(page).filter({ has: page.getByText(name, { exact: true }) }).last();
    if ((await target.locator('[aria-expanded="false"]').count()) > 0) await target.locator('[aria-expanded="false"]').first().click();
  }
  await page.getByText(new RegExp(trace.depth(5), "u")).first().waitFor();
  await rowChecks(page, loaded);
  await capture(page, `${cell}-trace-d5-deep`);
}

async function entryChecks(page: Page, server: NativeAppServerHandle, failing: { value: boolean }, sentTraceId: string) {
  // A log row of the send leads to the same trace the renderer named in its traceparent.
  await page.locator('[data-test-class="logs-trace-nav"]').getByRole("button", { name: copy.settings.sections.logs, exact: true }).click();
  const access = page.locator('[data-test-class="log-row"]').filter({ has: page.getByText(/^POST \/messages · 202$/u) }).first();
  await access.getByRole("button", { expanded: false }).click();
  const joined = await openTrace(page, () => access.getByRole("button", { name: trace.viewWhole, exact: true }).click());
  assert.equal(joined.trace_id, sentTraceId, "App request and agent work share the renderer's trace");
  await page.keyboard.press("Escape");
  failing.value = false;
  await send(page, "Trace smoke answer");
  await page.getByText("Smoke answer.", { exact: true }).waitFor();
  const menu = page.getByRole("button", { name: copy.common.more, exact: true }).last();
  await menu.click();
  await openTrace(page, () => page.getByRole("menuitem", { name: trace.viewLogs }).click());
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: copy.commandPalette.label });
  await dialog.getByRole("combobox").fill(trace.openCommand);
  const latest = await openTrace(page, () => dialog.getByRole("option").filter({ has: page.getByText(trace.openCommand, { exact: true }) }).first().click());
  assert.equal(latest.outcome, "ok", "로그 열기 opens the latest turn");
  const audit = await auditTabOrder(page, { maxStops: 30, within: '[data-settings-section-id^="trace-"]' });
  assert(audit.stops > 2, `focus reaches the trace rows (${audit.visited.join(", ")})`);
  assert.equal(audit.clipped.length, 0, `trace focus rings are whole\n${formatClips(audit.clipped)}`);
  assert.deepEqual(audit.unmarked, [], "every trace stop shows a focus ring");
  assert.equal(server.stubModelCalls.length, 0, "the isolated stub model is not used");
}

async function runCase(cell: string) {
  const [widthText, theme] = cell.split("-") as [string, "light" | "dark"];
  const model = await startModel();
  const server = await createNativeAppServer({
    uiRoot: resolve("packages/butler-app/client/ui/dist"),
    config: { models: { local: [{ model_id: "stub", display_name: "Stub", server_url: `http://127.0.0.1:${model.port}`, context_window_tokens: 128000 }] } },
  });
  const browser = await launchSmokeBrowser();
  try {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    const off = await newPage(browser, server, Number(widthText), theme);
    await send(off.page, "Trace smoke failure off");
    await off.page.locator(".failure-notice").waitFor();
    assert.equal(await off.page.getByRole("button", { name: trace.viewLogs, exact: true }).count(), 0, "로그 보기 needs developer mode");
    await capture(off.page, `${cell}-failed-message-developer-off`);
    await off.close();
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ diagnostics_enabled: true }) });
    const { page, errors, actions, close } = await newPage(browser, server, Number(widthText), theme);
    await send(page, "Trace smoke failure");
    const { sentTraceId } = await realTraceChecks(page, actions, cell);
    await fixtureChecks(page, cell);
    if (cell === "1280-light") await entryChecks(page, server, model.failing, sentTraceId);
    assert.deepEqual(errors, [], "no renderer errors");
    await close();
  } finally {
    await browser.close();
    await server.stop();
    // The gateway may still hold keep-alive connections to the model.
    model.server.closeAllConnections();
    await new Promise<void>((done) => model.server.close(() => done()));
  }
}

if (selected) {
  await runCase(selected);
  writeFileSync(resolve(shots, `manifest-${selected}.json`), `${JSON.stringify({ cases: [selected] }, null, 2)}\n`);
} else {
  // One process per case: run in one Bun process, the third case's page stalled (no response, no screenshot).
  for (const cell of cases) {
    const child = spawnSync(process.execPath, [import.meta.path], { stdio: "inherit", env: { ...process.env, BUTLER_TRACE_CASE: cell } });
    assert.equal(child.status, 0, `Smoke case ${cell} failed`);
  }
}
console.log(JSON.stringify({ ok: true, cases: selected ? [selected] : cases }));

