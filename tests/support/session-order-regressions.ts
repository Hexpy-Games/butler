import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { CanonQueueView } from "../../packages/butler-app/client/shared/canon-queue-contracts.ts";
import { apiOrderEdit, orderChat, orderShape, postOrder, readOrder, requestOrder, seedOrderPlan, stopOrderTurn, waitOrder } from "./session-order-fixtures.ts";

/** Includes accessible names, titles and the hidden text referenced by descriptions. */
export async function assertNoCanonInstructions(page: Page) {
  assert(!/canon:/u.test(await page.locator("body").innerHTML()), "internal step instructions never render in text or attributes");
}
export async function assertStepActivity(page: Page) {
  const replies = page.getByText("확인하고 있습니다.", { exact: true });
  await replies.first().waitFor();
  for (const reply of await replies.all()) {
    const result = await reply.evaluate(node => {
      const body = node.closest('[data-test-class="message-body"]')!;
      const lines = body.querySelectorAll('[data-test-class="canon-step-activity"]');
      return { count: lines.length, before: !!((lines[0]?.compareDocumentPosition(node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });
    assert.deepEqual(result, { count: 1, before: true }, "each step reply has exactly one activity line before it");
  }
  assert.equal(await page.locator('[data-test-class="canon-step-activity"]').count(), await replies.count());
  await assertNoCanonInstructions(page);
}

/** A completed prefix must not offer the gap before the running step. */
export async function completedPrefixDrop(host: NativeAppServerHandle, open: (id: string) => Promise<Page>,
  info: (page: Page) => Promise<void>, move: (page: Page, id: string, item: string, keys: string[]) => Promise<unknown>,
  shot: (page: Page, name: string) => Promise<void>) {
  const id = await orderChat(host, "완료 후 진행 순서");
  const { plan, epics } = await seedOrderPlan(host, 4);
  await requestOrder(host, id, { op: "plan_run", plan_id: plan.id });
  await waitOrder(host, id, view => view.counts.running === 1);
  await stopOrderTurn(host, id);
  await waitOrder(host, id, view => view.counts.failed === 1);
  await host.api(`/sessions/${id}/canon/queue/holds/${epics[0]!.id}`, postOrder({ decision: "continue" }));
  await waitOrder(host, id, view => view.counts.running === 1 && view.counts.waiting === 2);
  const page = await open(id);
  try {
    await info(page);
    await shot(page, "done-prefix");
    const rows = page.locator('[data-session-section="order"] [data-step-items]');
    await page.waitForFunction(() => document.querySelectorAll('[data-session-section="order"] [data-step-items]').length === 3);
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-step-items"))), epics.slice(1).map(epic => epic.id));
    await shot(page, "done-prefix");
    // Repeated Up reaches the earliest offered gap, even if the model's target count changes.
    await move(page, id, epics[3]!.id, Array<string>(8).fill("ArrowUp"));
    const expected = [[[epics[0]!.id], [epics[1]!.id], [epics[3]!.id], [epics[2]!.id]]];
    assert.deepEqual(orderShape(await readOrder(host, id)), expected, "stored order is independent of the edit response");
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-step-items"))), expected[0]!.slice(1).map(step => step.join(" ")));
    await shot(page, "done-prefix-drop");
    // With exactly [done, running, waiting], Up has no changing legal destination.
    await apiOrderEdit(host, id, { op: "delete", epic_id: epics[2]!.id });
    await page.waitForFunction(() => document.querySelectorAll('[data-session-section="order"] [data-step-items]').length === 2);
    let requests = 0;
    page.on("request", request => { if (request.url().endsWith("/canon/queue/edits") && request.method() === "POST") requests++; });
    await page.locator(`[data-step-grip="item:${epics[3]!.id}"]`).focus();
    await page.keyboard.press("Space"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Space");
    assert.equal(requests, 0, "the three-step chain offers no drop before its running step");
    assert.deepEqual(orderShape(await readOrder(host, id)), [[[epics[0]!.id], [epics[1]!.id], [epics[3]!.id]]]);
    await assertNoCanonInstructions(page);
  } finally {
    await page.unrouteAll({ behavior: "wait" }); await page.close();
    await stopOrderTurn(host, id);
    await waitOrder(host, id, view => view.counts.failed === 1);
  }
}

/** Found driving the real app: every surface follows the step actually being worked on. */
export async function liveStepSurfaces(host: NativeAppServerHandle, open: (id: string) => Promise<Page>, info: (page: Page) => Promise<void>,
  shot: (page: Page, name: string) => Promise<void>) {
  const id = await orderChat(host, "실제 앱 표시");
  const { plan, epics } = await seedOrderPlan(host, 3);
  const page = await open(id);
  try {
    const show = page.getByRole("button", { name: /^(사이드바 보기|Show sidebar)$/u });
    if (await show.isVisible()) await show.click();
    const reading = new Map<string, number>();
    let mostReading = 0;
    const sidebarRead = (url: string) => { const { pathname } = new URL(url); return pathname.endsWith("/canon/sidebar") ? pathname : null; };
    page.on("request", request => {
      const path = sidebarRead(request.url());
      if (path) { reading.set(path, (reading.get(path) ?? 0) + 1); mostReading = Math.max(mostReading, reading.get(path)!); }
    });
    const settled = (request: { url(): string }) => { const path = sidebarRead(request.url()); if (path) reading.set(path, reading.get(path)! - 1); };
    page.on("requestfinished", settled); page.on("requestfailed", settled);
    await requestOrder(host, id, { op: "plan_run", plan_id: plan.id });
    await waitOrder(host, id, view => view.counts.running === 1);
    // The model stream stays open here, so only the queue change itself can bring these rows.
    const row = (epic: { id: string }) => page.locator(`[data-canon-epic="${epic.id}"]`);
    await row(epics[1]!).waitFor();
    await row(epics[2]!).waitFor();
    assert.equal(await row(epics[1]!).locator('[role="status"]').count() + await row(epics[2]!).locator('[role="status"]').count(), 0, "waiting 과제 do not wear the shared chat's activity");
    await apiOrderEdit(host, id, { op: "join_stack", epic_id: epics[2]!.id, target_epic_id: epics[1]!.id });
    assert.equal(mostReading, 1, "an event burst runs one sidebar read per project at a time");
    await page.route(`**/sessions/${id}/canon/queue`, async route => {
      const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin: new URL(route.request().url()).origin } });
      const body = await response.json() as { data: CanonQueueView };
      const [head, stack] = body.data.chains[0]!.steps;
      head!.items[0]!.state = "done";
      stack!.items[0]!.state = "done";
      stack!.items[1]!.state = "running";
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await info(page);
    const section = page.locator('[data-session-section="order"]');
    await section.locator(`[data-step-item="${epics[2]!.id}"]`).waitFor();
    assert.equal(await section.locator('[data-activity="running"]').count() > 0, true, "a collapsed 묶음 shows its running item, not its finished one");
    await page.locator('[data-session-section="task"]').getByText(epics[2]!.title, { exact: true }).first().waitFor();
    await shot(page, "live-step-surfaces");
  } finally {
    await page.unrouteAll({ behavior: "wait" }); await page.close();
    await stopOrderTurn(host, id);
    await waitOrder(host, id, view => view.counts.failed === 1);
  }
}
