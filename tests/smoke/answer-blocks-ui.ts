// UI behavior E2E: product conversation, offline HTTP/desktop bridge stubs, no model calls.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types";
import { fixtureItems } from "../../packages/butler-app/client/ui/src/libs/design-system/blocks/ItemCard/fixtures";
import { toMarkdown } from "../../packages/butler-app/client/shared/answer-blocks-markdown";

const root = process.cwd();
const stage = process.env.BUTLER_ANSWER_STAGE ?? "after";
const evidence = process.env.BUTLER_ANSWER_EVIDENCE ?? resolve(".tmp/answer-blocks-ui");
mkdirSync(evidence, { recursive: true });
const mock = JSON.parse(readFileSync(join(root, "tests/smoke/answer-blocks-mock.json"), "utf8")) as AnswerBlocks;
const neutral = JSON.parse(readFileSync(join(root, "packages/butler-agent/rust/crates/butler-e2e/tests/answer_blocks/fixtures.json"), "utf8")).specs.neutral as AnswerBlocks;
const message = (spec: unknown): MessageRecord => ({ id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered",
  text: "조건에 맞는 후보를 비교했습니다.", created_at: "2026-10-12T08:51:00Z", answer_blocks: [{ call_id: "blocks", set_ids: [], spec: spec as AnswerBlocks }] });
const calls: { path: string; body: Record<string, unknown> }[] = [];
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const geometry: unknown[] = [];

let currentFixture: unknown;

async function initialize(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as Window & { copiedText?: string }).copiedText = text; } } });
    const bridge = window as Window & { openedLinks?: string[]; butlerBrowser?: unknown };
    bridge.openedLinks = [];
    bridge.butlerBrowser = { call: async (method: string, args: { url?: string }) => {
      if (method === "open-link") bridge.openedLinks!.push(args.url!);
      return { enabled: false, blocked: false, tabs: [], activeId: null };
    }, subscribe: () => () => {}, onElementDrag: () => () => {}, onSelectionAction: () => () => {}, onDownload: () => () => {} };
  });
}

async function open(page: Page, spec: unknown, width: number, theme: string, background = "plain") {
  currentFixture = { messages: [message(spec)], background };
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
  await page.locator('[data-test-class="turn-result-section"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
}

async function checkMock(page: Page, width: number, theme: string, background: string) {
  await open(page, mock, width, theme, background);
  const cards = page.locator('[data-slot="item-card"]');
  if (stage === "after") {
    await cards.first().waitFor();
    assert.equal(await cards.count(), 4);
    const grid = page.locator('[data-test-class="answer-cards"]');
    await page.waitForFunction(w => document.querySelector('[data-test-class="answer-cards"]')?.getAttribute("data-columns") === (w === 390 ? "1" : "4"), width);
    const state = await cards.first().evaluate(node => {
      const card = node.firstElementChild!;
      const frame = node.querySelector('[data-slot="media-frame"]')!;
      const title = node.querySelector('[data-slot="clickable"] + *');
      return { cardWidth: node.getBoundingClientRect().width, columns: getComputedStyle(card).gridTemplateColumns,
        fit: frame.getAttribute("data-fit"), title: title?.textContent };
    });
    assert.equal(await grid.getAttribute("data-columns"), width === 390 ? "1" : "4");
    if (width === 390) assert(state.columns.split(" ").length === 2, "phone cards have left media and right body");
    else assert(state.cardWidth >= 168, "every desktop card is at least 168px");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="media-frame"]')].every(node => ["empty", "failed"].includes(node.getAttribute("data-fit") ?? "")));
    assert.equal(await page.locator('[data-answer-block="table"] tbody tr').count(), 4);
    assert.equal(await page.locator('[data-answer-block="actions"] button').count(), 3);
    assert((await cards.first().innerText()).includes("76,390원"));
    assert((await cards.nth(3).innerText()).includes("368,000원"), "the struck-through value uses the same format");
    assert((await cards.first().innerText()).includes("오후 5:41 확인"));
    const sourceText = await cards.first().locator('[data-slot="item-card-footer"] [role="button"]').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node); return node.textContent;
    });
    assert(sourceText?.includes("musinsa.com"));
    const clipped = await page.locator('[data-slot="item-card-footer"] [role="button"] > :last-child').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent));
    assert.deepEqual(clipped, [], "every card shows its whole read time");
    assert(await page.locator('[data-test-class="answer-blocks"]').evaluate(node => node.previousElementSibling?.getAttribute("data-test-class") === "turn-result-section"));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no page horizontal overflow");
    geometry.push({ width, theme, background, ...state });
  } else assert.equal(await cards.count(), 0, "baseline has no block renderer");
  assert.equal(await page.locator('[data-sonner-toast][data-type="error"]').count(), 0, "offline conversation fixtures are complete");
  await page.screenshot({ path: join(evidence, `${stage}-${width}-${theme}-${background}.png`) });
  if (stage === "after") {
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.screenshot({ path: join(evidence, `${stage}-${width}-${theme}-${background}-table-actions.png`) });
  }
}

