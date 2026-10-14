// UI harness: frame-by-frame draft anchoring through the production conversation.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = [1440, 390].flatMap(width => ["light", "dark"].flatMap(theme => ["short", "long"].flatMap(length => ["bottom", "up"].map(position => `${width}-${theme}-${length}-${position}`))));
if (await runSmokeCases(cases, "BUTLER_SCROLL_CASE", import.meta.path)) process.exit(0);
const evidence = process.env.BUTLER_ANSWER_EVIDENCE;
assert(evidence, "BUTLER_ANSWER_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
process.chdir(join(process.cwd(), "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const results: unknown[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let length = "short", scrolledUp = false;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const history = length === "long" ? Array.from({ length: 60 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? "assistant" : "user", text: `Message ${i}. `.repeat(20), chat_id: "butler-client", status: "delivered" })) : [];
      const fixture = { messages: [...history, { id: "question", role: "user", text: scrolledUp && length === "short" ? "Compare the options. ".repeat(500) : "Compare the options.", chat_id: "butler-client", turn_id: "scroll-turn" }], background: "plain" };
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const cell of cases) {
    if (process.env.BUTLER_SCROLL_CASE && process.env.BUTLER_SCROLL_CASE !== cell) continue;
    const [width, theme, size, position] = cell.split("-"); length = size; scrolledUp = position === "up";
    await page.setViewportSize({ width: Number(width), height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="message"]').first().waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      const path = "/src/app/store.ts";
      const { useButlerStore } = await import(/* @vite-ignore */ path);
      useButlerStore.setState({ summary: null, turnProgress: {} });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (position === "up" && size === "short") {
      await page.locator('[data-test-class~="message"][data-test-class~="user"] button[aria-expanded="false"]').click();
      await page.waitForTimeout(300);
    }
    // Real wheel intent releases bottom lock, including the zero-offset short case.
    if (position === "up") {
      await page.locator('[data-test-class~="conversation-scroll"]').hover();
      await page.mouse.wheel(0, -500);
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(evidence, `scroll-before-${cell}.png`) });
    const result = await page.evaluate(async () => {
      const draftPath = "/src/app/answerDrafts.ts", storePath = "/src/app/store.ts";
      const { receiveAnswerDraft, useAnswerDrafts } = await import(/* @vite-ignore */ draftPath);
      const { useButlerStore } = await import(/* @vite-ignore */ storePath);
      const scroll = document.querySelector('[data-test-class~="conversation-scroll"]')!;
      const first = [...scroll.querySelectorAll('[data-test-class~="message"]')].find(node => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top)!;
      const samples: { phase: string; top: number; y: number; height: number; replyHeight: number; rect: object }[] = [];
      let phase = "before", running = true;
      const sample = () => {
        const visible = [...scroll.querySelectorAll('[data-test-class~="message"]')].find(node => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
        const reply = scroll.querySelector('[data-test-class="answer-blocks"]')?.closest('[data-test-class~="message"]');
        samples.push({ phase, top: scroll.scrollTop, y: first.getBoundingClientRect().y, height: scroll.scrollHeight,
          replyHeight: reply?.getBoundingClientRect().height ?? 0, rect: visible?.getBoundingClientRect().toJSON() ?? {} });
        if (running) requestAnimationFrame(sample);
      };
      sample();
      const wait = () => new Promise(resolve => setTimeout(resolve, 300));
      const send = async (ops: unknown[]) => {
        receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "butler-client", turn_id: "scroll-turn", stream_id: "scroll", call_index: 0, ops } }); await wait();
      };
      const cards = [0, 1, 2].map(index => ({ key: String(index), title: `Option ${index}`, text: "Details. ".repeat(8) }));
      phase = "start";
      await send([{ seq: 1, op: "block", bi: 0, value: { type: "cards", id: "options" } }]);
      for (let index = 0; index < 3; index++) {
        phase = `card-${index}`;
        await send([{ seq: index + 2, op: "item", bi: 0, list: "items", index, value: cards[index] }]);
      }
      phase = "close";
      await send([{ seq: 5, op: "list_end", bi: 0, list: "items" }, { seq: 6, op: "block_end", bi: 0 }, { op: "end", outcome: "accepted" }]);
      // Closing uses DS motion; handoff begins only once that content has settled.
      await new Promise<void>((resolve, reject) => {
        const start = performance.now();
        const settled = () => {
          const grid = document.querySelector('[data-test-class="answer-cards"]')!;
          if (grid.getAnimations().every(animation => animation.playState === "finished")) resolve();
          else if (performance.now() - start > 2000) reject(new Error("grid did not settle"));
          else requestAnimationFrame(settled);
        }; settled();
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      phase = "handoff";
      useButlerStore.getState().applyTimelineEvents([{ type: "message.updated", payload: { message: { id: "final", role: "assistant", chat_id: "butler-client", turn_id: "scroll-turn", status: "delivered", text: "", answer_blocks: [{ call_id: "call", set_ids: ["options"], spec: { v: 1, blocks: [{ type: "cards", id: "options", items: cards }] } }] } } }]);
      await wait(); running = false;
      const cleared = !useAnswerDrafts.getState().answerDrafts["scroll-turn"];
      // Offscreen completion and failure cleanup must never depend on mounted rows.
      receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "offscreen", turn_id: "offscreen-turn", stream_id: "offscreen", call_index: 0, ops: [{ seq: 1, op: "block", bi: 0, value: { type: "callout", text: "Hidden" } }] } });
      useButlerStore.getState().applyTimelineEvents([{ type: "message.updated", payload: { message: { id: "offscreen", role: "assistant", chat_id: "offscreen", turn_id: "offscreen-turn", status: "delivered", text: "Done" } } }]);
      const offscreenCleared = !useAnswerDrafts.getState().answerDrafts["offscreen-turn"];
      receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "offscreen", turn_id: "failed-turn", stream_id: "failed", call_index: 0, ops: [{ seq: 1, op: "block", bi: 0, value: { type: "callout", text: "Hidden" } }, { op: "end", outcome: "failed" }] } });
      await wait();
      const failedCleared = !useAnswerDrafts.getState().answerDrafts["failed-turn"];
      return { samples, cleared, offscreenCleared, failedCleared };
    });
    writeFileSync(join(evidence, `scroll-${cell}.json`), JSON.stringify(result, null, 2));
    await page.screenshot({ path: join(evidence, `scroll-after-${cell}.png`) });
    assert(result.cleared && result.offscreenCleared && result.failedCleared, "cleanup must be row-independent");
    const samples = result.samples;
    if (position === "bottom") {
      const last = samples.at(-1)!;
      const viewport = await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => node.clientHeight);
      assert.equal(last.top, Math.max(0, last.height - viewport), `${cell} bottom lock lost`);
    }
    let phaseStart = samples[0], contentGrowth = 0;
    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1], current = samples[i];
      if (current.phase !== previous.phase) { phaseStart = previous; contentGrowth = 0; }
      contentGrowth = Math.max(contentGrowth, Math.abs(current.replyHeight - phaseStart.replyHeight), Math.abs(current.height - phaseStart.height));
      if (position === "up") {
        assert.equal(current.top, samples[0].top, `${cell} scrollTop moved`);
        assert.equal(current.y, samples[0].y, `${cell} visible row moved`);
      } else if (current.phase !== "handoff") {
        const added = Math.abs(current.height - previous.height);
        assert(Math.abs(current.y - previous.y) <= contentGrowth + 1, `${cell} row jump exceeds added content`);
        assert(Math.abs(current.top - previous.top) <= added + 1, `${cell} scroll jump exceeds added content`);
      }
      if (current.phase === "handoff") {
        assert.equal(current.top, previous.top, `${cell} handoff scrollTop moved`);
        assert.equal(current.y, previous.y, `${cell} handoff row moved`);
        assert.deepEqual(current.rect, previous.rect, `${cell} handoff visible rect changed`);
      }
    }
    results.push({ cell, frames: samples.length });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results));
} finally { await browser.close(); await vite.close(); }
