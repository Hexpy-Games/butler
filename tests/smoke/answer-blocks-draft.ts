// UI harness: production draft reducer and conversation, offline only.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = [false, true].flatMap(reduced => [1440, 390].flatMap(width => ["light", "dark"].map(theme => `${width}-${theme}-${reduced ? "reduced" : "motion"}`)));
if (await runSmokeCases(cases, "BUTLER_DRAFT_CASE", import.meta.path)) process.exit(0);
const root = process.cwd();
const evidence = process.env.BUTLER_ANSWER_EVIDENCE;
assert(evidence, "BUTLER_ANSWER_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{
  name: "draft-render-probe", enforce: "pre",
  transform(code, id) {
    if (id.endsWith("/gridSettle.ts")) return code.replace("  const current = runs.get(grid);", "  globalThis.__gridSettles = (globalThis.__gridSettles ?? 0) + 1;\n  const current = runs.get(grid);");
    if (id.endsWith("/MessageContent.tsx")) return code.replace("}: MessageContentProps) {", "}: MessageContentProps) {\nglobalThis.__messageContentRenders = (globalThis.__messageContentRenders ?? 0) + 1;");
    if (id.endsWith("/AnswerCards.tsx")) return code.split("\n").map(line => line.includes("function AnswerCard(") && line.endsWith("{")
      ? `${line}\nglobalThis.__draftCardRenders = (globalThis.__draftCardRenders ?? 0) + 1;` : line).join("\n");
  },
}] });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const results: unknown[] = [];
try {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    const calls: unknown[] = [];
    Object.assign(window, { gridMotionCalls: calls });
    Element.prototype.animate = function (frames, options) {
      if (this.matches('[data-test-class="answer-cards"]')) calls.push(frames);
      return original.call(this, frames, options);
    };
  });
  let captureSuffix = "";
  await page.exposeFunction("captureAnswerDraft", async () => {
    await page.waitForFunction(() => {
      const blocks = document.querySelector('[data-test-class="answer-blocks"]');
      const card = document.querySelector('[data-slot="item-card"]');
      return blocks && card?.parentElement && Number(getComputedStyle(blocks).opacity) === 1
        && Number(getComputedStyle(card.parentElement).opacity) === 1;
    });
    await page.screenshot({ path: join(evidence, `draft-first-${captureSuffix}.png`) });
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = { messages: [{ id: "question", role: "user", text: "비교해 주세요.", chat_id: "butler-client", turn_id: "draft-turn" }], background: "plain" };
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client",
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const reducedMotion of [false, true]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    captureSuffix = `${width}-${theme}-${reducedMotion ? "reduced" : "motion"}`;
    if (process.env.BUTLER_DRAFT_CASE && process.env.BUTLER_DRAFT_CASE !== captureSuffix) continue;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="message"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(evidence, `draft-before-${captureSuffix}.png`) });
    const result = await page.evaluate(async (reducedMotion) => {
      const draftPath = "/src/app/answerDrafts.ts", storePath = "/src/app/store.ts";
      const { receiveAnswerDraft, useAnswerDrafts } = await import(/* @vite-ignore */ draftPath);
      const { useButlerStore } = await import(/* @vite-ignore */ storePath);
      useButlerStore.setState((state: { settings: object }) => ({ settings: { ...state.settings, reduce_motion: reducedMotion } }));
      Object.assign(globalThis, { __gridSettles: 0 });
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const frame = async (ops: unknown[], stream = "first", turn = "draft-turn") => {
        receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "butler-client", turn_id: turn, stream_id: stream, call_index: 0, ops } });
        await paint();
      };
      const cards = [{ key: "one", title: "첫 번째", text: "첫 번째 방법입니다." },
        { key: "two", title: "두 번째 방법을 비교하는 긴 제목", text: "두 번째 방법입니다. ".repeat(8) }, { key: "three", title: "세 번째", text: "세 번째 방법입니다. ".repeat(16) }];
      const messageReferences = useButlerStore.getState().messages;
      await frame([{ seq: 1, op: "block", bi: 0, value: { type: "cards", media: "1:1", id: "methods" } },
        { seq: 2, op: "item", bi: 0, list: "items", index: 0, value: cards[0] }]);
      const first = document.querySelector('[data-slot="item-card"]')!;
      if (!first) throw new Error("first draft card missing");
      await (window as unknown as { captureAnswerDraft: () => Promise<void> }).captureAnswerDraft();
      const rect = first.getBoundingClientRect().toJSON();
      const skeleton = document.querySelector('[data-slot="item-card-skeleton"]');
      if (!skeleton) throw new Error("next card skeleton missing");
      if (reducedMotion && skeleton.getAnimations({ subtree: true }).length) throw new Error("reduced skeleton must not shimmer");
      if (reducedMotion && first.querySelector('[data-slot="media-frame"]')?.getAttribute("data-reduced") !== "true") throw new Error("media must follow app reduced motion");
      const openCross = getComputedStyle(document.querySelector('[data-test-class="answer-cards"]')!).alignItems;
      const rects = [rect];
      const probe = globalThis as typeof globalThis & { __messageContentRenders: number; __draftCardRenders: number };
      probe.__messageContentRenders = 0; probe.__draftCardRenders = 0;
      for (let index = 1; index < cards.length; index++) {
        await frame([{ seq: index + 2, op: "item", bi: 0, list: "items", index, value: cards[index] }]);
        if (document.querySelectorAll('[data-slot="item-card"]').length !== index + 1) throw new Error("cards must arrive one by one");
        rects.push(first.getBoundingClientRect().toJSON());
      }
      const contentRenders = probe.__messageContentRenders, newCardRenders = probe.__draftCardRenders;
      const before = [...document.querySelectorAll('[data-slot="item-card"]')];
      const messagesStable = useButlerStore.getState().messages === messageReferences;
      await frame([{ seq: 5, op: "list_end", bi: 0, list: "items" }, { seq: 6, op: "block_end", bi: 0 }]);
      await new Promise<void>((resolve, reject) => {
        const start = performance.now();
        const check = () => {
          const grid = document.querySelector('[data-test-class="answer-cards"]')!;
          if (getComputedStyle(grid).alignItems !== "start" && grid.getAnimations().every(a => a.playState === "finished")) resolve();
          else if (performance.now() - start > 2000) reject(new Error("grid did not settle"));
          else requestAnimationFrame(check);
        }; check();
      });
      await frame([{ op: "end", outcome: "accepted" }], "");
      useButlerStore.getState().applyTimelineEvents([{ type: "message.updated", payload: { message: {
        id: "final-answer", role: "assistant", chat_id: "butler-client", turn_id: "draft-turn", status: "delivered", text: "준비했습니다.",
        answer_blocks: [{ call_id: "accepted-call", set_ids: ["methods"], spec: { v: 1, blocks: [{ type: "cards", id: "methods", media: "1:1", items: cards }] } }],
      } } }]);
      await paint();
      const after = [...document.querySelectorAll('[data-slot="item-card"]')];
      const heights = after.map(node => node.getBoundingClientRect().height);
      const gridFrames = (window as unknown as Window & { gridMotionCalls: Record<string, unknown>[][] }).gridMotionCalls;
      return { contentRenders, newCardRenders, rects, heights, gridFrames, kept: before.every((node, index) => node === after[index]), count: after.length, messagesStable,
        draftsCleared: !useAnswerDrafts.getState().answerDrafts["draft-turn"], openCross,
        settles: (globalThis as typeof globalThis & { __gridSettles: number }).__gridSettles };
    }, reducedMotion);
    assert.equal(result.count, 3);
    assert.equal(result.openCross, "start");
    if (width === 1440) assert(result.heights.every(height => height === result.heights[0]), "closed row heights are equal");
    if (reducedMotion) assert(result.gridFrames.flat().every(frame => !("height" in frame) && !("transform" in frame)), "reduced settle has fades only");
    assert.equal(result.settles, 1, "one settle at close and none at handoff");
    assert.equal(result.contentRenders, 0, "draft ops must not rerender the message body");
    assert.equal(result.newCardRenders, 2, "only the two arriving cards should render");
    assert(result.kept, "handoff must keep draft DOM nodes");
    assert(result.messagesStable, "draft ops must not update the message store");
    assert(result.draftsCleared);
    for (const rect of result.rects.slice(1)) assert.deepEqual(rect, result.rects[0], "earlier card rect changed");
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: join(evidence, `draft-final-${captureSuffix}.png`) });
    const rejected = await page.evaluate(async () => {
      const path = "/src/app/answerDrafts.ts";
      const { receiveAnswerDraft, abandonAnswerDrafts, useAnswerDrafts } = await import(/* @vite-ignore */ path);
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const send = async (ops: unknown[], stream = "rejected", turn = "reject-turn") => {
        receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "butler-client", turn_id: turn, stream_id: stream, call_index: 0, ops } }); await paint();
      };
      const initial = [{ seq: 1, op: "block", bi: 0, value: { type: "cards", media: "1:1", id: "retry" } },
        { seq: 2, op: "item", bi: 0, list: "items", index: 0, value: { key: "stable", title: "다시 확인" } }];
      await send(initial);
      const node = document.querySelectorAll('[data-slot="item-card"]')[3];
      await send([{ op: "end", outcome: "rejected" }], "");
      await send(initial.slice(0, 1), "retry");
      const stale = document.querySelector('[data-answer-superseded="true"]');
      if (!stale || Math.abs(Number(getComputedStyle(stale).opacity) - 0.45) > 0.001) throw new Error("retry must dim superseded item to 45%");
      if (node !== document.querySelectorAll('[data-slot="item-card"]')[3]) throw new Error("retry type must retain earlier card");
      await send([{ ...initial[1], value: { key: "stable", title: "확인했습니다." } }], "retry");
      if (document.querySelector('[data-answer-superseded="true"]')) throw new Error("replacement must restore opacity");
      const retryKept = node === document.querySelectorAll('[data-slot="item-card"]')[3];
      await send([{ op: "end", outcome: "rejected" }], "");
      await send([{ op: "end", outcome: "delivered" }], "");
      await new Promise<void>((resolve, reject) => {
        const start = performance.now();
        const settled = () => {
          if (document.querySelectorAll('[data-slot="item-card"]').length === 3) resolve();
          else if (performance.now() - start > 2000) reject(new Error("draft exit did not finish"));
          else requestAnimationFrame(settled);
        }; settled();
      });
      const rejectedGone = !useAnswerDrafts.getState().answerDrafts["reject-turn"];
      await send(initial, "abandoned", "abandon-turn");
      abandonAnswerDrafts(); await paint();
      await new Promise<void>((resolve, reject) => {
        const start = performance.now();
        const settled = () => {
          if (document.querySelectorAll('[data-slot="item-card"]').length === 3) resolve();
          else if (performance.now() - start > 2000) reject(new Error("draft exit did not finish"));
          else requestAnimationFrame(settled);
        }; settled();
      });
      return { retryKept, rejectedGone, abandonedGone: !useAnswerDrafts.getState().answerDrafts["abandon-turn"], count: document.querySelectorAll('[data-slot="item-card"]').length };
    });
    console.log(JSON.stringify(rejected));
    assert(rejected.retryKept && rejected.rejectedGone && rejected.abandonedGone);
    assert.equal(rejected.count, 3);
    const calls = await page.evaluate(async () => {
      const path = "/src/app/answerDrafts.ts";
      const { receiveAnswerDraft, forgetAnswerDraft } = await import(/* @vite-ignore */ path);
      const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const send = async (ops: unknown[], stream: string, index: number, callId: string) => {
        receiveAnswerDraft({ type: "answer_blocks.draft", payload: { session_id: "butler-client", turn_id: "calls-turn", stream_id: stream, call_index: index, call_id: callId, ops } });
        await paint();
      };
      const cards = (id: string, title: string) => [{ seq: 1, op: "block", bi: 0, value: { type: "cards", media: "1:1", id } },
        { seq: 2, op: "item", bi: 0, list: "items", index: 0, value: { key: title, title } }, { seq: 3, op: "list_end", bi: 0, list: "items" }, { seq: 4, op: "block_end", bi: 0 }];
      const shown = () => {
        const blocks = [...document.querySelectorAll('[data-test-class="answer-blocks"]')].at(-1)!;
        return { titles: [...blocks.querySelectorAll('[data-slot="item-card"]')].map(node => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? ""),
          dimmed: blocks.querySelectorAll('[data-answer-superseded="true"]').length, status: blocks.querySelector('[role="status"]')?.textContent };
      };
      // Two calls of one round, then a later round's call whose outcome arrives before its units and replaces block "a".
      await send(cards("a", "Alpha"), "round-1", 0, "call-a");
      await send(cards("b", "Beta"), "round-1", 1, "call-b");
      const parallel = shown();
      await send([{ op: "end", outcome: "accepted" }], "", 0, "call-b");
      await send([{ op: "end", outcome: "accepted" }], "", 0, "call-a");
      await send([{ op: "end", outcome: "accepted" }], "", 0, "call-c");
      await send(cards("a", "Alpha 2"), "round-2", 0, "call-c");
      const later = shown();
      forgetAnswerDraft("calls-turn"); await paint();
      return { parallel, later };
    });
    console.log(JSON.stringify(calls));
    assert.deepEqual(calls.parallel.titles, ["Alpha", "Beta"], "parallel calls keep their own blocks");
    assert.equal(calls.parallel.dimmed, 0, "a parallel call never dims another call");
    assert.deepEqual(calls.later.titles, ["Beta", "Alpha 2"], "a later call replaces only its block id");
    assert.equal(calls.later.dimmed, 0);
    results.push({ width, theme, reducedMotion, ...result, ...rejected, calls });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, `draft-results-${process.env.BUTLER_DRAFT_CASE ?? "all"}.json`), JSON.stringify({ modelCalls: 0, results }, null, 2));
  console.log(JSON.stringify({ modelCalls: 0, results }));
} finally { await browser.close(); await vite.close(); }
