// UI behavior smoke: actual product renderer, isolated HTTP stubs, no model calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createServer } from "../../packages/butler-app/client/ui/node_modules/vite/dist/node/index.js";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { toMarkdown } from "../../packages/butler-app/client/shared/answer-blocks-markdown";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts";

const root = process.cwd(), stage = process.env.BUTLER_BLOCK_STAGE ?? "after";
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? resolve(".tmp/block-scraps-ui");
mkdirSync(evidence, { recursive: true });
const spec: AnswerBlocks = { v: 2, blocks: [{ type: "columns", id: "plan", title: "주말 계획", blocks: [
  { type: "quote", id: "note", title: "전시 안내", text: "청자 panorama 전시를 둘러보세요.", cite: "전시 노트", source: "https://example.org/exhibition" },
  { type: "checklist", title: "준비", items: [{ text: "입장권 확인", done: true }, { text: "가는 길 확인", done: false }] },
] }, { type: "tabs", title: "일정", tabs: [{ label: "오늘", blocks: [{ type: "text", text: "오후에 만나요." }] }] }] };
const message = { id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered", text: "주말에 볼 전시와 준비할 일입니다.",
  created_at: "2026-10-25T08:00:00Z", answer_blocks: [{ call_id: "blocks", set_ids: ["plan"], spec }] };
const scrap = (path: string) => ({ id: `saved-${path.replaceAll("/", "-")}`, kind: "scrap", title: "전시 안내", url: "", site: "example.org",
  block: { v: 2, blocks: [path === "/blocks/0" ? spec.blocks[0] : (spec.blocks[0] as Extract<AnswerBlocks["blocks"][number], { type: "columns" }>).blocks[0]] },
  origin: { session: "butler-client", message: "answer", path, id: "note" }, capturedAt: "2026-10-25T08:00:00Z",
  ...(stage === "before" ? { snapshot: { width: 480, height: 200 } } : {}) });
const saved = [scrap("/blocks/0/blocks/0"), scrap("/blocks/0")];
const calls: { path: string; body: Record<string, unknown> }[] = [], errors: string[] = [];
const baseline = process.env.BUTLER_BLOCK_BASELINE;
if (baseline) assert.equal(stage, "before", "baseline mode is for before captures only");
if (stage === "before") assert(baseline, "BUTLER_BLOCK_BASELINE is required for before captures");
const baselineSources = new Map<string, string>();
if (stage === "before") {
  for (const file of ["conversation/AnswerBlocks.tsx", "conversation/AnswerContainers.tsx", "library/LibraryDetail.tsx", "library/LibraryItemCard.tsx"]) {
    const relative = `packages/butler-app/client/ui/src/components/${file}`;
    baselineSources.set(resolve(root, relative), execFileSync("git", ["show", `${baseline}:${relative}`], { cwd: root, encoding: "utf8" }));
  }
}
process.chdir(join(root, "packages/butler-app/client/ui"));
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  plugins: [{ name: "block-scraps-baseline", enforce: "pre", load(id) { return baselineSources.get(id.split("?")[0]); } }],
});
await vite.listen();
const base = vite.resolvedUrls!.local[0]!, browser = await launchSmokeBrowser();
let background = "plain";

