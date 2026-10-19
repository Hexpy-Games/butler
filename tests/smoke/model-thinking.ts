// Offline chat harness: one live line, DS motion, unchanged fallback and cleanup.
import assert from "node:assert/strict";
import { probeThinkingReveal } from "../support/model-thinking-scroll";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, preview } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

declare global {
  interface Window {
    butlerThinkingHarness: {
      useButlerStore: typeof import("../../packages/butler-app/client/ui/src/app/store").useButlerStore;
      receiveModelThinking: typeof import("../../packages/butler-app/client/ui/src/app/modelThinking").receiveModelThinking;
    };
  }
}
const cases = ["light-desktop", "dark-desktop", "light-mobile", "dark-mobile"];
const root = process.env.BUTLER_THINKING_ROOT ?? process.cwd();
process.env.BUTLER_THINKING_ROOT = root;
const before = process.env.BUTLER_THINKING_PHASE === "before";
const baseline = process.env.BUTLER_THINKING_BASE;
assert(!before || baseline, "BUTLER_THINKING_BASE required for before captures");
const evidence = process.env.BUTLER_THINKING_EVIDENCE;
assert(evidence, "BUTLER_THINKING_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
process.chdir(join(root, "packages/butler-app/client/ui"));
const originals: Record<string, string> = {};
if (before) {
  const paths = execFileSync("git", ["diff", "--name-only", baseline!, "--", "packages/butler-app/client/ui/src", "packages/butler-i18n/src"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const path of paths.filter(path => /\.tsx?$/u.test(path))) {
    const exists = execFileSync("git", ["ls-tree", baseline!, "--", path], { cwd: root, encoding: "utf8" });
    if (exists) originals[join(root, path)] = execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
  }
}
const blur = async (page: import("playwright").Page) => page.evaluate(async () => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})));
});
const body = "**Planning the search**\nI will review the relevant sources.\n\n## Checking the results\nI am comparing the available evidence.";
const finalBody = body + "\nMore streamed content.\nFinal stored content.";
const firstTitle = "Reviewing the sources";
const now = new Date().toISOString();
const round = (id: string, stored = false) => ({ id, tool_call_id: id, turn_id: "thinking-turn", kind: "message", state: stored ? "delivered" : "running",
  bridge_phase: "model_round_waiting", safe_label: "응답 생성 중", created_at: now,
  ...(stored ? { thinking_title: id === "first" ? firstTitle : "Checking the results", tool_result_id: `result-${id}` } : {}) });
const operation = { id: "search", tool_call_id: "search", turn_id: "thinking-turn", kind: "used_tool", state: "delivered", bridge_phase: "btcc_operation",
  semantic_block_id: "tool-search", safe_tool_name: "web_search", safe_input_label: "공개 자료", safe_label: "검색", created_at: now };
const liveRows = [round("first", true), operation, round("second")];
let completed = false;
let outputFetches = 0;
const ownsOutput = !process.env.BUTLER_THINKING_BUNDLE;
const output = process.env.BUTLER_THINKING_BUNDLE ?? mkdtempSync(join(tmpdir(), "thinking-ui-"));
if (ownsOutput) await build({ plugins: [{ name: "thinking-harness", enforce: "pre", load(id) { return originals[id]; },
  transform(source, id) {
    if (!id.endsWith("/src/main.tsx")) return;
    return source + `\nimport { useButlerStore as thinkingStore } from "/src/app/store.ts";
${before ? "" : 'import { receiveModelThinking as thinkingReceive } from "/src/app/modelThinking.ts";'}
window.butlerThinkingHarness = { useButlerStore: thinkingStore, receiveModelThinking: ${before ? "() => false" : "thinkingReceive"} };`;
  } }], build: { outDir: output, emptyOutDir: true }, logLevel: "error" });
