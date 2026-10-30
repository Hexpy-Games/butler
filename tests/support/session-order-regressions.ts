import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
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