async function setup(page: Page) {
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && message.text().includes("Failed to load module script")) errors.push(message.text()); });
  await page.addInitScript(() => {
    const state = window as Window & { copiedText?: string; flights?: { keys: string[]; translate?: unknown }[] };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { state.copiedText = text; } } });
    state.flights = [];
    new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement) || added.dataset.slot !== "save-flight") continue;
        const effect = added.getAnimations()[0]?.effect as KeyframeEffect | undefined;
        const frames = effect?.getKeyframes() ?? [];
        state.flights!.push({ keys: frames.flatMap(frame => Object.keys(frame)), translate: frames.at(-1)?.translate });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/node_modules/") || url.pathname.startsWith("/@")) return route.continue();
    if (url.origin !== new URL(base).origin) return route.abort();
    if (url.pathname === "/") {
      const response = await route.fetch();
      const fixture = JSON.stringify({ messages: [message], background, settings: { reduce_motion: false } }).replaceAll("<", "\\u003c");
      return route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>window.butlerConversationFixture=${fixture}</script>`) });
    }
    const answer = (data: unknown) => route.fulfill({ json: { ok: true, data } });
    if (request.method() === "POST" && ["/library/blocks", "/documents"].includes(url.pathname)) {
      const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
      return answer(url.pathname === "/documents" ? { ...body, id: "doc_created", rev: 1 } : scrap(body.path));
    }
    if (url.pathname === "/documents/doc_created") {
      const created = calls.findLast(call => call.path === "/documents")!.body;
      return answer({ ...created, id: "doc_created", rev: 1, author: "user", created_at: "2026-10-25T08:00:00Z", updated_at: "2026-10-25T08:00:00Z" });
    }
    if (url.pathname === "/library") return answer({ items: url.searchParams.get("kind") === "scrap" ? saved : [], next_cursor: null });
    if (url.pathname === "/library/groups") return answer({ groups: [], ungrouped: 2, total: 2 });
    if (url.pathname === "/library/tags") return answer({ tags: [] });
    if (url.pathname === "/library/facets") return answer({ total: 2, ungrouped: 2, tags: [], sites: [] });
    if (url.pathname.endsWith("/snapshot")) return answer({ html: "<!doctype html><html><body><h3>전시 안내</h3><p>청자 panorama 전시를 둘러보세요.</p></body></html>" });
    if (url.pathname === "/favicons") return route.fulfill({ status: 404 });
    if (url.pathname.endsWith("/controls")) return answer({ session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } });
    if (url.pathname === "/session-queue") return answer({ queued_messages: [] });
    if (/^\/projects\/[^/]+\/canon(\/sidebar)?$/u.test(url.pathname)) return answer(url.pathname.endsWith("/sidebar") ? { groups: [{ key: "backlog", kind: "backlog", title: "", rows: [] }] } : { backlog: [], plans: [], backlog_revision: 0 });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return answer({});
    return route.continue();
  });
}
async function open(page: Page, width: number, theme: string) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=ko`);
  try { await page.locator('[data-answer-block="quote"]').first().waitFor(); }
  catch (error) {
    writeFileSync(join(evidence, `${stage}-failure.txt`), JSON.stringify({ errors, body: await page.locator("body").innerText() }));
    await page.screenshot({ animations: "disabled", path: join(evidence, `${stage}-failure.png`) });
    throw error;
  }
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
}
async function drawer(page: Page, detail = false) {
  await page.evaluate(async ({ item, detail }) => {
    const path = "/src/components/library/libraryNav.ts", nav = await import(/* @vite-ignore */ path);
    if (detail) nav.openDetail(item, { kind: "library", section: "scrap" });
    else nav.openLibrary({ section: "scrap" });
  }, { item: saved[0], detail });
  await page.locator(detail ? '[data-test-class="library-detail"]' : '[data-library-card]').first().waitFor();
}
const childSelector = '[data-answer-path="/blocks/0/blocks/0"]';
async function menu(page: Page) {
  await page.locator(childSelector).hover();
  await page.locator(childSelector).getByRole("button", { name: "더 보기", exact: true }).click();
  try { await page.getByRole("menuitem", { name: "서랍에 저장", exact: true }).waitFor(); }
  catch (error) {
    writeFileSync(join(evidence, "menu-failure.json"), JSON.stringify(await page.evaluate(() => ({
      menus: [...document.querySelectorAll('[role="menu"]')].map(node => node.outerHTML),
      frame: document.querySelector('[data-answer-path="/blocks/0/blocks/0"]')?.outerHTML,
      body: document.body.innerText,
    })), null, 2));
    await page.screenshot({ animations: "disabled", path: join(evidence, "menu-failure.png") });
    throw error;
  }
}
async function screenshotMatrix(page: Page) {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const bg of ["plain", "wallpaper"]) {
    background = bg;
    const prefix = `${stage}-${width}-${theme}-${bg}`;
    await open(page, width, theme);
    if (stage === "after") await page.locator(childSelector).hover();
    await page.screenshot({ animations: "disabled", path: join(evidence, `${prefix}-answer.png`) });
    if (stage === "after") await menu(page);
    await page.screenshot({ animations: "disabled", path: join(evidence, `${prefix}-menu.png`) });
    if (stage === "after") await page.keyboard.press("Escape");
    await drawer(page);
    if (stage === "after") {
      await page.locator('[data-library-card] [data-slot="block-action-frame"]').first().waitFor();
      assert((await page.locator('[data-library-card]').first().innerText()).includes("블록"));
      assert(await page.locator('[data-library-card] [data-slot="block-action-frame"]').first().evaluate(node => Boolean(node.closest("[inert]"))));
    }
    await page.screenshot({ animations: "disabled", path: join(evidence, `${prefix}-grid.png`) });
    await drawer(page, true);
    if (stage === "after") {
      assert.equal(await page.locator('[data-test-class="library-detail"] iframe').count(), 0);
      await page.locator('[data-test-class="library-detail"] [data-answer-block="quote"]').waitFor();
    } else await page.locator('iframe[data-test-class="scrap-frame"]').waitFor();
    await page.screenshot({ animations: "disabled", path: join(evidence, `${prefix}-detail.png`) });
  }
}
async function interactions(page: Page, reduced: boolean) {
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await open(page, 1440, "light");
  await page.evaluate(async () => {
    const path = "/src/app/store.ts", { useButlerStore } = await import(/* @vite-ignore */ path);
    useButlerStore.getState().setLeftOpen(true);
  });
  await page.locator('[data-flight-target="library"]').waitFor({ state: "visible" });
  const child = page.locator(childSelector), parent = page.locator('[data-answer-path="/blocks/0"]');
  await child.hover();
  await page.waitForFunction(() => {
    const child = document.querySelector('[data-answer-path="/blocks/0/blocks/0"] > div button')!;
    return getComputedStyle(child).opacity === "1";
  });
  const visible = await page.locator('[data-slot="block-action-frame"] > div > button').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).opacity === "1").length);
  assert.equal(visible, 1, "only the innermost block shows a trigger");
  await parent.locator(':scope > div > button').focus();
  await page.keyboard.press("Tab");
  assert(await child.locator(':scope > div > button').evaluate(node => node === document.activeElement), "Tab reaches the child menu");
  await menu(page);
  assert.deepEqual((await page.getByRole("menuitem").allTextContents()).map(text => text.trim()), ["서랍에 저장", "문서로 만들기", "복사"]);
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  const expected = toMarkdown({ v: 2, blocks: [(spec.blocks[0] as Extract<AnswerBlocks["blocks"][number], { type: "columns" }>).blocks[0]] });
  assert.equal(await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText), expected);
  await page.getByRole("menu").waitFor({ state: "detached" });
  await menu(page);
  await page.getByRole("menuitem", { name: "서랍에 저장", exact: true }).click();
  await page.waitForFunction(() => (window as Window & { flights?: unknown[] }).flights?.length);
  assert.deepEqual(calls.filter(c => c.path === "/library/blocks").at(-1)?.body, { message_id: "answer", path: "/blocks/0/blocks/0" });
  const flight = await page.evaluate(() => (window as Window & { flights?: { keys: string[] }[] }).flights!.at(-1)!);
  assert.equal(flight.keys.includes("translate"), !reduced, "reduced motion crossfades");
  await page.waitForFunction(() => !document.querySelector('[data-slot="save-flight"]'));
  await page.locator('[data-sonner-toast]').filter({ hasText: "서랍에 저장했어요" }).getByRole("button", { name: "열기", exact: true }).click();
  await page.locator('[data-test-class="library-detail"] [data-answer-block="quote"]').waitFor();
  assert.equal(await page.locator('[data-test-class="library-detail"] iframe').count(), 0);
  await page.locator('[data-test-class="library-detail"] [data-answer-block="quote"]').hover();
  await page.locator('[data-test-class="library-detail"] [data-answer-block="quote"]').getByRole("button", { name: "더 보기", exact: true }).click();
  assert.deepEqual((await page.getByRole("menuitem").allTextContents()).map(text => text.trim()), ["문서로 만들기", "복사"]);
  await page.getByRole("menuitem", { name: "문서로 만들기", exact: true }).click();
  await page.getByRole("textbox", { name: "문서", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("doc"), "doc_created");
  await page.locator('[data-document-id="doc_created"]').waitFor();
  assert.equal(await page.locator('[data-session-section="artifacts"] [data-document-id]').count(), 0);
  assert.equal(calls.at(-1)?.path, "/documents");
  const body = calls.at(-1)!.body;
  assert.equal(body.title, "전시 안내");
  assert.equal(body.chat_id, "butler-client"); assert.equal(body.message_id, "answer");
  assert.equal(body.body, `\`\`\`blocks\n${JSON.stringify(saved[0].block)}\n\`\`\``);
}
async function assertInnermostMenu(page: Page) {
  const trigger = page.locator(`${childSelector} > div > button`);
  const menus = page.locator('[role="menu"][data-state="open"]');
  assert.equal(await menus.count(), 1, "exactly one menu opens");
  assert.equal(await menus.getAttribute("aria-labelledby"), await trigger.getAttribute("id"), "the menu belongs to the innermost block's ⋯");
  assert.equal(await page.locator('[data-answer-path="/blocks/0"] > div > button').getAttribute("aria-expanded"), "false", "the container menu stays closed");
  assert.equal(await page.locator('[data-slot="context-menu-content"][data-state="open"]').count(), 0, "the reply context menu stays closed");
  assert.deepEqual((await menus.getByRole("menuitem").allTextContents()).map(text => text.trim()), ["서랍에 저장", "문서로 만들기", "복사"]);
  const anchor = await trigger.boundingBox(), popup = await menus.boundingBox();
  assert(anchor && popup && anchor.width > 0);
  assert(Math.abs(popup.x + popup.width - anchor.x - anchor.width) < 2, "the menu aligns with the block's ⋯");
}
async function copyChildFromMenu(page: Page) {
  await page.getByRole("menuitem", { name: "복사", exact: true }).click();
  const expected = toMarkdown(saved[0].block as AnswerBlocks);
  assert.equal(await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText), expected, "the child alone is copied");
  await page.getByRole("menu").waitFor({ state: "detached" });
}
async function rightClick(page: Page) {
  await open(page, 1440, "light");
  await page.locator(childSelector).click({ button: "right" });
  await page.getByRole("menuitem", { name: "서랍에 저장", exact: true }).waitFor();
  await assertInnermostMenu(page);
  await copyChildFromMenu(page);
}
async function touch() {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 1000 } });
  try {
    const page = await context.newPage(); await setup(page); await open(page, 390, "light");
    const box = await page.locator(childSelector).boundingBox(); assert(box);
    await page.evaluate(() => {
      const shared = window as Window & { touchEvents?: unknown[] };
      shared.touchEvents = [];
      for (const type of ["pointerdown", "pointermove", "pointercancel", "pointerup", "contextmenu"]) {
        document.addEventListener(type, event => shared.touchEvents!.push({ type, target: (event.target as Element)?.closest("[data-answer-path]")?.getAttribute("data-answer-path"),
          pointerType: (event as PointerEvent).pointerType, x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY }), true);
      }
    });
    const cdp = await context.newCDPSession(page);
    const started = await page.evaluate(() => performance.now());
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    try {
      await page.getByRole("menuitem", { name: "서랍에 저장", exact: true }).waitFor();
      // Hold beyond the enclosing reply's 700 ms Radix timer, before lifting.
      await page.waitForFunction(start => performance.now() - start >= 800, started);
      await assertInnermostMenu(page);
      assert.equal(await page.locator(`${childSelector} > div > button`).evaluate(node => getComputedStyle(node).visibility), "hidden");
    }
    catch (error) {
      writeFileSync(join(evidence, "touch-failure.json"), JSON.stringify(await page.evaluate(() => ({
        events: (window as Window & { touchEvents?: unknown[] }).touchEvents,
        menus: [...document.querySelectorAll('[role="menu"]')].map(node => node.outerHTML),
        frames: [...document.querySelectorAll('[data-answer-path]')].map(node => ({ path: node.getAttribute("data-answer-path"), state: node.getAttribute("data-state") })),
      })), null, 2));
      await page.screenshot({ path: join(evidence, "touch-failure.png") });
      throw error;
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await copyChildFromMenu(page);
  } finally { await context.close(); }
}
try {
  const page = await browser.newPage({ timezoneId: "Asia/Seoul", locale: "ko-KR", reducedMotion: "no-preference" });
  await setup(page);
  const phase = process.env.BUTLER_BLOCK_PHASE;
  if (!phase || phase === "matrix") await screenshotMatrix(page);
  if (stage === "after") {
    if (!phase || phase === "pointer") await rightClick(page);
    if (!phase || phase === "interactions") { await interactions(page, false); await interactions(page, true); }
    if (!phase || phase === "touch") await touch();
  }
  assert.deepEqual(errors, []);
  const result = { stage, phase, screenshots: !phase || phase === "matrix" ? 32 : 0, modelCalls: 0, calls, ok: true };
  writeFileSync(join(evidence, `${stage}${phase ? `-${phase}` : ""}-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); await vite.close(); }
