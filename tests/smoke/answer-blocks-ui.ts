// UI behavior E2E: product conversation, offline HTTP/desktop bridge stubs, no model calls.
import { checkImageSizing, sizingAsset } from "./answer-image-sizing";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const only = process.env.BUTLER_ANSWER_ONLY;
const sizingOnly = only === "image-sizing";
const stage = process.env.BUTLER_ANSWER_STAGE ?? "after";
const locale = process.env.BUTLER_ANSWER_LOCALE === "en" ? "en" : "ko";
const labels = locale === "en" ? {
  copy: "Copy", copied: "Copied", save: "Save to library", saved: "Saved to library",
  showMore: "Show more", showLess: "Show less", moreItems: (count: number) => `Show ${count} more`,
  checkedTime: "5:41 PM", checkedLabel: "Checked at 5:41 PM · musinsa.com",
} : {
  copy: "복사", copied: "복사했어요", save: "서랍에 저장", saved: "서랍에 저장했어요",
  showMore: "더 보기", showLess: "접기", moreItems: (count: number) => `${count}개 더 보기`,
  checkedTime: "오후 5:41", checkedLabel: "오후 5:41 확인 · musinsa.com",
};
const evidence = process.env.BUTLER_ANSWER_EVIDENCE ?? resolve(process.env.TMPDIR ?? "/tmp", "answer-blocks-ui");
mkdirSync(evidence, { recursive: true });
const mock = JSON.parse(readFileSync(join(root, "tests/smoke/answer-blocks-mock.json"), "utf8")) as AnswerBlocks;
const neutral = JSON.parse(readFileSync(join(root, "packages/butler-agent/rust/crates/butler-e2e/tests/answer_blocks/fixtures.json"), "utf8")).specs.neutral as AnswerBlocks;
const message = (spec: unknown): MessageRecord => ({ id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered",
  text: "조건에 맞는 후보를 비교했습니다.", created_at: "2026-10-12T08:51:00Z", answer_blocks: [{ call_id: "blocks", set_ids: [], spec: spec as AnswerBlocks }] });
const calls: { path: string; body: Record<string, unknown> }[] = [];
process.chdir(join(root, "packages/butler-app/client/ui"));
const baseline = process.env.BUTLER_ANSWER_BASELINE;
const baselineSources = new Map<string, string>();
if (baseline) {
  assert.equal(stage, "before", "baseline mode is for before captures only");
  for (const name of ["AnswerBlocks", "AnswerContainers", "AnswerCards", "AnswerDataBlocks", "AnswerLeafBlocks"]) {
    const file = `packages/butler-app/client/ui/src/components/conversation/${name}.tsx`;
    baselineSources.set(resolve(root, file), execFileSync("git", ["show", `${baseline}:${file}`], { cwd: root, encoding: "utf8" }));
  }
}
const vite = await createServer({ server: { host: "127.0.0.1", port: 0 }, logLevel: "error",
  plugins: [{ name: "answer-baseline", enforce: "pre", load(id) { return baselineSources.get(id.split("?")[0]); } }],
});
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const browser = await launchSmokeBrowser();
const errors: string[] = [];
const geometry: unknown[] = [];

let currentFixture: unknown;