async function checkInteractions(page: Page) {
  await open(page, neutral, 1280, "light");
  await page.locator('[data-answer-block="chart"] svg').first().waitFor();
  assert.equal(await page.locator("[data-answer-block]").count(), 8);
  assert((await page.locator('[data-slot="item-card"]').innerText()).includes("-12.5 units"));
  await page.getByRole("button", { name: "Record One", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as Window & { openedLinks?: string[] }).openedLinks), [neutral.blocks[0].type === "cards" ? neutral.blocks[0].items[0].source : ""]);
  await page.locator('[data-slot="item-card"]').getByRole("button", { name: "복사", exact: true }).click();
  assert((await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText))?.includes("Record One · -12.5 units"));
  await page.locator('[data-slot="item-card"]').getByRole("button", { name: "서랍에 저장", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("서랍에 저장했어요"));
  const saved = calls.find(call => call.path === "/library")!;
  assert.equal(saved.body.kind, "scrap"); assert.equal(saved.body.title, "Record One");
  assert(String(saved.body.text).includes("Observed") && String(saved.body.text).includes("확인"));
  await page.locator('[data-test-class="assistant-footer"]').getByRole("button", { name: /복사/ }).click();
  assert.equal(await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText), `${message(neutral).text}\n\n${toMarkdown(neutral)}`);
  await page.getByRole("button", { name: "Compare the records", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("Compare the records"));
  assert.equal(calls.find(call => call.path === "/messages")?.body.text, "Compare the records");
}

async function checkLeniencyAndExpand(page: Page) {
  const dsItems = fixtureItems("ko-KR").map(item => ({ title: item.title, label: item.eyebrow, sub: item.subtitle,
    facts: item.facts, text: item.text, source: `https://${item.site}`, checked: "2026-10-11T08:41:00Z" }));
  await open(page, { v: 1, blocks: [{ type: "cards", items: dsItems }] }, 390, "light");
  await page.locator('[data-slot="item-card"]').first().waitFor();
  assert.equal(await page.locator('[data-slot="item-card"]').count(), 5);
  assert((await page.locator('[data-slot="item-card"]').first().innerText()).includes("2026. 10. 11."));

  const card = neutral.blocks[0]; assert(card.type === "cards");
  for (const count of [5, 6, 11]) {
    const items = Array.from({ length: count }, (_, i) => ({ ...card.items[0], title: `Record ${i}`, img: undefined }));
    const spec = { v: 1, blocks: [{ type: "unknown", text: "Invisible" }, { type: "cards", items: [...items, { title: 3 }, { text: "unfinished" }] }] };
    await open(page, spec, 1280, "dark");
    const expected = Math.min(6, count);
    await page.waitForFunction(n => document.querySelectorAll('[data-slot="item-card"]').length === n, expected);
    assert.equal(await page.locator('[data-test-class="answer-cards"]').getAttribute("data-columns"), count === 5 ? "3" : "4");
    if (count > 6) {
      await page.getByRole("button", { name: `${count - 6}개 더 보기`, exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll('[data-slot="item-card"]').length === n, count);
      assert.equal(await page.locator('[data-test-class="answer-cards"]').getAttribute("data-columns"), "4");
    }
    assert(!(await page.locator('[data-test-class="answer-blocks"]').innerText()).includes("Invisible"));
  }
  await open(page, { v: 1, blocks: [{ type: "table", columns: ["Name", "Value"], rows: Array.from({ length: 12 }, (_, i) => [`Row ${i}`, i]) }] }, 390, "light");
  assert.equal(await page.locator("tbody tr").count(), 10);
  await page.getByRole("button", { name: "2개 더 보기" }).click();
  assert.equal(await page.locator("tbody tr").count(), 12);
}

try {
  const page = await browser.newPage({ timezoneId: "Asia/Seoul", reducedMotion: "reduce" });
  await initialize(page);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = JSON.stringify(currentFixture).replaceAll("<", "\\u003c");
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${fixture}</script>`) });
    }
    if (url.pathname === "/library" || url.pathname === "/messages") {
      const body = request.postDataJSON() as Record<string, unknown>; calls.push({ path: url.pathname, body });
      const data = url.pathname === "/library" ? body : { accepted: { ...message(null), role: "user", text: body.text, id: body.client_message_id }, replies: [] };
      return route.fulfill({ json: { ok: true, data } });
    }
    if (url.pathname.startsWith("/assets/") || url.pathname === "/favicons") return route.fulfill({ status: 404 });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) await checkMock(page, width, theme, background);
  if (stage === "after") { await checkInteractions(page); await checkLeniencyAndExpand(page); }
  assert.deepEqual(errors, [], "no uncaught renderer errors");
  const result = { stage, ok: true, screenshots: stage === "after" ? 16 : 8, geometry, interactions: calls.map(call => call.path), modelCalls: 0 };
  writeFileSync(join(evidence, `${stage}-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await vite.close(); }
