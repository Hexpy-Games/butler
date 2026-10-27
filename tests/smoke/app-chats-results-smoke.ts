// test-category: race
// Real renderer with stub gateway transport. No model or native app is started.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { installInitiatedGateway, session } from "../support/initiated-fixtures";
import { approvalNeeded, canonApproval, canonTitle, dueOn, exactCommand, planTitle, projectTitle, workResult, workSessionId, workTitle } from "../support/work-result-fixtures";
import { probeFocusRingFrames } from "../support/focus-ring-clipping";
import { launchSmokeBrowser, smokeBrowserArgs } from "../support/smoke-browser";

const output = process.env.BUTLER_RESULTS_CAPTURES;
const captions: string[] = [];
if (output) mkdirSync(output, { recursive: true });
const browser = await launchSmokeBrowser();
let cells = 0;
try {
  for (const [language, theme, width] of [
    ["ko", "light", 1440], ["ko", "dark", 1440], ["ko", "light", 390], ["ko", "dark", 390], ["en", "light", 1440],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const gateway = await installInitiatedGateway(page, language, theme, session([workResult(language === "en")]));
    const copy = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    const capture = (region: Locator, name: string, caption: string) => captureRegion(page, region, name, caption, language, theme, width);
    await page.goto("http://127.0.0.1:43827/");
    await resultBubble(page, gateway, copy.conversation.initiated.viewWork, language === "en", capture);
    await attentionLine(page, gateway, copy.conversation.initiated.needsApproval, copy.guided.tools.run_command, capture);
    for (const kind of ["epic", "plan"] as const) {
      await gateway.showView(canonApproval(kind));
      const card = page.locator('[data-test-class="composer-authority-decision"]');
      const labels = copy.interfaceTemplates.approvalRequest;
      await card.getByText(labels.createCanon[kind], { exact: true }).waitFor();
      for (const text of [canonTitle[kind], projectTitle, kind === "epic" ? labels.canonPlan(planTitle) : labels.canonDue(dueOn)]) {
        await card.getByText(text, { exact: true }).waitFor();
      }
      const buttons = card.getByRole("button");
      const names = await buttons.allTextContents();
      assert(names.includes(copy.interfaceDetails.deny));
      assert(names.includes(copy.interfaceDetails.allowOnce));
      for (const button of await buttons.all()) assert.deepEqual(await probeFocusRingFrames(page, () => button.focus()), []);
      if (language === "ko") await capture(card, `canon-${kind}`, kind === "epic" ? "과제 승인 카드 · 제목, 프로젝트, 계획" : "계획 승인 카드 · 제목, 프로젝트, 마감일");
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ language, theme, width, result: "PASS" }));
    await page.close(); cells++;
  }
  if (output) writeFileSync(join(output, "captions.txt"), captions.join("\n") + "\n");
  console.log(JSON.stringify({ result: "PASS", cells, captures: captions.filter(line => !line.startsWith("##")).length,
    modelCalls: 0, headless: true, browser: "Chromium", args: smokeBrowserArgs(), scale: 1, quality: 80, longestSideMax: 1600 }));
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
  await gateway.show(approvalNeeded());
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
  assert(text.includes(exactCommand), "line names the exact command");
  await line.getByText(`${toolLabel} · ${exactCommand} · 환율·미국 증시 정리`, { exact: true }).waitFor();
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
  await gateway.showView(session([approvalNeeded(true)]));
  await line.waitFor();
  await opensObserver(page, line, true);
}
async function checkFooter(page: Page) {
  assert.equal(await page.locator('[data-test-class="assistant-terminal-status-row"]').count(), 0);
  assert.equal(await page.locator('[data-test-class~="assistant-footer"] time').count(), 1);
  assert.equal(await page.locator('[data-test-class~="message"][data-test-class~="user"]').count(), 0);
}
async function captureRegion(page: Page, region: Locator, name: string, caption: string, language: string, theme: string, width: number) {
  if (!output) return;
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); return document.fonts.ready; });
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  const box = await region.boundingBox(); assert(box);
  const x = Math.max(0, box.x - 12), y = Math.max(0, box.y - 12);
  const filename = `${name}-${language}-${theme}-${width}.jpg`;
  await page.screenshot({ path: join(output!, filename), type: "jpeg", quality: 80, animations: "disabled",
    clip: { x, y, width: Math.min(1600, width - x, box.width + 24), height: Math.min(1600, 960 - y, box.height + 24) } });
  const section = `## ${language} · ${theme} · ${width}`;
  if (!captions.includes(section)) captions.push(section);
  captions.push(`${filename}\t${caption}`);
}