async function initialize(page: Page) {
  await page.addInitScript(() => {
    const shared = window as Window & { copiedText?: string; copiedImage?: string[] };
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async (text: string) => { shared.copiedText = text; },
      write: async (items: ClipboardItem[]) => { shared.copiedImage = items.flatMap(item => [...item.types]); },
    } });
    // The desktop bridge keeps the tabs it is asked to create, with their owner, like the main process.
    const bridge = window as Window & { openedLinks?: string[]; browserTabs?: { id: string; owner: string; url: string }[]; activated?: string[]; butlerBrowser?: unknown };
    bridge.openedLinks = []; bridge.browserTabs = []; bridge.activated = [];
    bridge.butlerBrowser = { call: async (method: string, args: { url?: string; owner?: string; id?: string }) => {
      if (method === "open-link") bridge.openedLinks!.push(args.url!);
      if (method === "create") {
        const id = `t${bridge.browserTabs!.length + 1}`;
        bridge.browserTabs!.push({ id, owner: args.owner ?? "mine", url: args.url ?? "" });
        return id;
      }
      if (method === "activate") bridge.activated!.push(args.id!);
      if (method === "app-snapshot") {
        // The main process copies the marked part (app-part-snapshot-electron proves the copy); record what was marked.
        const part = document.querySelector(`[data-butler-snapshot="${(args as { target?: string }).target}"]`);
        (window as Window & { snapshotted?: string[] }).snapshotted = [...(window as Window & { snapshotted?: string[] }).snapshotted ?? [],
          part?.getAttribute("data-slot") ?? (part?.hasAttribute("data-answer-item") ? "answer-item" : "none")];
        return { html: "<!doctype html><html><body>copy</body></html>", width: 320, height: 200, crop: "data:image/jpeg;base64,/9j/smoke" };
      }
      return { enabled: false, blocked: false, tabs: bridge.browserTabs, activeId: null };
    }, subscribe: () => () => {}, onElementDrag: () => () => {}, onSelectionAction: () => () => {}, onDownload: () => () => {} };
  });
}

