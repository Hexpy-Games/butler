// test-category: race
// Real renderer with stub gateway transport. No model or native app is started.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { installInitiatedGateway, session } from "../support/initiated-fixtures";
import { approvalNeeded, commandApproval, commandCredential, longEditPath, longPathApproval, maskedCommand, workFailed, workResult, workSessionId, workTitle } from "../support/work-result-fixtures";
import { probeFocusRingFrames } from "../support/focus-ring-clipping";
import { launchSmokeBrowser, smokeBrowserArgs } from "../support/smoke-browser";

const output = process.env.BUTLER_RESULTS_CAPTURES;
const captions: string[] = [];
if (output) mkdirSync(output, { recursive: true });
const browser = await launchSmokeBrowser();
let cells = 0;
try {
  for (const [language, theme, width] of [
    ["ko", "light", 1440], ["ko", "dark", 1440], ["ko", "light", 390], ["ko", "dark", 390], ["en", "light", 1440], ["en", "dark", 1440],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const gateway = await installInitiatedGateway(page, language, theme, session([workResult(language === "en")]), true);
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    const capture = (region: Locator, name: string, caption: string) => captureRegion(page, region, name, caption, language, theme, width);
    await page.goto("http://127.0.0.1:43827/");
    await resultBubble(page, gateway, copy.conversation.initiated.viewWork, language === "en", capture);
    await failedWorkLines(page, gateway, copy.conversation.initiated, language === "en", capture);
    await attentionLine(page, gateway, copy.conversation.initiated.needsApproval, language === "en" ? "Run command" : "명령 실행", capture);
    await gateway.showView(commandApproval());
    const commandCard = page.locator('[data-test-class="composer-authority-decision"]');
    await commandCard.getByText(maskedCommand, { exact: true }).waitFor();
    assert(!(await commandCard.innerHTML()).includes(commandCredential), "command credential is absent from text and titles");
    await capture(commandCard, "command-approval", "명령 승인 카드 · 인증 값만 마스킹");
    await gateway.showView(longPathApproval());
    const pathCard = page.locator('[data-test-class="composer-authority-decision"]');
    const pathTitle = pathCard.locator('[data-slot="composer-decision-subject"] [title]').first();
    await pathTitle.waitFor();
    assert((await pathTitle.getAttribute("title"))?.includes(longEditPath), "title tooltip retains the full absolute path");
    await pathCard.locator(`[aria-label="${longEditPath}"]`).waitFor();
    assert.equal(await pathCard.getByRole("button", { name: copy.conversation.messageActions.showMore, exact: true }).count(), 0, "one abbreviated absolute path never offers false expansion");
    await capture(pathCard, "edit-files-long-path", "파일 수정 승인 카드 · 64자 초과 절대 경로, 더보기 없음, 제목 툴팁 유지");
    await quietWorkResult(page, gateway);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, theme, width, result: "PASS" }));
    await page.close(); cells++;
  }
  if (output) writeFileSync(join(output, "captions.txt"), captions.join("\n") + "\n");
  console.log(JSON.stringify({ result: "PASS", cells, captures: captions.filter(line => !line.startsWith("##")).length,
    modelCalls: 0, headless: true, browser: "Chromium", args: smokeBrowserArgs(), scale: 2, quality: 80, longestSideMax: 1600 }));
} finally { await browser.close(); }

