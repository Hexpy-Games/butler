// Browser behavior smoke: deterministic stub streaming, real virtual list and observer.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { checkCapturedActivity } from "./activity-capture-support";
import { assertOrder, checkActivityOrderScenarios, checkFoldSettles, gapBetween, offsetIn, waitPinned } from "./activity-order-support";
import { smokeBrowserArgs } from "../support/smoke-browser";

const uiRoot = resolve("packages/butler-app/client/ui/dist");
const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/activity-layout");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(uiRoot, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(uiRoot, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const measurements: Array<{ width: number; theme: string; distance: number }> = [];
const spacing: Array<{ width: number; theme: string; live: number; status: number; completed: number; observer: number }> = [];
const scenarios: Array<{ width: number; theme: string; firstDeltaShift: number }> = [];
const ACTIVITY = '[data-test-class="turn-current-phase-activity"]';
const TEXT = '[data-test-class="turn-result-section"]';
const STATUS = '[data-test-class="turn-live-status"]';
const STATUS_LINE = '[data-test-class="turn-live-status-line"]';
const HEADER = '[data-test-class="toggle-turn-activity-disclosure"]';
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}`);
    const message = page.locator('[data-test-class="message assistant"]').last();
    const status = message.locator(STATUS);
    await status.waitFor();
    assert.equal(await message.locator('[data-test-class="assistant-footer"]').count(), 0, "streaming hides footer");
    assert.equal(await message.locator(ACTIVITY).count(), 1, "one live activity, no completed summary");
    await assertOrder(message, [ACTIVITY, TEXT, STATUS], "streaming order: activity, text, status");
    await page.waitForFunction(() => {
      const scroll = document.querySelector('[data-test-class~="conversation-scroll"]');
      return scroll && scroll.scrollHeight > scroll.clientHeight;
    });
    await page.waitForFunction(() => ([...document.querySelectorAll('[data-test-class="markdown-document"]')].at(-1)?.textContent?.length ?? 0) >= 70);
    await waitPinned(page, "mid-stream");
    await page.locator('[data-stub-stream-complete="true"]').waitFor();
    await page.waitForTimeout(240);
    const distance = await page.locator('[data-test-class~="conversation-scroll"]').evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    measurements.push({ width, theme, distance });
    const streamedText = await message.locator('[data-test-class="markdown-document"]').innerText();
    assert(distance <= 2, `streaming remains pinned: ${distance}px`);
    const liveGap = await gapBetween(message, ACTIVITY, TEXT);
    assert.equal(liveGap, 16, "live activity/answer uses the DS lg gap");
    const statusGap = await gapBetween(message, TEXT, STATUS_LINE);
    assert.equal(statusGap, 16, "live answer/status uses the DS lg gap");
    const liveHeader = await offsetIn(message, HEADER);
    await page.screenshot({ path: join(output, `running-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "완료", exact: true }).click();
    const summary = message.getByRole("button", { name: /활동 · 완료/ });
    await summary.waitFor();
    assert.equal(await message.locator('[data-test-class="markdown-document"]').innerText(), streamedText, "completion retains all streamed content");
    await status.waitFor({ state: "detached" });
    assert.equal(await message.locator('[data-test-class="turn-current-step"]').count(), 0, "live step folded on completion");
    assert.equal(await offsetIn(message, HEADER), liveHeader, "completion keeps the activity header in place");
    assert.equal(await message.locator('[data-test-class="assistant-footer"]').count(), 1);
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    assert(await message.evaluate((node) => {
      const summary = node.querySelector('[data-test-class="turn-current-phase-activity"]')!;
      const answer = node.querySelector('[data-test-class="turn-result-section"]')!;
      const footer = node.querySelector('[data-test-class="assistant-footer"]')!;
      return Boolean(summary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        Boolean(answer.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "completed summary precedes answer and footer");
    const completedGap = await gapBetween(message, ACTIVITY, TEXT);
    assert.equal(completedGap, liveGap, "completion keeps the same gap without a spacing jump");
    await page.screenshot({ path: join(output, `completed-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "작업 기록", exact: true }).click();
    const dialog = page.locator('[data-test-class="activity-layout-observer"]');
    const history = dialog.getByRole("button", { name: /활동 · 완료/ });
    await history.waitFor();
    await history.click();
    await dialog.getByText("활동 화면 확인", { exact: true }).last().waitFor();
    await dialog.locator('[data-test-class~="turn-work-tool-group"] > button').click();
    const tools = dialog.locator('[data-test-class="turn-work-tool-detail-row"]');
    assert.equal(await tools.count(), 2, "observer keeps every tool row after completion");
    assert((await tools.allTextContents()).join(" ").includes("보고서.txt"));
    await tools.last().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
    assert.equal(await dialog.locator('[data-test-class~="current-turn-status"]').count(), 0);
    assert(!/Steward|스튜어드/i.test(await dialog.innerText()));
    const observerGap = await dialog.locator('[data-test-class="steward-observer-message"]').first().evaluate(node =>
      node.nextElementSibling!.getBoundingClientRect().top - node.getBoundingClientRect().bottom);
    assert.equal(observerGap, liveGap, "observer transcript uses the same DS gap");
    spacing.push({ width, theme, live: liveGap, status: statusGap, completed: completedGap, observer: observerGap });
    await dialog.screenshot({ path: join(output, `work-completed-${width}-${theme}.png`) });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}&state=completed&list=1`);
    await page.getByRole("button", { name: /활동 · 완료/ }).nth(3).waitFor();
    assert.equal(await page.locator('[data-test-class="assistant-footer"]').count(), 4);
    await page.setViewportSize({ width, height: 1200 });
    await page.screenshot({ path: join(output, `completed-list-${width}-${theme}.png`) });

    for (const state of ["running", "completed"]) {
      await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}&state=${state}&approval=1`);
      const approval = page.locator('[data-test-class="composer-authority-decision"]');
      await approval.waitFor();
      const text = await approval.innerText();
      assert(text.includes("읽기 전용") && text.includes("파일") && text.includes("C:\\Users\\test\\Downloads"), "approval shows tool, access and exact path");
      await approval.screenshot({ path: join(output, `approval-${state}-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "작업 기록", exact: true }).click();
      const observer = page.locator('[data-test-class="activity-layout-observer"]');
      await observer.locator('[data-test-class="turn-current-phase-activity"] [data-test-class="toggle-turn-activity-disclosure"]').click();
      await observer.locator('[data-test-class~="turn-work-tool-group"] > button').click();
      assert.equal(await observer.locator('[data-test-class="turn-work-tool-detail-row"]').count(), 2, `${state} observer lists all tools`);
      await observer.locator('[data-test-class="turn-work-tool-detail-row"]').last().waitFor({ state: "visible" });
      const observerRows = observer.locator('[data-test-class="steward-observer-message"]');
      for (let index = 0; index < await observerRows.count() - 1; index++) {
        assert.equal(await observerRows.nth(index).evaluate(node =>
          node.nextElementSibling!.getBoundingClientRect().top - node.getBoundingClientRect().bottom), 16, `${state} observer spacing`);
      }
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      await page.screenshot({ path: join(output, `observer-${state}-${width}-${theme}.png`) });
    }

    const scenario = await checkActivityOrderScenarios(page, `http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}`, output, `${width}-${theme}`);
    scenarios.push({ width, theme, ...scenario });
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=dark`);
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  const fold = await foldFrames(page);
  const foldEnd = await checkFoldSettles(page, `http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=dark`);
  assert(foldEnd.folds > 0, "completion runs the fold");
  assert(Math.abs(foldEnd.end.text - foldEnd.settled.text) <= 0.5 && Math.abs(foldEnd.end.height - foldEnd.settled.height) <= 0.5,
    `fold ends where it settles, without a spacing snap: ${JSON.stringify(foldEnd)}`);
  const normalTurn = page.locator('[data-test-class="message assistant"]').last();
  await normalTurn.getByRole("button", { name: /활동 · 완료/ }).waitFor();
  assert.equal(await normalTurn.locator('[data-test-class="assistant-footer"]').count(), 1);
  assert.equal(await normalTurn.locator('[data-test-class~="turn-activity-panel"]').count(), 0);
  await checkCapturedActivity(page, `http://127.0.0.1:${server.port}`, output);
  console.log(JSON.stringify({ ok: true, screenshots: 48, measurements, spacing, scenarios, fold, foldEnd, checks: ["stream-order", "first-delta", "multi-round", "no-text", "no-tools", "two-segments", "settle-order", "decision-row", "answer-parts-order", "retrying-live", "empty-final-segment", "completion-fold", "fold-no-snap", "single-footer", "completed-history", "observer-history", "autoscroll", "completed-list", "ko-light-dark-mobile-desktop", "normal-and-reduced-motion"] }));
} finally { await browser.close(); server.stop(true); }

/** Clicks completion and samples the text's offset inside its message every frame until the fold settles. */
async function foldFrames(page: import("playwright").Page) {
  const frames = await page.evaluate(async () => {
    const message = () => [...document.querySelectorAll('[data-test-class="message assistant"]')].at(-1)!;
    const offset = () => message().querySelector('[data-test-class="turn-result-section"]')!.getBoundingClientRect().top - message().getBoundingClientRect().top;
    const samples = [offset()];
    [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === "완료")!.click();
    const start = performance.now();
    await new Promise<void>(resolve => {
      const tick = () => { samples.push(offset()); if (performance.now() - start < 600) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
    return samples.map(value => Math.round(value * 10) / 10);
  });
  const start = frames[0]!, end = frames.at(-1)!;
  assert(end < start, `completion raises the text inside its message: ${start} -> ${end}`);
  assert(frames.every((value, index) => index === 0 || value <= frames[index - 1]! + 0.5), `fold moves one way: ${frames.join(",")}`);
  assert(frames.some(value => value < start - 1 && value > end + 1), `fold animates through intermediate frames: ${frames.join(",")}`);
  return { start, end, frames: frames.length };
}
