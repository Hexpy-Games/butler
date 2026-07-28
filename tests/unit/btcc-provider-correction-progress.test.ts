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
} from "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

describe("BTCC provider correction progress", () => {
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
        appendProviderProductRejection: async () => nextBinding(++revision),
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
