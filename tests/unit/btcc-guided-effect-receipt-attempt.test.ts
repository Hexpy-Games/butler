import { expect, test } from "bun:test";
import type {
  GuidedEffectJournalRecord,
} from "../../packages/butler-agent/src/agent/btcc/effects/contracts.ts";
import { replayAppliedEffect } from
  "../../packages/butler-agent/src/agent/btcc/effects/effect-receipt.ts";
import { GuidedEffectTestFixture } from "./support/guided-effect-test-fixture.ts";

test("applied receipts carry the durable dispatch attempt across execution and replay", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const payload = { content: "alpha", format: "markdown" };
    const first = await fixture.execute({ payload });
    expect(first.ok).toBeTrue();
    if (!first.ok) throw new Error("Expected effect to be applied");
    const row = await fixture.journal.find(first.receipt.effectId);
    if (row === null) throw new Error("Expected applied journal row");
    expect(first.receipt.effectId).toBe(row.effectId);
    expect(first.receipt.dispatchAttempt).toBe(row.dispatchAttempts);
    expect(first.receipt.dispatchAttempt).toBeGreaterThan(0);

    const second = await fixture.execute({ payload });
    expect(second).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
    });
    if (!second.ok) throw new Error("Expected effect to replay");
    expect(fixture.dispatchCalls).toBe(1);
    expect(second.receipt.effectId).toBe(first.receipt.effectId);
    expect(second.receipt.dispatchAttempt).toBe(first.receipt.dispatchAttempt);

    if (!row.receipt) throw new Error("Expected applied journal row receipt");
    const { dispatchAttempt: _legacyAttempt, ...legacyReceipt } = row.receipt;
    const legacyRecord: GuidedEffectJournalRecord = {
      ...row,
      receipt: legacyReceipt,
    };
    const replayed = replayAppliedEffect(legacyRecord);
    expect(replayed).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
    });
    if (!replayed.ok) throw new Error("Expected legacy receipt to replay");
    expect(replayed.receipt.effectId).toBe(row.effectId);
    expect(replayed.receipt.dispatchAttempt).toBe(row.dispatchAttempts);
  } finally {
    fixture.close();
  }
});
