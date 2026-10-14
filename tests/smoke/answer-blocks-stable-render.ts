// UI harness: real conversation components and store, offline streaming gateway stub.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types";

const root = process.cwd();
const evidence = process.env.BUTLER_ANSWER_EVIDENCE;
assert(evidence, "BUTLER_ANSWER_EVIDENCE required");
mkdirSync(evidence, { recursive: true });
const stage = process.env.BUTLER_ANSWER_STAGE ?? "after";
const spec = JSON.parse(readFileSync(join(root, "packages/butler-agent/rust/crates/butler-e2e/tests/answer_blocks/fixtures.json"), "utf8")).specs.neutral as AnswerBlocks;
spec.blocks.forEach((block, index) => { block.id = `block-${index}`; });
const cards = spec.blocks.find(block => block.type === "cards")!;
assert(cards.type === "cards");
cards.items = [0, 1].map(index => ({ ...cards.items[0], key: `item-${index}`, title: `Record ${index}`, img: "img_record0001",
  image_url: "/message-assets/img_record0001?expires=4102444800&signature=smoke" }));
const initial: MessageRecord = { id: "answer", chat_id: "butler-client", role: "assistant", status: "streaming", text: "Ready. ",
  created_at: "2026-10-14T00:00:00Z", answer_blocks: [{ call_id: "first-call", set_ids: [], spec }] };
const photo = readFileSync(join(root, "packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/butler.photo-daisies/photo.jpg"));
const names = ["AnswerBlocks", "Block", "AnswerCards", "AnswerCard", "AnswerTable", "AnswerGallery", "AnswerChart", "AnswerSourceLine", "parseAnswerBlocks"];
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error", plugins: [{
  name: "answer-render-probe", enforce: "pre",
  transform(code, id) {
    if (!/\/(AnswerBlocks|AnswerCards|AnswerDataBlocks|answer-blocks-parse)\.(tsx|ts)$/u.test(id)) return;
    // Instrument function entries only in this harness; no product hooks or profiler overhead.
    return code.split("\n").map(line => {
      const name = names.find(name => line.includes(`function ${name}(`) && line.endsWith("{"));
      return name ? `${line}\nglobalThis.__answerRenders ??= {}; globalThis.__answerRenders.${name} = (globalThis.__answerRenders.${name} ?? 0) + 1;` : line;
    }).join("\n");
  },
}] });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const errors: string[] = [];
let imageRequests = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = { messages: [initial], background: url.searchParams.get("background") ?? "plain" };
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture)}</script>`) });
    }
    if (url.pathname === "/stub-text-stream") {
      const frames = Array.from({ length: 200 }, (_, index) => ({ type: "message.updated", payload: { message: {
        ...initial, text: initial.text + "A complete streaming reply. ".repeat(index + 1), cursor: index + 1,
      } } }));
      return route.fulfill({ contentType: "application/x-ndjson", body: frames.map(frame => JSON.stringify(frame)).join("\n") });
    }
    if (url.pathname.startsWith("/message-assets/")) {
      imageRequests++;
      return route.fulfill({ contentType: "image/jpeg", body: photo });
    }
    if (url.pathname === "/favicons") return route.fulfill({ status: 404 });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client",
      revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  // Same existing conversation screen in both themes, desktop/mobile and wallpaper/plain.
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}?visual=components&theme=${theme}&background=${background}&locale=ko`);
    await page.locator('[data-slot="item-card"]').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="item-card"] img')].every(image => (image as HTMLImageElement).naturalWidth > 0));
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: join(evidence, `${stage}-${width}-${theme}-${background}.png`) });
  }
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="item-card"] img')].every(image => (image as HTMLImageElement).naturalWidth > 0));
  const requestsBefore = imageRequests;
  const result = await page.evaluate(async () => {
    // Exercise the actual message.updated reducer and subscribed conversation, one commit per delta.
    const path = "/src/app/store.ts";
    const { useButlerStore } = await import(/* @vite-ignore */ path);
    const probe = globalThis as typeof globalThis & { __answerRenders: Record<string, number> };
    const store = useButlerStore.getState;
    const nodes = [...document.querySelectorAll("[data-answer-block], [data-slot=item-card], [data-slot=item-card] img")];
    let imageLoads = 0;
    nodes.filter(node => node.tagName === "IMG").forEach(node => node.addEventListener("load", () => imageLoads++));
    // Let initial layout/ResizeObserver updates settle, then count text-induced work only.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    probe.__answerRenders = {};
    const blocks = store().messages[0].answer_blocks;
    let stableReferences = 0;
    const response = await fetch("/stub-text-stream");
    const frames = (await response.text()).split("\n").map(line => JSON.parse(line));
    const start = performance.now();
    for (const frame of frames) {
      store().applyTimelineEvents([frame]);
      if (store().messages[0].answer_blocks === blocks) stableReferences++;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const renders = { ...probe.__answerRenders };
    const final = store().messages[0];
    const stableNodes = nodes.every((node, index) => node === document.querySelectorAll("[data-answer-block], [data-slot=item-card], [data-slot=item-card] img")[index]);
    const beforeRetry = [...document.querySelectorAll("[data-answer-block]")];
    const beforeCards = [...document.querySelectorAll("[data-slot=item-card]")];
    const retry = JSON.parse(JSON.stringify(final));
    retry.answer_blocks[0].call_id = "retry-call";
    retry.answer_blocks[0].spec.blocks.reverse();
    const retryCards = retry.answer_blocks[0].spec.blocks.find((block: { type: string }) => block.type === "cards");
    retryCards.items.reverse(); retryCards.items[0].title = "Updated record";
    store().applyTimelineEvents([{ type: "message.updated", payload: { message: retry } }]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const retryNodes = [...document.querySelectorAll("[data-answer-block]")];
    const afterCards = [...document.querySelectorAll("[data-slot=item-card]")];
    return { deltas: frames.length, stableReferences, renders, elapsedMs: performance.now() - start, stableNodes, imageLoads,
      retryBlocksStable: beforeRetry.every((node, index) => node === retryNodes[retryNodes.length - index - 1]),
      retryCardsStable: beforeCards.every((node, index) => node === afterCards[afterCards.length - index - 1]),
      retryTitleUpdated: afterCards[0]?.textContent?.includes("Updated record"), finalTextLength: final.text.length,
      finalTextComplete: final.text === frames.at(-1).payload.message.text, blockCount: retryNodes.length, cardCount: afterCards.length };
  });
  const metrics = { stage, ...result, imageRequestsDuringStreamAndRetry: imageRequests - requestsBefore, modelCalls: 0 };
  writeFileSync(join(evidence, `${stage}-stream.json`), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
  assert.equal(result.deltas, 200);
  assert(result.finalTextComplete);
  assert.equal(result.blockCount, spec.blocks.length);
  assert.equal(result.cardCount, 2);
  assert(result.retryTitleUpdated);
  if (stage === "after") {
    assert.equal(result.stableReferences, 200);
    for (const name of names) assert((result.renders[name] ?? 0) <= 1, `${name} rendered more than once during text deltas`);
    assert(result.stableNodes && result.retryBlocksStable && result.retryCardsStable);
    assert.equal(result.imageLoads, 0);
    assert.equal(metrics.imageRequestsDuringStreamAndRetry, 0);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await vite.close(); }
