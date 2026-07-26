import { describe, expect, test } from "bun:test";
import {
  createOperationalRecoveryBoundary,
  OperationalInterruptionError,
  type OperationalRecoveryReadiness,
  type OperationalRecoveryStore,
} from "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

describe("BTCC operational re-entry", () => {
  test("persists before readiness and never uses an exhaustion count", async () => {
    const events: string[] = [];
    const store = recoveryStore(events);
    const readiness: OperationalRecoveryReadiness = {
      async wait({ receipt }) {
        events.push(`ready:${receipt.activationCount}`);
      },
    };
    const recovery = createOperationalRecoveryBoundary(store, readiness);

    await recovery.awaitReentry(interruption("provider_http_502"), new AbortController().signal);
    await recovery.awaitReentry(interruption("provider_http_502"), new AbortController().signal);

    expect(events).toEqual(["record:1", "ready:1", "record:2", "ready:2"]);
  });

  test("keeps action-required recovery owned until Stop aborts it", async () => {
    const recovery = createOperationalRecoveryBoundary(recoveryStore([]));
    const controller = new AbortController();
    const waiting = recovery.awaitReentry(
      interruption("provider_http_400", "provider_action_required"),
      controller.signal,
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  test("resumes a ready durable interruption without another cooldown or activation", async () => {
    const events: string[] = [];
    const durable = interruption("provider_phase_submission_invalid");
    const store: OperationalRecoveryStore = {
      async record() {
        events.push("record");
        return { interruptionId: "interruption-1", activationCount: 1 };
      },
      async markReady() { events.push("mark-ready"); },
      async activateInheritedRuntimeRemediations() {},
      async pending() { return { interruption: durable, status: "ready" }; },
      async resolve() { return true; },
      async pendingTurnIds() { return [checkpoint.turnId]; },
    };
    const recovery = createOperationalRecoveryBoundary(store, {
      async wait() { events.push("wait"); },
    });

    expect(await recovery.pending(checkpoint)).toEqual({
      interruption: durable,
      status: "ready",
    });
    expect(events).toEqual([]);
  });
});

function recoveryStore(events: string[]): OperationalRecoveryStore {
  let activationCount = 0;
  return {
    async record() {
      activationCount += 1;
      events.push(`record:${activationCount}`);
      return { interruptionId: "interruption-1", activationCount };
    },
    async markReady() {},
    async activateInheritedRuntimeRemediations() {},
    async pending() { return null; },
    async resolve() { return true; },
    async pendingTurnIds() {
      return [];
    },
  };
}

function interruption(
  code: string,
  activation: "automatic_provider_recovery" | "provider_action_required" =
    "automatic_provider_recovery",
): OperationalInterruptionError {
  return new OperationalInterruptionError(code, checkpoint, { kind: activation });
}

const checkpoint = {
  turnId: "turn-1",
  turnRevision: 2,
  semanticState: "planning",
  checkpointId: "checkpoint-1",
  checkpointRevision: 3,
  claimId: "claim-1",
  executionFence: 4,
};
