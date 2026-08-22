import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { GuidedEffectFaultHook, GuidedEffectFaultPoint } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { GuidedEffectTestFixture } from "./support/guided-effect-test-fixture.ts";

const FAULT_CASES: Array<{
  point: GuidedEffectFaultPoint;
  statusAfterCrash: string | null;
  reconciliations: number;
  replayed: boolean;
}> = [
  {
    point: "before_intent",
    statusAfterCrash: null,
    reconciliations: 1,
    replayed: false,
  },
  {
    point: "after_intent",
    statusAfterCrash: "prepared",
    reconciliations: 1,
    replayed: false,
  },
  {
    point: "after_dispatch_marker",
    statusAfterCrash: "dispatching",
    reconciliations: 2,
    replayed: false,
  },
  {
    point: "after_dispatch",
    statusAfterCrash: "dispatching",
    reconciliations: 2,
    replayed: false,
  },
  {
    point: "after_receipt",
    statusAfterCrash: "applied",
    reconciliations: 1,
    replayed: true,
  },
];

for (const faultCase of FAULT_CASES) {
  test(`effect fault cell ${faultCase.point} resumes without duplicate dispatch`, async () => {
    const fixture = new GuidedEffectTestFixture();
    let armed = true;
    try {
      await expect(fixture.execute({
        faultHook(point) {
          if (armed && point === faultCase.point) {
            armed = false;
            throw new Error(`crash:${point}`);
          }
        },
      })).rejects.toThrow(`crash:${faultCase.point}`);
      expect(fixture.status()).toBe(faultCase.statusAfterCrash);

      const resumed = await fixture.execute();
      expect(resumed).toMatchObject({
        ok: true,
        status: "applied",
        replayed: faultCase.replayed,
      });
      expect(fixture.status()).toBe("applied");
      expect(fixture.dispatchCalls).toBe(1);
      expect(fixture.reconcileCalls).toBe(faultCase.reconciliations);
    } finally {
      fixture.close();
    }
  });
}

test("uncertain reconciliation returns recoverable data and never dispatches blindly", async () => {
  const fixture = new GuidedEffectTestFixture();
  let armed = true;
  let crashedIdentity: Parameters<GuidedEffectFaultHook>[1] | undefined;
  try {
    await expect(fixture.execute({
      faultHook(point, identity) {
        if (armed && point === "after_dispatch_marker") {
          armed = false;
          crashedIdentity = identity;
          throw new Error("crash after marker");
        }
      },
    })).rejects.toThrow("crash after marker");
    expect(fixture.status()).toBe("dispatching");
    expect(fixture.reconcileCalls).toBe(1);
    fixture.reconcileMode = "uncertain";

    const first = await fixture.execute();
    expect(first).toEqual({
      ok: false,
      status: "uncertain",
      error: {
        code: "effect_reconciliation_required",
        message: "target_busy: Target observation is inconclusive.",
        recoverable: true,
        sourceCode: "target_busy",
      },
      evidence: {
        effectId: crashedIdentity!.effectId,
        identitySha256: crashedIdentity!.identitySha256,
        dispatchAttempt: 1,
        errorCode: "effect_reconciliation_required",
      },
    });
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(0);
    expect(fixture.reconcileCalls).toBe(2);

    const blockerId = `${crashedIdentity!.effectId}-blocker`;
    const blockerInput = JSON.stringify({
      content: "alpha",
      format: "markdown",
    });
    fixture.db.query(`
      INSERT INTO btcc_guided_work_effect_blockers (
        blocker_id, source_turn_id, source_occurrence_id, session_id,
        work_id, capability, target, input_json, input_sha256,
        idempotency_key, detail, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)
    `).run(
      blockerId,
      "turn-1",
      `${crashedIdentity!.effectId}-occurrence`,
      "session-1",
      crashedIdentity!.workId,
      crashedIdentity!.capability,
      "/private/report.md",
      blockerInput,
      createHash("sha256").update(blockerInput).digest("hex"),
      crashedIdentity!.idempotencyKey,
      "Crashed dispatch left a prior occurrence unresolved.",
      "2026-07-31T00:00:02.000Z",
    );
    const blockerStatus = () =>
      fixture.db.query<{ status: string }, [string]>(`
        SELECT status FROM btcc_guided_work_effect_blockers
        WHERE blocker_id = ?
      `).get(blockerId)?.status ?? null;

    const second = await fixture.execute();
    expect(second).toEqual(first);
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(0);
    expect(fixture.reconcileCalls).toBe(2);
    expect(blockerStatus()).toBe("unresolved");

    const abortedController = new AbortController();
    abortedController.abort();
    const abortedReplay = await fixture.execute({
      signal: abortedController.signal,
    });
    expect(abortedReplay).toEqual(first);
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(0);
    expect(fixture.reconcileCalls).toBe(2);
    expect(blockerStatus()).toBe("unresolved");

    fixture.reconcileMode = "not_applied";
    const recovered = await fixture.execute();
    expect(recovered).toEqual(first);
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(0);
    expect(fixture.reconcileCalls).toBe(2);
    expect(blockerStatus()).toBe("unresolved");
  } finally {
    fixture.close();
  }
});

test("guided effect CAS loss after dispatch reports factual stored uncertainty", async () => {
  const fixture = new GuidedEffectTestFixture();
  let racingIdentity: Parameters<GuidedEffectFaultHook>[1] | undefined;
  try {
    const first = await fixture.execute({
      faultHook(point, identity) {
        if (point !== "after_dispatch") return;
        racingIdentity = identity;
        const current = fixture.journal.find(identity.effectId);
        if (!current) throw new Error("racing journal row disappeared");
        const raced = fixture.journal.recordUncertain(
          current.effectId,
          current.journalRevision,
          {
            code: "effect_journal_conflict",
            message: "A concurrent writer stored terminal uncertainty.",
            recoverable: true,
          },
        );
        if (!raced) throw new Error("racing uncertain write lost unexpectedly");
      },
    });
    expect(racingIdentity).toBeDefined();
    expect(first).toEqual({
      ok: false,
      status: "uncertain",
      error: {
        code: "effect_journal_conflict",
        message: "A concurrent writer stored terminal uncertainty.",
        recoverable: true,
      },
      evidence: {
        effectId: racingIdentity!.effectId,
        identitySha256: racingIdentity!.identitySha256,
        dispatchAttempt: 1,
        errorCode: "effect_journal_conflict",
      },
    });
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(1);
    expect(fixture.reconcileCalls).toBe(1);

    const second = await fixture.execute();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(1);
    expect(fixture.reconcileCalls).toBe(1);
  } finally {
    fixture.close();
  }
});
