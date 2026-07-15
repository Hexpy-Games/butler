import { describe, expect, test } from "bun:test";
import {
  RUNTIME_UNCLASSIFIED_INTERRUPTION,
  routeTurnInterruption,
  runtimeInterruptionFromUnknown,
} from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-router.ts";
import {
  TURN_INTERRUPTION_ENVELOPE_SCHEMA,
  type RuntimeInterruptionEnvelope,
  type TurnInterruptionEnvelope,
} from "../../packages/butler-agent/src/agent/turn/interruption/turn-interruption-types.ts";

const base = {
  schemaVersion: TURN_INTERRUPTION_ENVELOPE_SCHEMA,
  interruptionId: "interruption-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  origin: "phase_runtime" as const,
  currentGeneration: 3,
  lastStableCheckpointRef: "checkpoint-3",
  createdAt: "2026-07-15T00:00:00.000Z",
};

function runtime(
  overrides: Partial<RuntimeInterruptionEnvelope> = {},
): RuntimeInterruptionEnvelope {
  return {
    ...base,
    kind: "runtime_interruption",
    diagnosticCode: "provider_stream_corruption",
    sideEffectState: "indeterminate",
    resumePredicateRef: "provider-stream-reconciled",
    wakeRevisionRef: "provider-revision-1",
    diagnosticRefs: ["diagnostic-1"],
    ...overrides,
  };
}

describe("TurnInterruptionRouter", () => {
  test("is total over typed routes without a failure or delivery output", () => {
    const directives = [
      routeTurnInterruption({
        ...base,
        kind: "internal_incompletion",
        continuationCheckpointRef: "checkpoint-4",
      }),
      routeTurnInterruption({
        ...base,
        kind: "user_authority_required",
        ownerRef: "user-blocker-1",
      }),
      routeTurnInterruption({
        ...base,
        kind: "external_authority_required",
        ownerRef: "external-job-1",
        wakeRevisionRef: "external-revision-1",
      }),
      routeTurnInterruption(runtime()),
      routeTurnInterruption({
        ...base,
        kind: "user_cancellation",
        cancellationGeneration: 3,
        cancellationReceiptRef: "principal-cancel-1",
      }),
    ];

    expect(directives.map((item) => item.kind)).toEqual([
      "continue_same_turn",
      "waiting_user",
      "waiting_external",
      "waiting_runtime",
      "cancelled",
    ]);
    expect(JSON.stringify(directives)).not.toContain("failed");
    expect(JSON.stringify(directives)).not.toContain("runtime_fault");
    expect(JSON.stringify(directives)).not.toContain("delivered");
  });

  test("creates one typed RecoveryCase without inspecting exception prose", () => {
    const first = routeTurnInterruption(runtimeInterruptionFromUnknown({
      ...base,
      error: new Error("Butler could not complete this turn"),
      sideEffectState: "none",
      resumePredicateRef: "runtime-revision-changed",
      diagnosticRefs: ["operator-log-1", "operator-log-1"],
    }));
    const second = routeTurnInterruption(runtimeInterruptionFromUnknown({
      ...base,
      error: new Error("a completely different message"),
      sideEffectState: "none",
      resumePredicateRef: "runtime-revision-changed",
      diagnosticRefs: ["operator-log-1", "operator-log-1"],
    }));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "waiting_runtime",
      interruptionReceipt: {
        diagnosticCode: RUNTIME_UNCLASSIFIED_INTERRUPTION,
        diagnosticRefs: ["operator-log-1"],
      },
      recoveryCase: {
        owner: "turn_runtime_recovery",
        status: "open",
        publicStatusId: "runtime_recovery_pending",
        availableControlRefs: ["turn.stop"],
      },
    });
  });

  test("rejects work observations because they are not interruption kinds", () => {
    const workObservationKinds = [
      "tool_invalid_arguments",
      "tool_unavailable",
      "command_failed",
      "test_failed",
      "validation_failed",
      "completion_gap",
      "public_decision_required",
      "goal_incomplete",
    ];
    for (const kind of workObservationKinds) {
      expect(() => routeTurnInterruption({
        ...base,
        kind,
      } as unknown as TurnInterruptionEnvelope)).toThrow(
        "turn_interruption_kind_invalid",
      );
    }
  });

  test("accepts cancellation only for the exact active generation", () => {
    expect(() => routeTurnInterruption({
      ...base,
      kind: "user_cancellation",
      cancellationGeneration: 2,
      cancellationReceiptRef: "principal-cancel-stale",
    })).toThrow("turn_cancellation_generation_mismatch");
  });
});