type Gateway = Awaited<ReturnType<typeof installInitiatedGateway>>;
type Capture = (region: Locator, name: string, caption: string) => Promise<void>;
async function resultBubble(page: Page, gateway: Gateway, viewWork: string, en: boolean, capture: Capture) {
  const list = page.locator('[data-test-class="message-artifact-list"]');
  const link = list.getByRole("button", { name: workTitle, exact: true });
  await link.getByText(viewWork, { exact: true }).waitFor();
  assert.equal(await list.getByRole("button").count(), 2, "one document and one work link share the ArtifactList");
  await list.getByText("아침 소식.md", { exact: true }).waitFor();
  await checkFooter(page);
  await capture(page.locator('[data-test-class~="message"][data-test-class~="assistant"]'), "work-result", "완료한 작업 · 결과 문서와 작업 보기 링크");
  assert.deepEqual(await probeFocusRingFrames(page, () => link.focus()), []);
  for (const keyboard of [false, true]) {
    await opensObserver(page, link, keyboard);
  }
  const documentBox = await list.getByRole("button").first().boundingBox(), linkBox = await link.boundingBox();
  assert(documentBox && linkBox && Math.abs(documentBox.x - linkBox.x) < 1, "document and work link align");
  await gateway.show(workResult(en, false));
  await page.waitForFunction(() => document.querySelector('[data-test-class="message-artifact-list"]')?.children.length === 1);
  assert.equal(await list.getByRole("button").count(), 1, "work link survives without documents");
  await opensObserver(page, link, true);
}
async function failedWorkLines(page: Page, gateway: Gateway, copy: ReturnType<typeof getAppCopy>["conversation"]["initiated"], en: boolean, capture: Capture) {
  for (const chatId of ["general", "butler-client"]) {
    for (const reasonCode of ["hook_blocked", "session_model_unavailable", "invalid_request", "unknown_error"]) {
      for (const retrying of [true, false]) {
        const message = workFailed(!en, retrying, chatId, reasonCode);
        const view = session([message], chatId);
        if (chatId !== "general") { view.kind = "project"; view.project_id = "butler"; }
        if (chatId === "general" && !retrying) await gateway.show(message);
        else await gateway.showView(view);
        const line = page.locator('[data-test-class="initiated-work-failed"]');
        await line.getByText(copy.workFailed(message.initiated!.state, message.initiated!.reason_code), { exact: true }).waitFor();
        assert.equal(await line.count(), 1, "message.updated replaces the retrying line in place");
        const row = page.locator('[data-test-class~="message"][data-test-class~="assistant"]');
        assert(!(await row.innerText()).includes("Stored notification text"));
        assert.equal(await row.locator('[data-test-class="assistant-bubble"]').count(), chatId === "general" ? 1 : 0);
        const list = row.locator('[data-test-class="message-artifact-list"]');
        const link = list.getByRole("button", { name: workTitle, exact: true });
        await link.getByText(copy.viewWork, { exact: true }).waitFor();
        assert.equal(await list.getByRole("button").count(), 1);
        await checkFooter(page);
        assert.equal(await row.locator('[data-test-class~="assistant-footer"] button, [data-test-class~="assistant-footer"] [role="button"]').count(), 0);
        assert.deepEqual(await probeFocusRingFrames(page, () => link.focus()), []);
        await capture(row, `work-failed-${retrying ? "retrying" : "permanent"}-${chatId === "general" ? "chats" : "project"}-${reasonCode}`, `작업 결과 전달 실패 · ${retrying ? "재시도 중" : "영구 실패"} · ${chatId === "general" ? "대화" : "프로젝트 대화"}`);
        await opensObserver(page, link, false);
        await opensObserver(page, link, true);
      }
    }
  }
  await gateway.showView(session([]));
}
async function opensObserver(page: Page, row: Locator, keyboard: boolean) {
  const fetched = page.waitForRequest(request => new URL(request.url()).pathname === "/session-view"
    && new URL(request.url()).searchParams.get("session_id") === workSessionId);
  if (keyboard) { await row.focus(); await row.press("Enter"); } else await row.click();
  await fetched;
  const dialog = page.locator('[data-test-class="steward-observer-dialog"]');
  await dialog.getByRole("heading", { name: workSessionId, exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}
async function attentionLine(page: Page, gateway: Gateway, label: string, toolLabel: string, capture: Capture) {
  await gateway.show(approvalNeeded(false, toolLabel));
  const line = page.locator('[data-test-class="initiated-approval-needed"]');
  await line.getByText(label, { exact: true }).waitFor();
  const row = await line.evaluate(node => {
    const [tag, action] = [...node.firstElementChild!.children].map(child => child.getBoundingClientRect());
    return { tagRight: tag.right, actionLeft: action.left };
  });
  assert(row.actionLeft >= row.tagRight, "tag and exact action share one row");
  const badge = await line.getByText(label, { exact: true }).boundingBox();
  assert(badge && row.actionLeft >= badge.x + badge.width, "tag label never overlaps the exact action");
  const text = await line.innerText();
  assert(text.includes(maskedCommand), "line names the command with its credential masked");
  assert(!(await line.innerHTML()).includes(commandCredential));
  await line.getByText(`${toolLabel} · ${maskedCommand} · 환율·미국 증시 정리`, { exact: true }).waitFor();
  assert(!text.includes("?"), "skipped action is a statement, never the approval question");
  assert(text.includes("환율·미국 증시 정리"), "line names the schedule");
  assert(!text.includes("Stored notification text"), "renderer uses the localized approval facts");
  await checkFooter(page);
  assert.equal(await page.locator('[data-test-class~="assistant-footer"] [role="button"], [data-test-class~="assistant-footer"] button').count(), 0, "attention footer contains only the time");
  assert.deepEqual(await probeFocusRingFrames(page, () => line.focus()), []);
  await capture(page.locator('[data-test-class~="message"][data-test-class~="assistant"]'), "approval-needed", "확인 필요 · 건너뛴 작업 종류, 정확한 명령, 예약 작업");
  const opened = page.waitForRequest(request => request.url().endsWith("/automations/schedule-1/runs"));
  await line.click(); await opened;
  await page.locator('[data-test-class="automation-detail-view"]').waitFor();
  const savedLabel = toolLabel === "Run command" ? "명령 실행" : "Run command";
  await gateway.showView(session([approvalNeeded(true, savedLabel)]));
  await line.getByText(`${savedLabel} · ${maskedCommand} · 환율·미국 증시 정리`, { exact: true }).waitFor();
  await gateway.showView(session([approvalNeeded(true)]));
  await line.getByText(`${toolLabel} · ${maskedCommand} · 환율·미국 증시 정리`, { exact: true }).waitFor();
  await line.waitFor();
  await opensObserver(page, line, true);
}
async function checkFooter(page: Page) {
  assert.equal(await page.locator('[data-test-class="assistant-terminal-status-row"]').count(), 0);
  assert.equal(await page.locator('[data-test-class~="assistant-footer"] time').count(), 1);
  assert.equal(await page.locator('[data-test-class~="message"][data-test-class~="user"]').count(), 0);
}
async function quietWorkResult(page: Page, gateway: Gateway) {
  await gateway.showView(session([]));
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  const showSidebar = async () => {
    if (await sidebar.getAttribute("data-collapsed") === "true") await page.getByRole("button", { name: /^(사이드바 보기|Show sidebar)$/u }).click();
  };
  await showSidebar();
  await page.getByRole("button", { name: "다른 대화", exact: true }).click();
  const count = () => page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications.length);
  const before = await count();
  const result = workResult(); result.created_at = "2026-10-26T21:00:00Z";
  await gateway.arrive(result);
  await page.waitForFunction(n => (window as unknown as { __notifications: unknown[] }).__notifications.length === n + 1, before);
  await showSidebar();
  await page.locator('[data-slot="unread-dot"]').waitFor();
  const row = sidebar.locator('[data-test-class="tree-row"]').filter({ has: page.locator('[data-slot="unread-dot"]') });
  const read = page.waitForResponse(response => response.url().endsWith("/sessions/general/read"));
  await row.click(); await read;
  await showSidebar();
  await page.getByRole("button", { name: "다른 대화", exact: true }).click();
  const quiet = { ...result, id: "quiet-work-result", quiet: true, initiated: { ...result.initiated!, quiet: false } };
  const refreshed = page.waitForResponse(response => response.url().endsWith("/navigation"));
  await gateway.arrive(quiet); await refreshed;
  await showSidebar();
  await page.locator('[data-slot="unread-dot"]').waitFor();
  assert.equal(await count(), before + 1, "quiet work result marks unread without invoking the OS notification bridge");
  const ordinary = { ...quiet, id: "quiet-assistant-message", initiated: undefined };
  const ordinaryRefreshed = page.waitForResponse(response => response.url().endsWith("/navigation"));
  await gateway.arrive(ordinary); await ordinaryRefreshed;
  assert.equal(await count(), before + 1, "top-level quiet suppresses notifications without an initiated origin");
}
async function captureRegion(page: Page, region: Locator, name: string, caption: string, language: string, theme: string, width: number) {
  if (!output || !name.startsWith("work-failed-") || width !== 1440) return;
  await page.mouse.move(-1, -1);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); return document.fonts.ready; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await region.locator(':is(button, [role="button"]):is(:hover, :focus-within)').count(), 0, "review captures show resting controls");
  const box = await region.boundingBox(); assert(box);
  const x = Math.max(0, box.x - 12), y = Math.max(0, box.y - 12);
  const filename = `${name}-${language}-${theme}-${width}.jpg`;
  await page.screenshot({ path: join(output!, filename), type: "jpeg", quality: 80, animations: "disabled",
    clip: { x, y, width: Math.min(1600, width - x, box.width + 24), height: Math.min(1600, 960 - y, box.height + 24) } });
  execFileSync("sips", ["--resampleHeightWidthMax", "1600", join(output, filename)], { stdio: "ignore" });
  const section = `## ${language} · ${theme} · ${width}`;
  if (!captions.includes(section)) captions.push(section);
  captions.push(`${filename}\t${caption}`);
}
