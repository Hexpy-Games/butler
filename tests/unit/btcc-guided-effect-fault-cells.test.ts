import { expect, test } from "bun:test";
import type { GuidedEffectFaultPoint } from
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
  try {
    await expect(fixture.execute({
      faultHook(point) {
        if (armed && point === "after_dispatch_marker") {
          armed = false;
          throw new Error("crash after marker");
        }
      },
    })).rejects.toThrow("crash after marker");
    fixture.reconcileMode = "uncertain";

    const first = await fixture.execute();
    const second = await fixture.execute();
    expect(first).toMatchObject({
      ok: false,
      status: "uncertain",
      error: { code: "effect_reconciliation_required", recoverable: true },
    });
    expect(second).toMatchObject({ ok: false, status: "uncertain" });
    expect(fixture.status()).toBe("uncertain");
    expect(fixture.dispatchCalls).toBe(0);

    fixture.reconcileMode = "not_applied";
    const recovered = await fixture.execute();
    expect(recovered).toMatchObject({ ok: true, status: "applied" });
    expect(fixture.dispatchCalls).toBe(1);
  } finally {
    fixture.close();
  }
});
