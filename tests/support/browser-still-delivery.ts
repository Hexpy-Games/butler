/** Completeness is asserted outside the timed acknowledgement path. */
import { strict as assert } from "node:assert";
import { waitBrowser } from "./browser-agent-app";
type Act = { still_pending?: { id: string; session: string }; steps: Array<{ status: string; still_file?: unknown }> };
type Delivery = { complete: boolean; steps: Array<{ step: number; state: string; still_file?: unknown; reason?: string }> };
export async function expectBrowserStills(gateway: { api<T>(path: string): Promise<T> }, act: Act) {
  const pending = act.still_pending; assert.ok(pending, "act has a durable still receipt");
  let delivery: Delivery | undefined;
  await waitBrowser(async () => {
    delivery = await gateway.api<Delivery>(`/browser-stills/${encodeURIComponent(pending.id)}?session_id=${encodeURIComponent(pending.session)}&wait=1`);
    return delivery.complete;
  }, "every act still settled");
  assert.equal(delivery!.steps.length, act.steps.length, "every requested step has a receipt");
  for (const [index, step] of act.steps.entries()) {
    const receipt = delivery!.steps[index]!;
    assert.equal(receipt.step, index, "still order follows act step order");
    if (step.status === "completed") {
      assert.equal(receipt.state, "attached", `step ${index}: ${receipt.reason}`);
      assert.ok(receipt.still_file, `step ${index}: image arrived`);
    } else { assert.equal(receipt.state, "failed"); assert.ok(receipt.reason); }
  }
  return delivery!;
}
