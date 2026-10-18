// Offline chat harness: one live line, DS motion, unchanged fallback and cleanup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = ["light-desktop", "dark-desktop", "light-mobile", "dark-mobile"];
if (await runSmokeCases(cases, "BUTLER_THINKING_CASE", import.meta.path)) process.exit(0);
const root = process.cwd();
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
const blur = async (page: import("playwright").Page) => page.evaluate(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  // Restore the capture frame after Playwright scrolls a control into view.
  for (const element of document.querySelectorAll("*")) {
    if (element.scrollLeft) element.scrollTo({ left: 0, behavior: "instant" });
  }
});
const vite = await createServer({ plugins: [{ name: "thinking-before", enforce: "pre", load(id) { return originals[id]; } }], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = { messages: [{ id: "question", role: "user", text: "요청을 검토해 주세요.", chat_id: "butler-client", turn_id: "thinking-turn" }], background: "plain" };
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0,
      catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "medium", access_mode: "full_access", plan_mode: false } } } });
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
    await page.setViewportSize({ width: cell.endsWith("mobile") ? 390 : 1440, height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="message"]').first().waitFor();
    await page.evaluate(async () => {
      const path = "/src/app/store.ts";
      const { useButlerStore } = await import(/* @vite-ignore */ path);
      const now = new Date().toISOString();
      const progress = { turn_id: "thinking-turn", state: "running", started_at: now, safe_progress_rows: [{ id: "round", kind: "message", state: "running",
        turn_id: "thinking-turn", safe_label: "응답 생성 중", bridge_phase: "model_round_waiting", created_at: now }] };
      const state = useButlerStore.getState();
      state.setSummary({ ...state.summary, turn_state: "running", latest_progress: progress });
      state.setTurnProgress({ "thinking-turn": progress });
    });
    const status = page.locator('[data-test-class="turn-model-round-waiting"]');
    await status.waitFor();
    const aria = await status.getAttribute("aria-label");
    assert((await status.innerText()).startsWith("응답 생성 중"));
    await blur(page);
    if (before) await page.screenshot({ path: join(evidence, `before-chat-${cell}.png`) });
    const receive = async (line: string | null) => page.evaluate(async line => {
      const path = "/src/app/modelThinking.ts";
      const { receiveModelThinking } = await import(/* @vite-ignore */ path);
      if (line === null) {
        const parent = document.querySelector('[data-test-class="thinking-summary"]')?.parentElement;
        if (parent) {
          const observer = new MutationObserver(() => {
            if (parent.dataset.state === "closed") {
              document.documentElement.dataset.thinkingExit = "closed";
              observer.disconnect();
            }
          });
          observer.observe(parent, { attributes: true, attributeFilter: ["data-state"] });
        }
      }
      return receiveModelThinking({ type: "turn.thinking", payload: { session_id: "butler-client", turn_id: "thinking-turn", stream_id: "stream", line } });
    }, line);
    if (!before) {
      assert(await receive("Planning the search"));
      await page.locator('[data-slot="rolling-swap"] [data-motion="incoming"]').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-slot="rolling-swap"] [data-motion="incoming"]'));
      await page.waitForFunction(() => document.querySelector('[data-test-class="turn-model-round-waiting"]')?.textContent?.startsWith("Planning the search"));
      assert.equal(await status.getAttribute("aria-label"), aria);
      assert.equal(await page.locator('[data-test-class="turn-current-status-slot"]').getAttribute("title"), "Planning the search");
      assert.equal(await page.locator('[data-test-class="assistant-status-label"] [data-shimmer="true"]').count(), 0);
      await receive("Checking the results");
      await page.locator('[data-slot="rolling-swap"] [data-motion="incoming"]').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-slot="rolling-swap"] [data-motion="incoming"]'));
      assert.equal(await page.getByRole("button", { name: "생각 요약" }).count(), 0);
      await blur(page);
      await page.screenshot({ path: join(evidence, `after-a-chat-${cell}.png`) });
      await page.evaluate(async () => {
        const storePath = "/src/app/store.ts", thinkingPath = "/src/app/modelThinking.ts";
        const { useButlerStore } = await import(/* @vite-ignore */ storePath);
        const { receiveModelThinking } = await import(/* @vite-ignore */ thinkingPath);
        const state = useButlerStore.getState();
        state.setSettings({ ...state.settings, show_thinking: true });
        receiveModelThinking({ type: "turn.thinking", payload: { turn_id: "thinking-turn", stream_id: "stream", line: "Checking the results",
          summary: "**Planning the search**\nI will review the relevant sources.\n\n## Checking the results\nI am comparing the available evidence." } });
      });
      const disclosure = page.getByRole("button", { name: "생각 요약" });
      await disclosure.click();
      assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
      const content = page.locator('[data-test-class="thinking-summary-content"]');
      await content.waitFor();
      assert((await content.innerText()).includes("I am comparing the available evidence."));
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
          .map(animation => animation.finished.catch(() => {})));
      });
      await page.locator('[data-test-class="thinking-summary"]').evaluate(async element => {
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      const latest = page.getByRole("button", { name: "최신 메시지와 입력창으로 이동" });
      if (await latest.isVisible()) await latest.click();
      await latest.waitFor({ state: "hidden" });
      await blur(page);
      await page.screenshot({ path: join(evidence, `after-b-chat-${cell}.png`) });
      await receive(null);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      assert((await status.innerText()).startsWith("응답 생성 중"));
      assert.equal(await page.locator('[data-slot="rolling-swap"] [data-motion="incoming"]').count(), 0);
      await page.screenshot({ path: join(evidence, `after-clear-chat-${cell}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.thinkingExit), "closed");
      await disclosure.waitFor({ state: "detached" });
    }
    await page.waitForFunction(() => document.querySelector('[data-test-class="turn-model-round-waiting"]')?.textContent?.startsWith("응답 생성 중"));
    assert.equal(await page.locator('[data-test-class="assistant-status-label"] [data-shimmer="true"]').count(), 1);
    await page.evaluate(async () => {
      const path = "/src/app/store.ts";
      const { useButlerStore } = await import(/* @vite-ignore */ path);
      useButlerStore.getState().openSettings("appearance");
    });
    const conversation = page.locator('[data-settings-section-id="conversation"]');
    await conversation.waitFor();
    await conversation.scrollIntoViewIfNeeded();
    const setting = conversation.getByRole("switch", { name: "생각 내용 표시" });
    if (!before) {
      await setting.waitFor();
      assert.equal(await setting.getAttribute("aria-checked"), "true");
      await setting.click();
      await page.waitForFunction(id => document.getElementById(id!)?.getAttribute("aria-checked") === "false", await setting.getAttribute("id"), { timeout: 10_000 });
      await setting.click();
      await page.waitForFunction(id => document.getElementById(id!)?.getAttribute("aria-checked") === "true", await setting.getAttribute("id"), { timeout: 10_000 });
      await page.getByText("저장됨", { exact: true }).waitFor({ state: "hidden" });
    } else assert.equal(await setting.count(), 0);
    await conversation.locator('[data-slot="form-section-header"]').evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
    await blur(page);
    await page.screenshot({ path: join(evidence, `${process.env.BUTLER_THINKING_PHASE ?? "after"}-settings-${cell}.png`) });
  }
  writeFileSync(join(evidence, "model-thinking-paths.txt"), ["before-chat", "after-a-chat", "after-b-chat", "after-clear-chat", "before-settings", "after-settings"].flatMap(prefix => cases.map(cell => join(evidence, `${prefix}-${cell}.png`))).join("\n") + "\n");
  assert.deepEqual(errors, []);
  console.log("live thinking chat: fallback, line swap, tooltip, aria, shimmer and clear passed");
} finally { await browser.close(); await vite.close(); }
