// Offline chat harness: one live line, DS motion, unchanged fallback and cleanup.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = ["light", "dark"];
if (await runSmokeCases(cases, "BUTLER_THINKING_CASE", import.meta.path)) process.exit(0);
const root = process.cwd();
const evidence = process.env.BUTLER_THINKING_EVIDENCE;
assert(evidence, "BUTLER_THINKING_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const theme of cases) {
    if (process.env.BUTLER_THINKING_CASE && process.env.BUTLER_THINKING_CASE !== theme) continue;
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
    await page.screenshot({ path: join(evidence, `thinking-before-${theme}.png`) });
    const receive = async (line: string | null) => page.evaluate(async line => {
      const path = "/src/app/modelThinking.ts";
      const { receiveModelThinking } = await import(/* @vite-ignore */ path);
      return receiveModelThinking({ type: "turn.thinking", payload: { session_id: "butler-client", turn_id: "thinking-turn", stream_id: "stream", line } });
    }, line);
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
    await page.screenshot({ path: join(evidence, `thinking-after-${theme}.png`) });
    await receive(null);
    await page.waitForFunction(() => document.querySelector('[data-test-class="turn-model-round-waiting"]')?.textContent?.startsWith("응답 생성 중"));
    assert.equal(await page.locator('[data-test-class="assistant-status-label"] [data-shimmer="true"]').count(), 1);
  }
  assert.deepEqual(errors, []);
  console.log("live thinking chat: fallback, line swap, tooltip, aria, shimmer and clear passed");
} finally { await browser.close(); await vite.close(); }
