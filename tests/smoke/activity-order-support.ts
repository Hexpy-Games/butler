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

export async function checkActivityOrderScenarios(page: Page, url: string, output: string, cell: string) {
  const shot = join(output, `order-${cell}`);
  const firstDeltaShift = await firstDelta(page, url, shot);
  await multiRound(page, url, shot);
  await noText(page, url, shot);
  await noTools(page, url, shot);
  return { firstDeltaShift };
}