async function open(page: Page, spec: unknown, width: number, theme: string, background = "plain") {
  currentFixture = { messages: [message(spec)], background };
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${base}?visual=components&theme=${theme}&locale=${locale}`);
  await page.locator('[data-test-class="turn-result-section"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
}

async function checkMock(page: Page, width: number, theme: string, background: string) {
  await open(page, mock, width, theme, background);
  const cards = page.locator('[data-slot="item-card"]');
  if (stage === "after" || baseline) {
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
    assert.equal(await page.locator('[data-answer-block="actions"] button:not([aria-haspopup="menu"])').count(), 3);
    assert((await cards.first().innerText()).includes("76,390"));
    assert((await cards.nth(3).innerText()).includes("368,000"), "the struck-through value uses the same format");
    assert((await cards.first().innerText()).includes(labels.checkedTime));
    const provenance = cards.first().locator('[data-slot="item-card-footer"] [role="button"]');
    assert.equal(await provenance.getAttribute("aria-label"), labels.checkedLabel);
    assert.equal(await provenance.getAttribute("title"), labels.checkedLabel);
    const sourceText = await provenance.evaluate(node => {
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
  await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: join(evidence, `${locale}-${stage}-${width}-${theme}-${background}.png`) });
  if (locale === "en" && width === 1440 && theme === "light" && background === "plain") {
    await page.screenshot({ path: join(evidence, "en-1440-light.png") });
  }
  if (stage === "after") {
    await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.screenshot({ path: join(evidence, `${locale}-${stage}-${width}-${theme}-${background}-table-actions.png`) });
  }
}

async function checkInteractions(page: Page) {
  await open(page, neutral, 1440, "light");
  await page.locator('[data-answer-block="chart"] svg').first().waitFor();
  assert.equal(await page.locator("[data-answer-block]").count(), 8);
  assert((await page.locator('[data-slot="item-card"]').innerText()).includes("-12.5 units"));
  await page.getByRole("button", { name: "Record One", exact: true }).click();
  const recordSource = neutral.blocks[0].type === "cards" ? neutral.blocks[0].items[0].source : "";
  assert.deepEqual(await browserTabs(page), [{ id: "t1", owner: "conversation:butler-client", url: recordSource }], "the card opens in its conversation's browser");
  assert.deepEqual(await page.evaluate(() => (window as Window & { openedLinks?: string[] }).openedLinks), [], "no standalone user tab");
  await page.locator('[data-slot="item-card"]').getByRole("button", { name: labels.copy, exact: true }).click();
  await page.getByRole("button", { name: labels.copied, exact: true }).first().waitFor();
  assert((await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText))?.includes("Record One · -12.5 units"));
  await page.locator('[data-slot="item-card"]').getByRole("button", { name: labels.save, exact: true }).click();
  await page.waitForFunction(text => document.body.textContent?.includes(text), labels.saved);
  const saved = calls.find(call => call.path === "/library")!;
  assert.equal(saved.body.kind, "scrap"); assert.equal(saved.body.title, "Record One");
  assert(String(saved.body.text).includes("Observed") && String(saved.body.text).includes(locale === "en" ? "8:55 PM" : "오후 8:55"));
  // The whole card is the scrap: its HTML copy, a picture of its own, and its structured fields.
  const card = neutral.blocks[0].type === "cards" ? neutral.blocks[0].items[0] : undefined;
  assert.deepEqual(await page.evaluate(() => (window as Window & { snapshotted?: string[] }).snapshotted), ["item-card"], "the card is the copied part");
  assert.deepEqual(saved.body.snapshot, { html: "<!doctype html><html><body>copy</body></html>", width: 320, height: 200 });
  assert.equal(saved.body.crop, "data:image/jpeg;base64,/9j/smoke", "without a loadable photo the card's own pixels are the picture");
  assert.equal(saved.body.url, card?.source);
  assert.deepEqual(saved.body.fields, Object.fromEntries(Object.entries({ title: card?.title, sub: card?.sub, label: card?.label, value: card?.value,
    facts: card?.facts, text: card?.text, source: card?.source, checked: card?.checked }).filter(([, value]) => value !== undefined)));
  assert.equal(await page.locator("[data-butler-snapshot]").count(), 0, "the copy marker is removed");
  const scrapped = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/library");
  await page.locator('[data-answer-block="gallery"]').getByRole("button", { name: labels.save, exact: true }).click();
  await page.waitForFunction(count => (window as Window & { snapshotted?: string[] }).snapshotted?.length === count, 2);
  assert.deepEqual(await page.evaluate(() => (window as Window & { snapshotted?: string[] }).snapshotted), ["item-card", "answer-item"], "a gallery item is copied by itself");
  await scrapped;
  assert.equal(calls.filter(call => call.path === "/library").at(-1)?.body.snapshot && true, true, "the gallery scrap keeps its copy");
  await page.locator('[data-test-class="assistant-footer"]').getByRole("button", { name: new RegExp(labels.copy) }).click();
  assert.equal(await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText), `${message(neutral).text}\n\n${toMarkdown(neutral)}`);
  await page.getByRole("button", { name: "Compare the records", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("Compare the records"));
  assert.equal(calls.find(call => call.path === "/messages")?.body.text, "Compare the records");
}

function browserTabs(page: Page) {
  return page.evaluate(() => (window as Window & { browserTabs?: { id: string; owner: string; url: string }[] }).browserTabs ?? []);
}

const viewerLabels = locale === "en"
  ? { view: (name: string) => `View image: ${name}`, close: "Close", open: "Open source page", copyImage: "Copy image", imageCopied: "Image copied", checked: "Checked 5:41 PM" }
  : { view: (name: string) => `이미지 크게 보기: ${name}`, close: "닫기", open: "원본 페이지 열기", copyImage: "이미지 복사", imageCopied: "이미지를 복사했어요", checked: "오후 5:41 확인" };

/** Pictures served for the mock's asset ids (repo photos), so the viewer shows real pixels. */
const photos = ["butler.photo-clouds", "butler.photo-daisies", "butler.stipple"].map(name =>
  readFileSync(join(root, `packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/${name}/photo.jpg`)));
let servePhotos = false;
const withPhotos = (spec: AnswerBlocks) => ({ ...spec, blocks: spec.blocks.map(block => block.type !== "cards" ? block
  : { ...block, items: block.items.map(item => ({ ...item, checked: "2026-10-12T08:41:00Z", image_url: `/message-assets/${item.img}?expires=4102444800&signature=smoke` })) }) });

/** Hit areas: the card body opens the source in the conversation's browser, the picture opens the viewer. */
async function checkCardTargetsAndViewer(page: Page, width: number, theme: string) {
  servePhotos = true;
  await page.evaluate(() => { const w = window as Window & { browserTabs?: unknown[]; openedLinks?: unknown[] }; w.browserTabs = []; w.openedLinks = []; });
  await open(page, withPhotos(mock), width, theme);
  const cards = page.locator('[data-slot="item-card"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="item-card"] [data-slot="media-frame"]')].every(node => node.getAttribute("data-fit") === "cover"));
  const first = cards.first();
  // Hover styles apply on the next frame after the pointer moves.
  const background = () => first.evaluate(node => new Promise<string>(resolve => requestAnimationFrame(() => requestAnimationFrame(() =>
    resolve(getComputedStyle(node.firstElementChild!).backgroundColor)))));
  // A reader's scroll releases the conversation's bottom lock; a programmatic reveal does not.
  const scroller = page.locator('[data-test-class~="conversation-scroll"]');
  await scroller.hover();
  await page.mouse.wheel(0, -await scroller.evaluate(node => node.scrollHeight));
  await first.locator("li").first().scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const resting = await background();
  const fact = await first.locator("li").first().boundingBox();
  await page.mouse.move(fact!.x + fact!.width / 2, fact!.y + fact!.height / 2);
  const bodyHover = await background();
  const hoverTarget = await first.evaluate((node, point) => ({
    hit: document.elementFromPoint(point.x + point.width / 2, point.y + point.height / 2)?.outerHTML,
    hovered: [...document.querySelectorAll(":hover")].map(element => ({ tag: element.tagName, slot: element.getAttribute("data-slot"), className: element.className })),
    card: node.outerHTML,
    surface: getComputedStyle(node.firstElementChild!).getPropertyValue("--surface-raised"),
  }), fact!);
  await first.screenshot({ path: join(evidence, `card-hover-body-${locale}-${width}-${theme}.png`) });
  await first.getByRole("button", { name: labels.save, exact: true }).hover();
  const actionHover = await background();
  await first.locator('[data-item-card-media="viewer"]').hover();
  const pictureHover = await background();
  await first.screenshot({ path: join(evidence, `card-hover-picture-${locale}-${width}-${theme}.png`) });
  geometry.push({ cardHover: { width, theme, resting, bodyHover, actionHover, pictureHover } });
  writeFileSync(join(evidence, `card-hover-${locale}-${width}-${theme}.json`), JSON.stringify({ resting, bodyHover, actionHover, pictureHover, fact, hoverTarget }, null, 2));
  assert.notEqual(bodyHover, resting, "the card body shows the open affordance");
  assert.deepEqual([actionHover, pictureHover], [resting, resting], "actions and the picture drop the card's open hover");
  assert.equal(await first.locator('[data-item-card-media="viewer"]').evaluate(node => getComputedStyle(node).cursor), "zoom-in", "the picture reads as a viewer target");

  await first.locator("li").first().scrollIntoViewIfNeeded();
  const target = await first.locator("li").first().boundingBox();
  await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);
  const source = mock.blocks[0].type === "cards" ? mock.blocks[0].items[0].source! : "";
  await page.waitForFunction(() => ((window as Window & { browserTabs?: unknown[] }).browserTabs ?? []).length === 1);
  assert.deepEqual(await browserTabs(page), [{ id: "t1", owner: "conversation:butler-client", url: source }], "a click on the card body opens its source in the conversation's browser");

  const title = mock.blocks[0].type === "cards" ? mock.blocks[0].items[1].title : "";
  await page.getByRole("button", { name: viewerLabels.view(title), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal((await browserTabs(page)).length, 1, "the picture opens the viewer, not the page");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), viewerLabels.close, "focus starts on Close");
  assert((await dialog.innerText()).includes("2 / 4"));
  assert((await dialog.innerText()).includes(`musinsa.com · ${viewerLabels.checked}`), "the source line shows site and read time");
  await page.waitForFunction(() => ((document.querySelector('[data-slot="image-viewer"] img') as HTMLImageElement | null)?.naturalWidth ?? 0) > 0);
  await page.waitForFunction(() => document.getAnimations().filter(animation => ((animation.effect as KeyframeEffect | null)?.target as Element | null)
    ?.closest('[data-slot^="image-viewer"]')).every(animation => animation.playState === "finished"));
  await page.screenshot({ path: join(evidence, `viewer-${locale}-${width}-${theme}.png`) });
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector('[data-slot="image-viewer"]')?.textContent?.includes("3 / 4"));
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector('[data-slot="image-viewer"]')?.textContent?.includes("1 / 4"));
  await dialog.getByRole("button", { name: viewerLabels.copyImage, exact: true }).click();
  await page.waitForFunction(() => (window as Window & { copiedImage?: string[] }).copiedImage?.[0] === "image/png");
  await dialog.getByRole("button", { name: labels.save, exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("서랍에 저장했어요") || document.body.textContent?.includes("Saved to library"));
  assert(String(calls.filter(call => call.path === "/library").at(-1)?.body.crop).startsWith("data:image/jpeg"), "the saved scrap keeps the picture");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // Radix FocusScope restores focus in its deferred unmount callback, after the dialog detaches.
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-item-card-media") === "viewer");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-item-card-media")), "viewer", "focus returns to the picture");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  const box = await dialog.boundingBox();
  await page.mouse.click(box!.x + 8, box!.y + box!.height / 2);
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: viewerLabels.view(title), exact: true }).click();
  await dialog.getByRole("button", { name: viewerLabels.open, exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const opened = (await browserTabs(page)).at(-1);
  assert.deepEqual(opened, { id: "t2", owner: "conversation:butler-client", url: mock.blocks[0].type === "cards" ? mock.blocks[0].items[1].source : "" }, "the viewer opens the source in the conversation's browser");
  assert.deepEqual(await page.evaluate(() => (window as Window & { openedLinks?: string[] }).openedLinks), [], "no standalone user tab");
  writeFileSync(join(evidence, `conversation-tabs-${locale}-${width}-${theme}.json`), JSON.stringify({ tabs: await browserTabs(page),
    activated: await page.evaluate(() => (window as Window & { activated?: string[] }).activated) }, null, 2));
  servePhotos = false;
}

async function checkLeniencyAndExpand(page: Page) {
  const dateLabel = await page.evaluate(({ timestamp, dateLocale }) => new Date(timestamp).toLocaleDateString(dateLocale, { dateStyle: "short" }), {
    timestamp: "2026-10-11T08:41:00Z", dateLocale: locale === "en" ? "en-US" : "ko-KR",
  });
  const dsItems = fixtureItems("ko-KR").map(item => ({ title: item.title, label: item.eyebrow, sub: item.subtitle,
    facts: item.facts, text: item.text, source: `https://${item.site}`, checked: "2026-10-11T08:41:00Z" }));
  await open(page, { v: 1, blocks: [{ type: "cards", items: dsItems }] }, 390, "light");
  await page.locator('[data-slot="item-card"]').first().waitFor();
  assert.equal(await page.locator('[data-slot="item-card"]').count(), 5);
  const firstCardText = await page.locator('[data-slot="item-card"]').first().innerText();
  assert(firstCardText.includes(dateLabel), `expected locale short date ${dateLabel} in ${firstCardText}`);
  const oldSource = page.locator('[data-slot="item-card"]').first().locator('[data-slot="item-card-footer"] [role="button"]');
  const oldSourceLabel = locale === "en" ? `Checked on ${dateLabel} · papers.example.org` : `${dateLabel} 확인 · papers.example.org`;
  assert.equal(await oldSource.getAttribute("aria-label"), oldSourceLabel);
  assert.equal(await oldSource.getAttribute("title"), oldSourceLabel);

  const longItems = dsItems.map(item => ({ ...item, text: `${item.text} ${item.text} ${item.text} ${item.text}` }));
  await open(page, { v: 1, blocks: [{ type: "cards", items: longItems }] }, 320, "light");
  await page.locator('[data-slot="item-card"]').getByRole("button", { name: labels.showMore, exact: true }).first().click();
  await page.getByRole("button", { name: labels.showLess, exact: true }).first().waitFor();

  const card = neutral.blocks[0]; assert(card.type === "cards");
  for (const count of [5, 6, 11]) {
    const items = Array.from({ length: count }, (_, i) => ({ ...card.items[0], key: `record-${i}`, title: `Record ${i}`, img: undefined }));
    const spec = { v: 1, blocks: [{ type: "unknown", text: "Invisible" }, { type: "cards", items: [...items, { title: 3 }, { text: "unfinished" }] }] };
    await open(page, spec, 1440, "dark");
    const expected = Math.min(6, count);
    await page.waitForFunction(n => document.querySelectorAll('[data-slot="item-card"]').length === n, expected);
    assert.equal(await page.locator('[data-test-class="answer-cards"]').getAttribute("data-columns"), count === 5 ? "3" : "4");
    if (count > 6) {
      await page.getByRole("button", { name: labels.moreItems(count - 6), exact: true }).click();
      await page.waitForFunction(n => document.querySelectorAll('[data-slot="item-card"]').length === n, count);
      assert.equal(await page.locator('[data-test-class="answer-cards"]').getAttribute("data-columns"), "4");
    }
    assert(!(await page.locator('[data-test-class="answer-blocks"]').innerText()).includes("Invisible"));
  }
  await open(page, { v: 1, blocks: [{ type: "table", columns: ["Name", "Value"], rows: Array.from({ length: 12 }, (_, i) => [`Row ${i}`, i]) }] }, 390, "light");
  assert.equal(await page.locator("tbody tr").count(), 10);
  await page.getByRole("button", { name: labels.moreItems(2) }).click();
  assert.equal(await page.locator("tbody tr").count(), 12);
}

