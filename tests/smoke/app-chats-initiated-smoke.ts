// test-category: race
// Real App UI with replayed gateway responses/events; no native screen or model required.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { initiatedMessage, installInitiatedGateway } from "../support/initiated-fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { proposalDecisions, pauseDecisions } from "../support/initiated-decisions";
import { probeFocusRingFrames } from "../support/focus-ring-clipping";

const output = process.env.BUTLER_INITIATED_CAPTURES;
const captions: string[] = [];
if (output) mkdirSync(output, { recursive: true });
const browser = await launchSmokeBrowser();
let cells = 0;
try {
  for (const [language, theme, width] of [
    ["ko", "light", 1440], ["ko", "dark", 1440], ["ko", "light", 390], ["ko", "dark", 390], ["en", "light", 1440],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const gateway = await installInitiatedGateway(page, language, theme);
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    const labels = copy.conversation.initiated;
    await page.goto("http://127.0.0.1:43827/");
    const panels = page.locator('[data-test-class="initiated-proposal"]');
    await panels.nth(1).waitFor().catch(async error => { console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() })); throw error; });
    assert.equal(await panels.count(), 2);
    console.log(JSON.stringify({ language, theme, width, stage: "proposal-pending" }));
    const firstAction = language === "ko" ? "예약 작업 · 매일 오전 7:50 · 환율·미국 증시 정리 · 10월 27일부터 · 대화로 받아요"
      : "Schedule · Daily at 7:50 AM · 환율·미국 증시 정리 · From Oct 27 · In Chats";
    await panels.first().getByText(firstAction, { exact: true }).waitFor();
    for (const panel of await panels.all()) {
      assert.deepEqual(await panel.locator("button").allTextContents(), [labels.noThanks, labels.soundsGood]);
      const geometry = await panel.evaluate(node => {
        const action = node.querySelector('[data-slot="composer-decision-actions"]')!;
        const buttons = action.querySelectorAll("button");
        const subject = node.closest('[data-test-class="message-body"]')!;
        const card = node.closest('[data-slot="card"]')!;
        const bubble = subject.querySelector('[data-test-class="assistant-bubble"]')!;
        return { buttonRight: buttons[1].getBoundingClientRect().right, actionRight: action.getBoundingClientRect().right - parseFloat(getComputedStyle(action).paddingRight),
          left: card.getBoundingClientRect().left, bubbleLeft: bubble.getBoundingClientRect().left,
          width: card.getBoundingClientRect().width, max: Math.min(440, node.closest("article")!.getBoundingClientRect().width * .68) };
      });
      assert(Math.abs(geometry.buttonRight - geometry.actionRight) < 1, "actions align right");
      assert(Math.abs(geometry.left - geometry.bubbleLeft) < 1, "panel aligns to bubble");
      assert(geometry.width <= geometry.max + .5, "panel respects bubble cap");
      for (const button of await panel.getByRole("button").all()) assert.deepEqual(await probeFocusRingFrames(page, () => button.focus()), []);
    }
    await capture(page, panels, "proposal-pending", "먼저 제안한 예약 작업 두 개 · 처리 전", language, theme, width);
    const captureDecision = (region: Locator, name: string, caption: string) => capture(page, region, name, caption, language, theme, width);
    await proposalDecisions(page, gateway, language, captureDecision);
    if (language === "en") {
      await gateway.approval();
      await page.getByText("Weekdays at 7:50 AM", { exact: true }).waitFor();
      await gateway.approval("daily");
      await page.getByText("Daily at 7:50 AM", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      await page.close(); cells++; continue;
    }
    await gateway.show(initiatedMessage("report"));
    const bubble = page.locator('[data-test-class="assistant-bubble"]');
    await bubble.getByText("오늘 아침 소식을 정리했어요. 자세한 내용은 문서로 드릴게요.", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-test-class~="message"][data-test-class~="user"]').count(), 0);
    assert.equal(await bubble.count(), 1, "report has only a Butler bubble");
    await page.locator('[data-test-class="message-artifact-list"]').waitFor();
    assert.equal(await page.locator('[data-test-class="assistant-terminal-status-row"]').count(), 0);
    assert.equal(await page.locator('[data-test-class~="assistant-footer"] time').count(), 1);
    await capture(page, page.locator('[data-test-class~="message"][data-test-class~="assistant"]'), "schedule-report", "예약 작업 보고와 첨부 문서", language, theme, width);
    await gateway.show(initiatedMessage("pause"));
    const pause = page.locator('[data-test-class="initiated-pause"]');
    await pause.waitFor();
    await capture(page, pause, "pause-pending", "보고를 계속 받을지 묻는 예약 작업", language, theme, width);
    await pauseDecisions(page, gateway, (region, name, caption) => width === 1440 && theme === "light"
      ? captureDecision(region, name, caption) : Promise.resolve());
    if (width === 1440 && theme === "light") await composing(page, gateway.requests);
    await unreadAndNotifications(page, gateway, language, theme, width);
    await gateway.approval();
    const approval = page.locator('[data-test-class="composer-authority-decision"]');
    await page.getByText("평일 오전 7:50", { exact: true }).waitFor();
    await capture(page, approval, "approval-weekdays", "평일 예약 작업을 만드는 승인 카드", language, theme, width);
    if (width === 1440 && theme === "light") {
      await gateway.approval("daily");
      await page.getByText("매일 오전 7:50", { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await page.close(); cells++;
  }
  if (output) writeFileSync(join(output, "captions.txt"), captions.join("\n") + "\n");
  console.log(JSON.stringify({ result: "PASS", cells, captures: captions.filter(line => !line.startsWith("##")).length, modelCalls: 0, conditions: "Headless Chromium; 2x scale; stub gateway; no Mac display dependency" }));
} finally { await browser.close(); }

async function composing(page: Page, requests: { path: string; at: number }[]) {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill("아침");
  await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent === "아침");
  await editor.pressSequentially(" 소식", { delay: 100 });
  await page.waitForTimeout(4200);
  const leases = () => requests.filter(request => request.path === "/sessions/general/composing");
  assert.equal(leases().length, 1, "idle draft does not renew the lease");
  await editor.pressSequentially(" 정리", { delay: 100 });
  await page.waitForTimeout(100);
  assert.equal(leases().length, 2);
  assert(leases()[1].at - leases()[0].at >= 4000, "typing renews no more than once per four seconds");
  await editor.fill("");
  await page.waitForTimeout(4100);
  assert.equal(leases().length, 2, "empty/idle composer never posts");
  console.log(JSON.stringify({ composingPosts: 2, minimumSpacingMs: leases()[1].at - leases()[0].at, idlePosts: 0 }));
}

async function showSidebar(page: Page) {
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  if (await sidebar.getAttribute("data-collapsed") === "true") await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
}
async function unreadAndNotifications(page: Page, gateway: Awaited<ReturnType<typeof installInitiatedGateway>>, language: "ko", theme: string, width: number) {
  await showSidebar(page);
  await page.getByRole("button", { name: "다른 대화", exact: true }).click();
  const before = await page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications.length);
  const report = initiatedMessage("report"); report.created_at = "2026-10-26T21:00:00Z";
  await gateway.arrive(report);
  await showSidebar(page);
  await page.mouse.move(width - 1, 959);
  const row = page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"][aria-label="대화"]');
  await row.locator('[data-slot="unread-dot"]').waitFor();
  await page.waitForFunction(count => (window as unknown as { __notifications: unknown[] }).__notifications.length === count + 1, before);
  const quiet = { ...report, id: "quiet-report", quiet: true, initiated: { ...report.initiated!, quiet: true } };
  await gateway.arrive(quiet);
  // A response to the following event establishes that the event callback has run.
  await page.waitForResponse(response => response.url().endsWith("/navigation"));
  assert.equal(await page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications.length), before + 1);
  await capture(page, row, "chats-unread", "다른 대화를 보는 동안 도착한 보고 · 대화 읽지 않음", language, theme, width);
  const read = page.waitForRequest(request => request.url().endsWith("/sessions/general/read") && request.method() === "POST");
  await row.click();
  await read;
  await showSidebar(page);
  await page.mouse.move(width - 1, 959);
  assert.equal(await row.locator('[data-slot="unread-dot"]').count(), 0);
  if (width === 390) await page.locator('[data-slot="button"][aria-label="사이드바 숨기기"]').click();
}

