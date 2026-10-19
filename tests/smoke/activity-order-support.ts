// Activity order through the stub-stream harness: activity, then text, then the live status line.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Locator, Page } from "playwright";

const MESSAGE = '[data-test-class="message assistant"]';
const ACTIVITY = '[data-test-class="turn-current-phase-activity"]';
const TEXT = '[data-test-class="turn-result-section"]';
const STATUS = '[data-test-class="turn-live-status"]';
const HEADER = '[data-test-class="toggle-turn-activity-disclosure"]';
const ROW = '[data-test-class~="turn-activity-message"]';
const LIVE_HEADER = '[data-test-class="turn-current-phase-activity"][aria-label="현재 작업"]';

/** Each selector's first match inside `root` must follow the previous one in document order. */
export async function assertOrder(root: Locator, selectors: string[], message: string) {
  assert(await root.evaluate((node, list) => list.every((selector, index) => {
    if (index === 0) return true;
    const before = node.querySelector(list[index - 1]!);
    const after = node.querySelector(selector);
    return Boolean(before && after && before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), selectors), message);
}

/** Vertical gap between the bottom of `upper` and the top of `lower`. */
export function gapBetween(root: Locator, upper: string, lower: string) {
  return root.evaluate((node, [a, b]) => node.querySelector(b!)!.getBoundingClientRect().top -
    node.querySelector(a!)!.getBoundingClientRect().bottom, [upper, lower]);
}

/** Top of `selector` relative to the top of `root` (layout position inside the message). */
export function offsetIn(root: Locator, selector: string) {
  return root.evaluate((node, inner) => node.querySelector(inner)!.getBoundingClientRect().top -
    node.getBoundingClientRect().top, selector);
}

export async function waitPinned(page: Page, label: string) {
  await page.waitForFunction(() => {
    const scroll = document.querySelector('[data-test-class~="conversation-scroll"]')!;
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2;
  }, undefined, { timeout: 2000 }).catch(() => assert.fail(`${label}: scroll stays pinned to the bottom`));
}

/** Position of `selector` in the scrolled content, independent of the current scroll offset. */
function contentTop(target: Locator) {
  return target.evaluate((node) => {
    const scroll = document.querySelector('[data-test-class~="conversation-scroll"]')!;
    return node.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  });
}

async function textOf(message: Locator) {
  return message.locator('[data-test-class="markdown-document"]').innerText();
}

/** Pre-first-delta row, then the first delta: the activity keeps its place and text lands between activity and status. */
async function firstDelta(page: Page, url: string, shot: string) {
  await page.goto(`${url}&delta=wait`);
  const row = page.locator(ROW);
  await row.locator(ACTIVITY).waitFor();
  await assertOrder(row, [ACTIVITY, '[data-test-class="turn-current-status-slot"]'], "activity row: activity, then status");
  const before = await contentTop(row.locator(HEADER));
  await page.screenshot({ path: `${shot}-before-delta.png` });
  await page.getByRole("button", { name: "답변 시작", exact: true }).click();
  const message = page.locator(MESSAGE).last();
  await message.locator(TEXT).waitFor();
  assert.equal(await row.count(), 0, "first delta replaces the activity row");
  await assertOrder(message, [ACTIVITY, TEXT, STATUS], "first delta: activity, text, status");
  const after = await contentTop(message.locator(HEADER));
  // The activity row's MessageRow body has no 2px top padding; the message body keeps it (DS block).
  const bodyPadding = await message.locator('[data-test-class="message-body"]').evaluate(node => parseFloat(getComputedStyle(node).paddingTop));
  assert.equal(after - before, bodyPadding, `first delta moves the activity only by the body padding: ${before} -> ${after}`);
  return after - before;
}

/** Round two replaces round one's text; the activity stays one block above it. */
async function multiRound(page: Page, url: string, shot: string) {
  await page.goto(`${url}&rounds=2`);
  const message = page.locator(MESSAGE).last();
  await message.getByText("첫 라운드 중간 답변입니다.").first().waitFor();
  assert.equal(await message.locator(ACTIVITY).count(), 1, "round one: one activity block");
  await assertOrder(message, [ACTIVITY, TEXT, STATUS], "round one: activity, text, status");
  const header = await offsetIn(message, HEADER);
  await message.getByRole("button", { name: /현재 · .* · 2개 기록/ }).waitFor();
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  assert(!(await textOf(message)).includes("첫 라운드"), "round two text replaces round one");
  assert.equal(await message.locator(ACTIVITY).count(), 1, "round two: still one activity block");
  await assertOrder(message, [ACTIVITY, TEXT, STATUS], "round two: activity, text, status");
  assert.equal(await offsetIn(message, HEADER), header, "round two keeps the activity header in place");
  await waitPinned(page, "round two");
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await message.getByRole("button", { name: "활동 · 완료 · 2개 기록" }).waitFor();
  await message.locator(STATUS).waitFor({ state: "detached" });
  assert.equal(await message.locator(ACTIVITY).count(), 1, "completed multi-round turn keeps one summary");
  await assertOrder(message, [ACTIVITY, TEXT, '[data-test-class="assistant-footer"]'], "multi-round completed order");
  assert.equal(await offsetIn(message, HEADER), header, "completion keeps the multi-round header in place");
  await page.screenshot({ path: `${shot}-multi-round.png` });
}

/** A turn that never streams text: activity row only, then a summary with no live status. */
async function noText(page: Page, url: string, shot: string) {
  await page.goto(`${url}&answer=none`);
  const row = page.locator(ROW);
  await row.locator(ACTIVITY).waitFor();
  await assertOrder(row, [ACTIVITY, '[data-test-class="turn-current-status-slot"]'], "no-text row: activity, then status");
  await page.getByRole("button", { name: "완료", exact: true }).click();
  const message = page.locator(MESSAGE).last();
  await message.getByRole("button", { name: /활동 · 완료/ }).waitFor();
  assert.equal(await row.count(), 0, "completion removes the activity row");
  assert.equal(await message.locator(STATUS).count(), 0, "no live status after completion");
  assert.equal(await message.locator('[data-test-class="assistant-footer"]').count(), 1);
  await page.screenshot({ path: `${shot}-no-text.png` });
}

/** A turn without tools: text first, no empty activity slot and no disclosure chevron. */
async function noTools(page: Page, url: string, shot: string) {
  await page.goto(`${url}&tools=0`);
  const message = page.locator(MESSAGE).last();
  await message.locator(TEXT).waitFor();
  const firstChild = () => message.evaluate((node, text) => {
    const first = node.querySelector('[data-test-class="message-body"]')!.firstElementChild!;
    return first.matches(text) || first.querySelector(text) !== null;
  }, TEXT);
  assert(await firstChild(), "no-tools turn starts with its text");
  assert.equal(await message.locator(HEADER).count(), 0, "no-tools turn has no chevron");
  await assertOrder(message, [TEXT, STATUS], "no-tools turn: text, then status");
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await message.locator('[data-test-class="assistant-footer"]').waitFor();
  await message.locator(STATUS).waitFor({ state: "detached" });
  assert(await firstChild(), "completed no-tools turn starts with its text");
  assert.equal(await message.locator(`${HEADER}, ${ACTIVITY}`).count(), 0, "completed no-tools turn has no activity");
  await page.screenshot({ path: `${shot}-no-tools.png` });
}

/** A delivered first segment keeps its summary; the live activity follows it, then moves to the next segment. */
async function twoSegments(page: Page, url: string, shot: string) {
  await page.goto(`${url}&segments=2`);
  const first = page.locator(MESSAGE).filter({ hasText: "질문 전에 확인한 내용입니다." });
  const row = page.locator(ROW);
  await row.locator(ACTIVITY).waitFor();
  await first.getByRole("button", { name: /^활동 · / }).waitFor();
  assert.equal(await first.locator(`${STATUS}, ${LIVE_HEADER}`).count(), 0, "delivered segment keeps its settled summary");
  await assertOrder(first, [ACTIVITY, TEXT], "delivered segment: summary, then text");
  assert(await first.evaluate((node, selector) => Boolean(node.compareDocumentPosition(document.querySelector(selector)!) &
    Node.DOCUMENT_POSITION_FOLLOWING), ROW), "live activity row follows the delivered segment");
  const firstHeader = await offsetIn(first, HEADER);
  await page.screenshot({ path: `${shot}-segment-wait.png` });
  await page.getByRole("button", { name: "답변 시작", exact: true }).click();
  const second = page.locator(MESSAGE).last();
  await second.locator(TEXT).waitFor();
  assert.equal(await row.count(), 0, "the next segment takes the live activity");
  await assertOrder(second, [LIVE_HEADER, TEXT, STATUS], "streaming segment: activity, text, status");
  assert.equal(await first.locator(`${STATUS}, ${LIVE_HEADER}`).count(), 0, "earlier segment stays settled");
  assert.equal(await offsetIn(first, HEADER), firstHeader, "earlier segment keeps its header in place");
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  await page.screenshot({ path: `${shot}-segment-streaming.png` });
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await second.locator(STATUS).waitFor({ state: "detached" });
  await assertOrder(second, [ACTIVITY, TEXT, '[data-test-class="assistant-footer"]'], "completed segment order");
  await page.screenshot({ path: `${shot}-segment-completed.png` });
}

/** Progress and message settle in either order; the header never leaves its slot. */
async function settleOrder(page: Page, url: string, order: string) {
  await page.goto(`${url}&settle=${order}`);
  const message = page.locator(MESSAGE).last();
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  const live = await offsetIn(message, HEADER);
  const samples = await page.evaluate(async () => {
    const values: Array<number | null> = [];
    [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === "완료")!.click();
    const start = performance.now();
    await new Promise<void>(resolve => {
      const tick = () => {
        const node = [...document.querySelectorAll('[data-test-class="message assistant"]')].at(-1)!;
        const header = node.querySelector('[data-test-class="toggle-turn-activity-disclosure"]');
        values.push(header ? header.getBoundingClientRect().top - node.getBoundingClientRect().top : null);
        if (performance.now() - start < 900) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    return values;
  });
  assert(samples.every(value => value === live), `${order}: header stays at ${live}: ${samples.join(",")}`);
  await message.getByRole("button", { name: /활동 · 완료/ }).waitFor();
  await message.locator('[data-test-class="assistant-footer"]').waitFor();
  assert.equal(await message.locator(STATUS).count(), 0, `${order}: live status gone`);
}

/** A live decision row sits above the text and folds away with its spacing on completion. */
async function decisionRow(page: Page, url: string) {
  await page.goto(`${url}&rows=decision`);
  const message = page.locator(MESSAGE).last();
  await message.locator('[data-test-class="turn-decision-row"]').waitFor();
  await assertOrder(message, ['[data-test-class="turn-decision-row"]', TEXT, STATUS], "decision: row, text, status");
  assert.equal(await gapBetween(message, '[data-test-class="turn-decision-row"]', TEXT), 16, "decision row keeps the DS lg gap");
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await message.locator('[data-test-class="turn-live-work"]').waitFor({ state: "detached" });
  await message.locator('[data-test-class="assistant-footer"]').waitFor();
  assert.equal(await offsetIn(message, TEXT), await message.locator('[data-test-class="message-body"]').evaluate(node =>
    parseFloat(getComputedStyle(node).paddingTop)), "completed decision turn starts with its text");
}

/** The answer's own parts (changed files) stay with the answer; the status line comes after them. */
async function answerParts(page: Page, url: string) {
  await page.goto(`${url}&files=1`);
  const message = page.locator(MESSAGE).last();
  const files = '[data-test-class="message-changed-file-list"]';
  await message.locator(files).waitFor();
  await assertOrder(message, [LIVE_HEADER, TEXT, files, STATUS], "streaming: activity, text, files, status");
  assert(await message.evaluate((node, status) => {
    const body = node.querySelector('[data-test-class="message-body"]')!;
    return [...body.children].at(-1)!.querySelector(status) !== null || [...body.children].at(-1)!.matches(status);
  }, STATUS), "the status line is the last body part while streaming");
  const filesBelowText = () => message.evaluate((node, [text, list]) => node.querySelector(list!)!.getBoundingClientRect().top -
    node.querySelector(text!)!.getBoundingClientRect().top, [TEXT, files]);
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  const live = await filesBelowText();
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await message.locator('[data-test-class="assistant-footer"]').waitFor();
  await message.locator(STATUS).waitFor({ state: "detached" });
  await assertOrder(message, [TEXT, files, '[data-test-class="assistant-footer"]'], "completed: text, files, footer");
  assert.equal(await filesBelowText(), live, "changed files keep their place under the text through completion");
}

/** In-progress statuses other than streaming (retrying) keep the live activity on the message. */
async function retryingMessage(page: Page, url: string) {
  await page.goto(`${url}&status=retrying`);
  const message = page.locator(MESSAGE).last();
  await message.locator(LIVE_HEADER).waitFor();
  assert.equal(await page.locator(ROW).count(), 0, "retrying message carries the live activity");
  await assertOrder(message, [LIVE_HEADER, TEXT, STATUS], "retrying: activity, text, status");
}

/** A final segment delivered with `[]` rows has no activity of its own; the earlier segment keeps its summary. */
async function emptyFinalSegment(page: Page, url: string) {
  await page.goto(`${url}&segments=2&final=empty`);
  await page.getByRole("button", { name: "답변 시작", exact: true }).click();
  const last = page.locator(MESSAGE).last();
  await last.locator(LIVE_HEADER).waitFor();
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  await page.getByRole("button", { name: "완료", exact: true }).click();
  await last.locator('[data-test-class="assistant-footer"]').waitFor();
  await last.locator(STATUS).waitFor({ state: "detached" });
  assert.equal(await last.locator(`${ACTIVITY}, ${HEADER}`).count(), 0, "empty final segment shows no activity");
  const first = page.locator(MESSAGE).filter({ hasText: "질문 전에 확인한 내용입니다." });
  assert.equal(await first.getByRole("button", { name: /^활동 · / }).count(), 1, "earlier segment keeps its summary");
}

/** The fold ends where it settles: no spacing snaps after the closing content unmounts. */
export async function checkFoldSettles(page: Page, url: string) {
  await page.goto(url);
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  return page.evaluate(async () => {
    const read = () => {
      const node = [...document.querySelectorAll('[data-test-class="message assistant"]')].at(-1)!;
      const text = node.querySelector('[data-test-class="turn-result-section"]')!;
      return { text: text.getBoundingClientRect().top - node.getBoundingClientRect().top, height: node.getBoundingClientRect().height };
    };
    [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === "완료")!.click();
    await new Promise(requestAnimationFrame);
    const folds = document.getAnimations().filter(animation => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity);
    folds.forEach(animation => { animation.pause(); animation.currentTime = Number(animation.effect!.getComputedTiming().endTime); });
    const end = read();
    folds.forEach(animation => animation.play());
    await new Promise(resolve => setTimeout(resolve, 400));
    return { folds: folds.length, end, settled: read() };
  });
}

export async function checkActivityOrderScenarios(page: Page, url: string, output: string, cell: string) {
  const shot = join(output, `order-${cell}`);
  const firstDeltaShift = await firstDelta(page, url, shot);
  await multiRound(page, url, shot);
  await noText(page, url, shot);
  await noTools(page, url, shot);
  await twoSegments(page, url, shot);
  for (const order of ["progress-first", "message-first"]) await settleOrder(page, url, order);
  await decisionRow(page, url);
  await answerParts(page, url);
  await retryingMessage(page, url);
  await emptyFinalSegment(page, url);
  return { firstDeltaShift };
}