async function checkV2(page: Page, width: number, theme: string, background: string) {
  const fixture = JSON.parse(readFileSync(join(root, "tests/smoke/answer-blocks-mock.json"), "utf8"));
  const spec = fixture.v2 as AnswerBlocks;
  const expected = fixture.v2Markdown as string;
  servePhotos = true;
  await open(page, spec, width, theme, background);
  if (stage === "after") {
    const columns = page.locator('[data-slot="block-columns"] [data-answer-block]');
    const [first, second] = await columns.evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }));
    assert(first && second);
    if (width === 1440) assert(Math.abs(first.y - second.y) < 2 && second.x > first.x + first.width, "desktop columns share a row");
    else assert(second.y >= first.y + first.height && Math.abs(first.x - second.x) < 2, "phone columns stack");
    const checks = page.getByRole("checkbox");
    assert.equal(await checks.count(), 2);
    assert.deepEqual(await checks.evaluateAll(nodes => nodes.map(node => [node.getAttribute("aria-checked"), node.getAttribute("aria-readonly")])), [["true", "true"], ["false", "true"]]);
    await page.getByRole("tab", { name: "Picture", exact: true }).click();
    await page.locator('[data-answer-block="image"]').waitFor({ state: "visible" });
    const imageBlock = page.locator('[data-answer-block="image"]');
    const frame = await imageBlock.locator('[data-slot="media-frame"]').boundingBox();
    const target = await imageBlock.getByRole("button", { name: viewerLabels.view("Record image"), exact: true }).boundingBox();
    assert(frame && frame.width > 0 && frame.height > 0, "the image frame has visible dimensions");
    assert(target && target.width >= frame.width && target.height >= frame.height, "the click target contains the image");
    await page.waitForFunction(() => (document.querySelector('[data-answer-block="image"] img') as HTMLImageElement | null)?.naturalWidth);
    geometry.push({ v2Image: { width, theme, background, frame, target } });
    await page.getByRole("button", { name: viewerLabels.view("Record image"), exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, viewerLabels.view("Record image"));
    await page.getByRole("tab", { name: "Picture", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("tab", { name: "Status", exact: true, selected: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Status", exact: true }).getAttribute("aria-selected"), "true");
    const progress = page.getByRole("progressbar", { name: "Tasks", exact: true });
    assert.equal(await progress.getAttribute("aria-valuenow"), "25");
    await page.locator('[data-answer-block="metrics"]').scrollIntoViewIfNeeded();
    const danger = await page.locator('[data-answer-block="metrics"]').evaluate(node => {
      const delta = [...node.querySelectorAll("*")].find(child => child.textContent === "+2" && child.children.length === 0);
      const sample = document.createElement("span"); sample.style.color = "var(--color-danger)"; node.append(sample);
      const result = [delta ? getComputedStyle(delta).color : "missing", getComputedStyle(sample).color]; sample.remove(); return result;
    });
    assert.equal(danger[0], danger[1], "positive down-good delta uses danger");
    await page.locator('[data-test-class="assistant-footer"]').getByRole("button", { name: new RegExp(labels.copy) }).click();
    assert.equal(await page.evaluate(() => (window as Window & { copiedText?: string }).copiedText), `${message(spec).text}\n\n${expected}`);
  }
  await page.locator('[data-test-class~="conversation-scroll"]').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: join(evidence, `${locale}-${stage}-v2-${width}-${theme}-${background}.png`) });
  if (stage === "after") {
    await page.getByRole("tab", { name: "Picture", exact: true }).click();
    await page.locator('[data-answer-block="image"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `${locale}-${stage}-v2-image-${width}-${theme}-${background}.png`) });
    await page.locator('[data-answer-block="group"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, `${locale}-${stage}-v2-notes-${width}-${theme}-${background}.png`) });
  }
  servePhotos = false;
}

try {
  const page = await browser.newPage({ timezoneId: "Asia/Seoul", locale: locale === "en" ? "en-US" : "ko-KR", reducedMotion: "reduce" });
  await initialize(page);
  await page.clock.setFixedTime(new Date("2026-10-12T09:00:00Z"));
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
    if (url.pathname.startsWith("/message-assets/img_small") || url.pathname.startsWith("/message-assets/img_large")) return sizingAsset(route);
    if (servePhotos && url.pathname.startsWith("/message-assets/")) {
      const ids = mock.blocks[0].type === "cards" ? mock.blocks[0].items.map(item => item.img) : [];
      const index = Math.max(0, ids.indexOf(decodeURIComponent(url.pathname.split("/").at(-1)!)));
      return route.fulfill({ contentType: "image/jpeg", body: photos[index % photos.length] });
    }
    if (url.pathname.startsWith("/message-assets/") || url.pathname === "/favicons") return route.fulfill({ status: 404 });
    if (/^\/sessions\/[^/]+\/controls$/u.test(url.pathname)) return route.fulfill({ json: { ok: true, data: { session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1", controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } } } });
    if (url.pathname === "/session-queue") return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
    // The fixture's project has no canon plans; its sidebar reads the canon since 734a125f3.
    const canon = /^\/projects\/([^/]+)\/canon(\/sidebar)?$/u.exec(url.pathname);
    if (canon) return route.fulfill({ json: { ok: true, data: canon[2]
      ? { project_id: decodeURIComponent(canon[1]!), groups: [{ key: "backlog", kind: "backlog", title: "", rows: [] }] }
      : { project_id: decodeURIComponent(canon[1]!), backlog_revision: 0, backlog: [], plans: [] } } });
    if (["/session-view", "/summary", "/navigation", "/events/live", "/health"].includes(url.pathname)) return route.fulfill({ json: { ok: true, data: {} } });
    return route.continue();
  });
  if (!only || only === "existing") for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) await checkMock(page, width, theme, background);
  if (!only || only === "existing") for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const background of ["plain", "wallpaper"]) await checkV2(page, width, theme, background);
  if (!only || sizingOnly) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    geometry.push(await checkImageSizing(page, open, width, theme, stage, locale, evidence, viewerLabels));
  }
  if (stage === "after" && !sizingOnly) {
    await checkInteractions(page);
    await checkCardTargetsAndViewer(page, 1440, "light");
    await checkCardTargetsAndViewer(page, 390, "dark");
    await checkLeniencyAndExpand(page);
  }
  assert.deepEqual(errors, [], "no uncaught renderer errors");
  const result = { stage, ok: true, screenshots: stage === "after" ? 40 : 16, geometry, interactions: calls.map(call => call.path), modelCalls: 0 };
  result.screenshots += locale === "en" && stage === "after" ? 1 : 0;
  writeFileSync(join(evidence, `${locale}-${stage}-result.json`), JSON.stringify({ ...result, locale }, null, 2));
  console.log(JSON.stringify({ ...result, locale }));
} finally { await browser.close(); await vite.close(); }