process.env.BUTLER_THINKING_BUNDLE = output;
try {
  if (await runSmokeCases(cases, "BUTLER_THINKING_CASE", import.meta.path)) {
    if (ownsOutput) rmSync(output, { recursive: true, force: true });
    process.exit(0);
  }
} catch (error) {
  if (ownsOutput) rmSync(output, { recursive: true, force: true });
  throw error;
}
const vite = await preview({ build: { outDir: output }, preview: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const revealResults: { cell: string; mode: string; userInteraction: boolean; scrollLeft: number }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = { messages: [{ id: "question", role: "user", text: "요청을 검토해 주세요.", chat_id: "butler-client", turn_id: "thinking-turn" },
        ...(completed ? [{ id: "answer", role: "assistant", text: "확인했습니다.", status: "delivered", chat_id: "butler-client", turn_id: "thinking-turn", turn_activity_rows: [round("first", true), operation, round("second", true)] }] : [])],
        settings: { show_thinking: completed }, background: "plain" };
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0,
      catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "medium", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname.includes("/operations/") && url.pathname.endsWith("/output")) {
      outputFetches++;
      const content = url.pathname.includes("/operations/first/") ? `**${firstTitle}**\n\nThe sources are ready.` : finalBody;
      return route.fulfill({ json: { ok: true, data: { content, byte_end: content.length, byte_length: content.length, complete: true } } });
    }
    if (url.pathname === "/personalization") return route.fulfill({ json: { ok: true, data: { persona: "", eol: "", persona_presets: [] } } });
    if (url.pathname === "/settings" && route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, data: patch } });
    }
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const cell of cases) {
    if (process.env.BUTLER_THINKING_CASE && process.env.BUTLER_THINKING_CASE !== cell) continue;
    const theme = cell.split("-")[0];
    const capture = async (stage: string) => {
      await blur(page);
      const geometry = await page.locator("[data-panel-layout]").evaluate(element => ({
        scrollLeft: element.scrollLeft, inspectorOpen: element.getAttribute("data-right-open"),
        width: element.clientWidth, viewport: innerWidth,
        workspaceLeft: element.querySelector('[data-slot="adaptive-shell-workspace"]')!.getBoundingClientRect().left,
      }));
      assert.deepEqual(geometry, { scrollLeft: 0, inspectorOpen: "false", width: geometry.viewport, viewport: geometry.viewport, workspaceLeft: 0 });
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "capture without keyboard focus");
      await page.screenshot({ path: join(evidence, `${stage}-${cell}.png`) });
    };
    await page.setViewportSize({ width: cell.endsWith("mobile") ? 390 : 1440, height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="message"]').first().waitFor();
    if (completed) { completed = false; await page.reload(); }
    await page.evaluate(async rows => {
      const { useButlerStore } = window.butlerThinkingHarness;
      const progress = { turn_id: "thinking-turn", state: "running", started_at: rows[0].created_at, safe_progress_rows: rows };
      const state = useButlerStore.getState();
      state.setSummary({ ...state.summary, turn_state: "running", latest_progress: progress });
      state.setTurnProgress({ "thinking-turn": progress });
    }, liveRows);
    const status = page.locator('[data-test-class="turn-model-round-waiting"]');
    await status.waitFor();
    const statusAria = await status.getAttribute("aria-label");
    assert((await status.innerText()).startsWith("응답 생성 중"));
    const receive = async (line: string | null, summary?: string) => page.evaluate(async payload => {
      const { receiveModelThinking } = window.butlerThinkingHarness;
      receiveModelThinking({ type: "turn.thinking", payload: { turn_id: "thinking-turn", round_id: "second", stream_id: "stream", ...payload } });
    }, { line, summary });
    const expandTimeline = async () => {
      const button = page.locator('[data-test-class="toggle-turn-activity-disclosure"]').first();
      if (await button.getAttribute("aria-expanded") !== "true") await button.click();
    };
    await expandTimeline();
    if (before) {
      await blur(page);
      await capture("baseline");
      continue;
    }
    await receive("Planning the search");
    await page.locator('[data-slot="rolling-swap"] [data-motion="incoming"]').waitFor();
    await blur(page);
    assert((await status.innerText()).startsWith("Planning the search"));
    assert.equal(await status.getAttribute("aria-label"), statusAria);
    assert.equal(await page.locator('[data-test-class="turn-current-status-slot"]').getAttribute("title"), "Planning the search");
    assert.equal(await page.locator('[data-test-class="assistant-status-label"] [data-shimmer="true"]').count(), 0);
    assert.equal(await page.getByRole("button", { name: "생각 요약" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /생각/u }).count(), 0);
    assert.equal(outputFetches, 0);
    await capture("live-off");
    await page.evaluate(async () => {
      const { useButlerStore } = window.butlerThinkingHarness;
      const state = useButlerStore.getState(); state.setSettings({ ...state.settings, show_thinking: true });
    });
    await receive("Planning the search", body);
    const group = page.getByRole("button", { name: "2 생각, 1 검색", exact: true });
    const thinking = page.getByRole("button", { name: "Planning the search", exact: true });
    for (const result of await probeThinkingReveal(page, group, thinking, evidence, cell)) revealResults.push({ cell, ...result });
    await group.click();
    await blur(page);
    await thinking.click();
    await page.locator('[data-test-class="thinking-details"]').waitFor();
    assert.equal(outputFetches, 0, "live body must not fetch");
    await receive("Checking the results", body + "\nMore streamed content.");
    await blur(page);
    assert.equal(await page.getByRole("button", { name: "Checking the results", exact: true }).count(), 1);
    assert((await page.locator('[data-test-class="thinking-details"]').innerText()).includes("More streamed content."));
    const order = await page.locator('[data-test-class="turn-work-tool-detail-row"]').allTextContents();
    assert(order[0].includes(firstTitle) && order[1].includes("공개 자료") && order[2].includes("Checking the results"));
    await capture("live-on-expanded");
    await receive(null);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    assert((await status.innerText()).startsWith("응답 생성 중"));
    assert.equal(await page.locator('[data-slot="rolling-swap"] [data-motion="incoming"]').count(), 0);
    assert.equal(await page.locator('[data-test-class="assistant-status-label"] [data-shimmer="true"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: "Checking the results", exact: true }).count(), 1, "freeze until durable completion");
    await page.evaluate(rows => {
      const state = window.butlerThinkingHarness.useButlerStore.getState();
      const progress = { turn_id: "thinking-turn", state: "running", safe_progress_rows: rows };
      state.setTurnProgress({ "thinking-turn": progress });
    }, [round("first", true), operation, round("second", true)]);
    await page.waitForFunction(() => document.querySelector('[data-test-class="thinking-details"]')?.textContent?.includes("Final stored content."));
    assert.equal(outputFetches, 1, "open live row loads its completed body without remounting");
    assert.equal(await page.getByRole("button", { name: "Checking the results", exact: true }).last().getAttribute("aria-expanded"), "true");
    outputFetches = 0;
    completed = true;
    await page.reload();
    await page.evaluate(() => {
      const state = window.butlerThinkingHarness.useButlerStore.getState();
      state.setTurnProgress({});
      state.setSummary({ ...state.summary!, turn_state: "delivered", latest_progress: undefined });
    });
    await page.getByText("확인했습니다.", { exact: true }).waitFor();
    await expandTimeline();
    const pastGroup = page.getByRole("button", { name: "2 생각, 1 검색", exact: true });
    await pastGroup.click();
    await blur(page);
    assert.equal(outputFetches, 0, "history bodies stay lazy");
    await page.getByRole("button", { name: "Checking the results", exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector('[data-test-class="thinking-details"]')?.textContent?.includes("comparing the available evidence"));
    assert.equal(outputFetches, 1);
    await blur(page);
    await capture("history-on-expanded");
    await page.evaluate(async () => {
      const { useButlerStore } = window.butlerThinkingHarness;
      const state = useButlerStore.getState(); state.setSettings({ ...state.settings, show_thinking: false });
    });
    assert.equal(await page.getByRole("button", { name: "Checking the results", exact: true }).count(), 0);
    await page.evaluate(() => {
      const state = window.butlerThinkingHarness.useButlerStore.getState();
      state.setSettings({ ...state.settings, show_thinking: true });
      state.openSettings("appearance");
    });
    const setting = page.locator('[data-settings-section-id="conversation"]').getByRole("switch", { name: "생각 내용 표시" });
    await setting.waitFor();
    assert.equal(await setting.getAttribute("aria-checked"), "true");
    await setting.click();
    await page.waitForFunction(id => document.getElementById(id!)?.getAttribute("aria-checked") === "false", await setting.getAttribute("id"));
    await setting.click();
    await page.waitForFunction(id => document.getElementById(id!)?.getAttribute("aria-checked") === "true", await setting.getAttribute("id"));
    outputFetches = 0;
  }
  const { readdirSync } = await import("node:fs");
  writeFileSync(join(evidence, "model-thinking-paths.txt"), readdirSync(evidence).filter(path => path.endsWith(".png")).sort().map(path => join(evidence, path)).join("\n") + "\n");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ revealResults }));
  assert.deepEqual(revealResults.filter(result => result.userInteraction && result.scrollLeft !== 0), [], "pointer and keyboard interaction must not scroll the shell");
  console.log("thinking timeline: OFF, rolling title, streaming body, ordered rows, freeze, reload, lazy fetch and privacy toggle passed");
} finally { await browser.close(); await new Promise<void>((resolve, reject) => vite.httpServer.close(error => error ? reject(error) : resolve())); if (ownsOutput) rmSync(output, { recursive: true, force: true }); }
