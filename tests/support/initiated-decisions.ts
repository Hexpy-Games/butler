import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { initiatedMessage, type installInitiatedGateway } from "./initiated-fixtures";
import { probeFocusRingFrames } from "./focus-ring-clipping";

type Gateway = Awaited<ReturnType<typeof installInitiatedGateway>>;
export type CaptureDecision = (region: Locator, name: string, caption: string) => Promise<void>;

export async function proposalDecisions(page: Page, gateway: Gateway, language: "ko" | "en", capture: CaptureDecision) {
  const en = language === "en", labels = getAppCopy(en ? "en-US" : "ko-KR").conversation.initiated;
  const panels = page.locator('[data-test-class="initiated-proposal"]');
  const acceptedAction = en ? "Schedule · Daily at 7:50 AM · 환율·미국 증시 정리 · From Oct 28 · In Chats"
    : "예약 작업 · 매일 오전 7:50 · 환율·미국 증시 정리 · 10월 28일부터 · 대화로 받아요";
  const pendingAction = en ? "Schedule · Daily at 7:50 AM · 환율·미국 증시 정리 · From Oct 27 · In Chats"
    : "예약 작업 · 매일 오전 7:50 · 환율·미국 증시 정리 · 10월 27일부터 · 대화로 받아요";
  const acceptedCaption = `${en ? "Created" : "만들었어요"} · ${acceptedAction}`;
  const declinedCaption = `${en ? "Skipped" : "안 만들었어요"} · ${pendingAction}`;
  const decision = page.waitForRequest(request => request.url().endsWith("/memory/pattern-proposals/bundle-1") && request.method() === "POST");
  await panels.first().getByRole("button", { name: labels.soundsGood, exact: true }).click();
  assert.deepEqual((await decision).postDataJSON(), { pattern_id: "pattern-1", decision: "accepted", expected_revision: 7 });
  const accepted = initiatedMessage("proposal", en);
  assert(accepted.initiated?.panel?.kind === "pattern_proposal");
  accepted.initiated.panel.candidates[0] = { ...accepted.initiated.panel.candidates[0], state: "accepted", automation_id: "schedule-1" };
  await gateway.show(accepted);
  const resolution = page.locator('[data-test-class="initiated-resolution"]');
  await checkResolution(page, resolution, acceptedCaption, true);
  assert.equal(await panels.count(), 1, "only the other pending candidate keeps its panel");
  assert.equal(await panels.locator("button").count(), 2);
  await capture(resolution.or(panels), "proposal-accepted", "예약 작업을 만든 뒤 · 누르면 예약 작업 열기");
  const opened = page.waitForRequest(request => request.url().endsWith("/automations/schedule-1/runs"));
  await resolution.getByRole("button", { name: acceptedCaption, exact: true }).click();
  await opened;
  await page.locator('[data-test-class="automation-detail-view"]').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll("input")].some(input => input.value === "환율·미국 증시 정리"));
  await gateway.show(initiatedMessage("proposal", en));
  await page.reload();
  await panels.nth(1).waitFor();
  const decline = page.waitForRequest(request => request.url().endsWith("/memory/pattern-proposals/bundle-1") && request.method() === "POST");
  await panels.first().getByRole("button", { name: labels.noThanks, exact: true }).click();
  assert.deepEqual((await decline).postDataJSON(), { pattern_id: "pattern-1", decision: "declined", expected_revision: 7 });
  const declined = initiatedMessage("proposal", en);
  assert(declined.initiated?.panel?.kind === "pattern_proposal"); declined.initiated.panel.candidates[0].state = "declined";
  await gateway.show(declined);
  await checkResolution(page, resolution, declinedCaption, false);
  assert.equal(await panels.count(), 1);
  assert.equal(await panels.locator("button").count(), 2);
  if (!en) await capture(resolution.or(panels), "proposal-declined", "예약 작업을 만들지 않은 뒤 · 안내 문구");
}

export async function pauseDecisions(page: Page, gateway: Gateway, capture: CaptureDecision) {
  const labels = getAppCopy("ko-KR").conversation.initiated;
  const panel = page.locator('[data-test-class="initiated-pause"]');
  const resolution = page.locator('[data-test-class="initiated-resolution"]');
  const action = "예약 작업 · 매일 오전 7:50 · 아침 소식 · 대화로 받아요";
  for (const [accept, state, caption] of [[true, "continued", `계속 받아요 · ${action}`], [false, "stopped", `멈춰 뒀어요 · ${action}`]] as const) {
    if (!accept) await gateway.show(initiatedMessage("pause"));
    await panel.waitFor();
    const request = page.waitForRequest(request => request.url().endsWith("/automations/schedule-1/report-pause"));
    await panel.getByRole("button", { name: accept ? labels.soundsGood : labels.noThanks, exact: true }).click();
    assert.deepEqual((await request).postDataJSON(), { decision: accept ? "continue" : "stop" });
    const resolved = initiatedMessage("pause");
    assert(resolved.initiated?.panel?.kind === "schedule_pause"); resolved.initiated.panel.state = state;
    await gateway.show(resolved);
    await checkResolution(page, resolution, caption, true);
    assert.equal(await panel.count(), 0, "settled pause has no panel or decision buttons");
    if (accept) await capture(resolution, "pause-continued", "보고를 계속 받기로 한 뒤 · 예약 작업 열기");
  }
}

async function checkResolution(page: Page, row: Locator, text: string, interactive: boolean) {
  await row.getByText(text, { exact: true }).waitFor();
  assert.equal(await row.innerText(), text, "one caption contains the complete exact action");
  assert.equal(await row.locator('[data-slot="card"], [data-slot="composer-decision-actions"], button').count(), 0);
  assert.equal(await row.getByRole("button").count(), interactive ? 1 : 0);
  const geometry = await row.evaluate(node => ({ left: node.getBoundingClientRect().left,
    bubbleLeft: node.closest('[data-test-class="message-body"]')!.querySelector('[data-test-class="assistant-bubble"]')!.getBoundingClientRect().left }));
  assert(Math.abs(geometry.left - geometry.bubbleLeft) < 1, "caption aligns to Butler's bubble");
  if (interactive) assert.deepEqual(await probeFocusRingFrames(page, () => row.getByRole("button").focus()), []);
}
