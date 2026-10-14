// UI harness: production draft reducer and conversation, offline only.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser";

const root = process.cwd();
const evidence = process.env.BUTLER_ANSWER_EVIDENCE;
assert(evidence, "BUTLER_ANSWER_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{
  name: "draft-render-probe", enforce: "pre",
  transform(code, id) {
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
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
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
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    captureSuffix = `${width}-${theme}`;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
    await page.locator('[data-test-class~="message"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(evidence, `draft-before-${width}-${theme}.png`) });
    const result = await page.evaluate(async () => {
      const draftPath = "/src/app/answerDrafts.ts", storePath = "/src/app/store.ts";
      const { receiveAnswerDraft, useAnswerDrafts } = await import(/* @vite-ignore */ draftPath);
      const { useButlerStore } = await import(/* @vite-ignore */ storePath);
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
      const rect = first.getBoundingClientRect().toJSON();
      await (window as unknown as { captureAnswerDraft: () => Promise<void> }).captureAnswerDraft();
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
      await frame([{ op: "end", outcome: "accepted" }], "");
      useButlerStore.getState().applyTimelineEvents([{ type: "message.updated", payload: { message: {
        id: "final-answer", role: "assistant", chat_id: "butler-client", turn_id: "draft-turn", status: "delivered", text: "준비했습니다.",
        answer_blocks: [{ call_id: "accepted-call", set_ids: ["methods"], spec: { v: 1, blocks: [{ type: "cards", id: "methods", media: "1:1", items: cards }] } }],
      } } }]);
      await paint();
      const after = [...document.querySelectorAll('[data-slot="item-card"]')];
      return { contentRenders, newCardRenders, rects, kept: before.every((node, index) => node === after[index]), count: after.length, messagesStable,
        draftsCleared: !useAnswerDrafts.getState().answerDrafts["draft-turn"] };
    });
    assert.equal(result.count, 3);
    assert.equal(result.contentRenders, 0, "draft ops must not rerender the message body");
    assert.equal(result.newCardRenders, 2, "only the two arriving cards should render");
    assert(result.kept, "handoff must keep draft DOM nodes");
    assert(result.messagesStable, "draft ops must not update the message store");
    assert(result.draftsCleared);
    for (const rect of result.rects.slice(1)) assert.deepEqual(rect, result.rects[0], "earlier card rect changed");
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: join(evidence, `draft-final-${width}-${theme}.png`) });
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
      if (node !== document.querySelectorAll('[data-slot="item-card"]')[3]) throw new Error("retry type must retain earlier card");
      await send([{ ...initial[1], value: { key: "stable", title: "확인했습니다." } }], "retry");
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
    results.push({ width, theme, ...result, ...rejected });
  }
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "draft-results.json"), JSON.stringify({ modelCalls: 0, results }, null, 2));
  console.log(JSON.stringify({ modelCalls: 0, results }));
} finally { await browser.close(); await vite.close(); }
