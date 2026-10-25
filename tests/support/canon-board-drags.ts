import { selectBoardPlan } from "./canon-board-selector.ts";
import { strict as assert } from "node:assert";
import type { Locator, Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonOverview } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import { waitToast } from "./canon-board-scenarios.ts";

// dnd-kit AbstractPointerSensor.detach removes its capture click guard after 50 ms.
// No DOM signal exposes that timer; keep this one named guard after pointer drops.
const DND_KIT_CLICK_GUARD_MS = 50;
const item = (page: Page, title: string) => page.locator('[data-test-class="canon-board"] [data-kanban-item]').filter({ hasText: title }).first();
async function liftTo(page: Page, source: Locator, target: Locator, position = "before"): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await source.scrollIntoViewIfNeeded();
  // Make room above the overlay composer when a phone scrolls to a low lane.
  await source.evaluate(element => {
    const scroller = element.closest<HTMLElement>('[data-scroll-fade="y"]');
    if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - 240;
  });
  const start = await source.boundingBox(), end = await target.boundingBox();
  assert(start && end);
  await page.mouse.move(start.x + 20, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20 + 10, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width - 20, end.y + (position === "before" ? 4 : end.height - 12), { steps: 15 });
  await page.locator('[data-drop-target="true"]').waitFor();
  await page.locator('[data-drop]').first().waitFor();
}
export async function captureCanonDrag(page: Page, path: string): Promise<void> {
  const source = item(page, "ChatGPT 공식 로그인"), target = item(page, "문서");
  try {
    await liftTo(page, source, target);
    await page.screenshot({ path, animations: "disabled" });
  } finally {
    await page.keyboard.press("Escape");
    await page.mouse.up();
  }
}
export async function verifyCanonDrags(page: Page, server: NativeAppServerHandle, projectId: string, planId: string): Promise<void> {
  const read = () => server.api<CanonOverview>(`/projects/${projectId}/canon`);
  let canon = await read();
  const initial = canon.plans.find(plan => plan.id === planId)!.works;
  const moving = initial.find(card => card.title === "ChatGPT 공식 로그인")!;
  const before = initial.find(card => card.title === "문서")!;
  await liftTo(page, item(page, moving.title), item(page, before.title));
  await page.mouse.up(); await waitToast(page, "과제 순서를 바꿨습니다");
  canon = await read();
  const order = canon.plans.find(plan => plan.id === planId)!.works.map(card => card.id);
  const expected = initial.filter(card => card.id !== moving.id).map(card => card.id);
  expected.splice(expected.indexOf(before.id), 0, moving.id);
  assert.deepEqual(order, expected, "Reorder persists the FULL canon order");
  const target = page.locator(`[data-plan-id="${planId}"] [data-canon-lane="in_progress"] [data-slot="kanban-lane"]`);
  await liftTo(page, item(page, moving.title), target, "end");
  await page.mouse.up(); await waitToast(page, `‘${moving.title}’ 진행 중`);
  canon = await read();
  assert.equal(canon.plans.find(plan => plan.id === planId)!.works.find(card => card.id === moving.id)!.canon_status, "in_progress");
  const backlog = canon.backlog[0]!;
  await page.locator('[data-slot="kanban-drag-scope"][data-dragging]').waitFor({ state: "hidden" });
  await page.waitForTimeout(DND_KIT_CLICK_GUARD_MS);
  await moveFromBacklog(page, backlog.title, planId);
  canon = await read();
  assert.equal(canon.plans.find(plan => plan.id === planId)!.works.find(card => card.id === backlog.id)!.plan_id, planId);
  const expectedPlanned = canon.plans.find(plan => plan.id === planId)!.works.filter(card => card.canon_status === "planned").map(card => card.id);
  const position = expectedPlanned.indexOf(backlog.id);
  assert(position > 0, "Keyboard move has a preceding planned card");
  expectedPlanned.splice(position - 1, 0, expectedPlanned.splice(position, 1)[0]!);
  const keyboard = item(page, backlog.title).getByRole("button");
  await keyboard.focus(); await keyboard.press("Space");
  await page.locator('[aria-live="polite"]').filter({ hasText: `‘${backlog.title}’ 카드를 들었습니다. 프리뷰 14 · 예정` }).waitFor();
  await keyboard.press("ArrowUp");
  // The pointer reorder above may still show the same toast; wait for this drop's own order write.
  const ordered = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith(`/canon/plans/${encodeURIComponent(planId)}/order`));
  await keyboard.press("Space");
  assert((await ordered).ok(), "Keyboard reorder request succeeded");
  await waitToast(page, "과제 순서를 바꿨습니다");
  await page.locator('[aria-live="polite"]').filter({ hasText: `‘${backlog.title}’ 카드를 놓았습니다.` }).waitFor();
  canon = await read();
  const plannedOrder = canon.plans.find(plan => plan.id === planId)!.works.filter(card => card.canon_status === "planned");
  assert.deepEqual(plannedOrder.map(card => card.id), expectedPlanned, "Keyboard reorder persisted the complete lane order");
  await verifyCancelledMove(page, server, projectId, planId);
  console.log("SKIP running refusal: requires a running work; no model started");
}

async function verifyCancelledMove(page: Page, server: NativeAppServerHandle, projectId: string, planId: string): Promise<void> {
  const canon = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  const card = canon.backlog[0]!;
  await server.api(`/canon/epics/${card.id}`, { method: "PATCH", body: JSON.stringify({
    expected_revision: card.revision, status: "cancelled",
  }) });
  await moveFromBacklog(page, card.title, planId);
  const saved = await server.api<CanonOverview>(`/projects/${projectId}/canon`);
  assert.equal(saved.plans.find(plan => plan.id === planId)!.works.find(epic => epic.id === card.id)!.canon_status,
    "cancelled", "Moving to another group's completed lane preserves cancellation");
}

async function moveFromBacklog(page: Page, title: string, planId: string) {
  await selectBoardPlan(page, "백로그");
  await item(page, title).getByRole("button").click();
  const detail = page.locator('[data-slot="management-page-aside"][data-state="open"] [data-test-class="canon-epic-detail"]');
  await detail.getByRole("combobox", { name: "계획", exact: true }).selectOption(planId);
  await waitToast(page, "프리뷰 14에 넣었습니다");
  await selectBoardPlan(page, "프리뷰 14");
  await item(page, title).waitFor();
}
