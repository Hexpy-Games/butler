import { describe, expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type PhaseRunBinding,
  type ProviderCorrection,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  OperationalInterruptionError,
  shouldScheduleAutomaticRecovery,
} from "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

describe("BTCC provider correction progress", () => {
  test("offers one automatic correction opportunity for the first invalid submission", async () => {
    const error = await malformedSubmission();

    expect(error).toMatchObject({
      code: "provider_phase_submission_invalid",
      activation: { kind: "automatic_provider_recovery" },
    });
    expect(shouldScheduleAutomaticRecovery(error)).toBe(true);
  });

  test("holds a repeated invalid submission when correction already exists", async () => {
    const error = await malformedSubmission({
      kind: "previous_provider_product_rejected",
      code: "provider_phase_submission_invalid",
      diagnosticMessage: "submission was malformed",
    });

    expect(error).toMatchObject({
      code: "provider_phase_submission_invalid",
      activation: { kind: "runtime_remediation" },
    });
    expect(shouldScheduleAutomaticRecovery(error)).toBe(false);
  });
});

async function malformedSubmission(
  providerCorrection?: ProviderCorrection,
): Promise<OperationalInterruptionError> {
  try {
    await runPhaseConversation({
      binding,
      modelSelection: selectedModel,
      context: {
        originalMessageId: "message-1",
        originalMessage: "Complete the exact task.",
        sessionId: "session-1",
        userRef: "user-1",
        profileRefs: [],
        recentFeedbackRefs: [],
        mandatoryHotCacheRefs: [],
        optionalHotCacheRefs: [],
        baselineObservationScopeRefs: [],
      },
      phaseContract: {
        phase: "task_review",
        operationSurface: "authorized",
        objective: "review_the_exact_result",
        duties: [],
        prohibitions: [],
      },
      codec: {
        submissionSchema: objectSchema({}),
        decode: () => {
          throw new Error("malformed submission");
        },
      },
      store: {
        restore: async (current) => ({
          binding: current,
          acceptedProduct: null,
          operationResults: [],
        }),
        appendOperationRound: async () => unexpected("operation round"),
        appendOperationResults: async () => unexpected("operation result"),
        appendPhaseSubmission: async () => unexpected("phase submission"),
        acceptPhaseProduct: async () => unexpected("accepted product"),
      },
      model: {
        runRound: async () => ({
          kind: "phase_submission",
          submission: { malformed: true },
          actualIdentity: selectedModel,
        }),
      },
      operations: { perform: async () => unexpected("operation execution") },
      operationAuthority: {
        observationScopeRefs: [],
        mutation: { kind: "forbidden" },
      },
      executionPermit: activePermit(),
      ...(providerCorrection ? { providerCorrection } : {}),
    });
  } catch (error) {
    if (error instanceof OperationalInterruptionError) return error;
    throw error;
  }
  throw new Error("malformed submission unexpectedly succeeded");
}

const binding: PhaseRunBinding = {
  turnId: "turn-provider-correction",
  turnRevision: 2,
  semanticState: "task_review",
  checkpointId: "checkpoint-provider-correction",
  checkpointRevision: 1,
  claimId: "claim-provider-correction",
  executionFence: 3,
};

const selectedModel = {
  provider: "zai",
  model: "glm-5.2",
  reasoningEffort: "medium",
  controls: { reasoningEffort: "medium" },
  controlsHash: "controls-hash",
} as const;

function activePermit() {
  return {
    signal: new AbortController().signal,
    assertActive() {},
    close() {},
  };
}

function unexpected(label: string): never {
  throw new Error(`unexpected ${label}`);
}
