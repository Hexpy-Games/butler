import { describe, expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type PhaseRunBinding,
  type ProviderCorrection,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  correctionForOperationalInterruption,
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

  test("projects a typed carrier violation without provider prose", () => {
    const diagnostic = {
      schema: "btcc.operational-diagnostic.v1" as const,
      kind: "provider_carrier_rejection" as const,
      path: "$.requests[0].capabilityRef",
      reason: "constant_mismatch" as const,
      shape: {
        carrierType: "object" as const,
        carrierKeys: ["kind", "requests"],
        submissionKeys: [],
        requestsType: "array" as const,
        requestCount: 1,
        requestKeys: [["capabilityRef", "kind"]],
      },
    };
    const correction = correctionForOperationalInterruption(
      new OperationalInterruptionError(
        "provider_protocol_interruption",
        binding,
        { kind: "automatic_provider_recovery" },
        new Error("provider output contained SECRET prose"),
        diagnostic,
      ),
    );

    expect(correction).toEqual({
      kind: "previous_provider_product_rejected",
      code: "provider_protocol_interruption",
      diagnostic,
    });
    expect(JSON.stringify(correction)).not.toContain("SECRET");
  });

  test("consumes correction authority after one accepted provider carrier", async () => {
    const correction: ProviderCorrection = {
      kind: "previous_provider_product_rejected",
      code: "provider_protocol_interruption",
      diagnostic: carrierDiagnostic,
    };
    const observed: Array<ProviderCorrection | undefined> = [];
    let revision = binding.checkpointRevision;
    const product = await runPhaseConversation({
      binding,
      modelSelection: selectedModel,
      context: openingContext,
      phaseContract: {
        phase: "task_execution",
        operationSurface: "authorized",
        objective: "execute_one_task",
        duties: [],
        prohibitions: [],
      },
      codec: {
        submissionSchema: objectSchema({}),
        decode: () => ({ done: true }),
      },
      store: {
        restore: async (current) => ({
          binding: current,
          acceptedProduct: null,
          operationResults: [],
        }),
        appendOperationRound: async () => nextBinding(++revision),
        appendOperationResults: async () => nextBinding(++revision),
        appendPhaseSubmission: async () => nextBinding(++revision),
        acceptPhaseProduct: async () => nextBinding(++revision),
      },
      model: {
        runRound: async (envelope) => {
          observed.push(envelope.providerCorrection);
          return observed.length === 1
            ? {
                kind: "operation_requests",
                requests: [{
                  requestId: "observe-1",
                  publicTitle: "Read current value",
                  kind: "observe",
                  capabilityRef: "test:read",
                  scopeRef: "test:scope",
                  input: {},
                }],
                actualIdentity: selectedModel,
              }
            : {
                kind: "phase_submission",
                submission: { done: true },
                actualIdentity: selectedModel,
              };
        },
      },
      operations: {
        perform: async ({ request }) => ({
          requestId: request.requestId,
          outcome: "observed",
          observationRef: { id: "observation-1", sha256: "observation-sha" },
          completeness: "complete",
          content: "observed",
        }),
      },
      operationAuthority: {
        observationScopeRefs: ["test:scope"],
        mutation: { kind: "forbidden" },
      },
      executionPermit: activePermit(),
      providerCorrection: correction,
    });

    expect(product).toEqual({ done: true });
    expect(observed).toEqual([correction, undefined]);
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

const openingContext = {
  originalMessageId: "message-1",
  originalMessage: "Complete the exact task.",
  sessionId: "session-1",
  userRef: "user-1",
  profileRefs: [],
  recentFeedbackRefs: [],
  mandatoryHotCacheRefs: [],
  optionalHotCacheRefs: [],
  baselineObservationScopeRefs: [],
};

const carrierDiagnostic = {
  schema: "btcc.operational-diagnostic.v1" as const,
  kind: "provider_carrier_rejection" as const,
  path: "$.submission",
  reason: "missing_required" as const,
  shape: {
    carrierType: "object" as const,
    carrierKeys: ["kind"],
    submissionKeys: [],
    requestKeys: [],
  },
};

function nextBinding(checkpointRevision: number): PhaseRunBinding {
  return { ...binding, checkpointRevision };
}

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
