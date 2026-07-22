import { describe, expect, test } from "bun:test";
import {
  OperationalInterruptionError,
  shouldScheduleAutomaticRecovery,
  type OperationalActivation,
} from "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

describe("BTCC operational recovery policy", () => {
  test("only provider recovery conditions may schedule an automatic replay", () => {
    const cases: Array<[OperationalActivation, boolean]> = [
      [{ kind: "automatic_provider_recovery" }, true],
      [{ kind: "provider_action_required" }, false],
      [{ kind: "runtime_remediation" }, false],
      [{ kind: "cancelled" }, false],
    ];

    for (const [activation, expected] of cases) {
      const interruption = new OperationalInterruptionError(
        "test",
        checkpoint,
        activation,
      );
      expect(shouldScheduleAutomaticRecovery(interruption)).toBe(expected);
    }
  });
});

const checkpoint = {
  turnId: "turn-1",
  turnRevision: 2,
  semanticState: "planning",
  checkpointId: "checkpoint-1",
  checkpointRevision: 1,
  claimId: "claim-1",
  executionFence: 4,
};