async function capture(page: Page, region: Locator, name: string, caption: string, language: string, theme: string, width: number) {
  if (!output) return;
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); return document.fonts.ready; });
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  const targets = name === "schedule-report" ? page.locator('[data-test-class="assistant-bubble"], [data-test-class="message-artifact-list"], [data-test-class~="assistant-footer"] time') : region;
  const boxes = await targets.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
  assert(boxes.length, `capture region ${name} exists`);
  if (name.startsWith("proposal-") || name.startsWith("pause-")) {
    const bubble = await region.first().evaluate(node => {
      const r = node.closest('[data-test-class="message-body"]')!.querySelector('[data-test-class="assistant-bubble"]')!.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    });
    boxes.push(bubble);
  }
  const x = Math.max(0, Math.min(...boxes.map(box => box.x)) - 12), y = Math.max(0, Math.min(...boxes.map(box => box.y)) - 12);
  const right = Math.min(width, Math.max(...boxes.map(box => box.right)) + 12), bottom = Math.min(960, Math.max(...boxes.map(box => box.bottom)) + 12);
  const filename = `${name}-${language}-${theme}-${width}.jpg`;
  // CSS crop is <=800px on the longest side, producing <=1600px at 2x.
  await page.screenshot({ path: join(output, filename), type: "jpeg", quality: 80, animations: "disabled",
    clip: { x, y, width: Math.min(800, right - x), height: Math.min(800, bottom - y) } });
  const section = `## ${language} · ${theme} · ${width}`;
  if (!captions.includes(section)) captions.push(section);
  captions.push(`${filename}\t${caption}`);
}
