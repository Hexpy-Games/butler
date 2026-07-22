import { expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type OperationResult,
  type PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { OperationalInterruptionError } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

const binding: PhaseRunBinding = {
  turnId: "turn-phase-progress",
  turnRevision: 4,
  semanticState: "conception_deliberation",
  checkpointId: "checkpoint-phase-progress",
  checkpointRevision: 2,
  claimId: "claim-phase-progress",
  executionFence: 7,
};

test("interrupts a replayed operation batch at its unchanged checkpoint", async () => {
  const results: OperationResult[] = [];
  const request = {
    requestId: "request-1",
    kind: "observe" as const,
    capabilityRef: "capability-1",
    scopeRef: "scope-1",
    input: { query: "current state" },
  };
  let modelCalls = 0;
  let operationCalls = 0;

  try {
    await runPhaseConversation({
      binding,
      modelSelection: selectedModel(),
      context: openingContext(),
      phaseContract: {
        phase: "conception_deliberation",
        objective: "produce_one_candidate",
        duties: [],
        prohibitions: [],
      },
      codec: {
        submissionSchema: objectSchema({}),
        decode: () => ({ kind: "unreachable" }),
      },
      store: {
        loadAcceptedProduct: async () => null,
        persistAcceptedProduct: async () => undefined,
        loadOperationResults: async () => [...results],
        appendOperationResult: async ({ result }) => {
          results.push(result);
        },
      },
      model: {
        runRound: async () => {
          modelCalls += 1;
          return {
            kind: "operation_requests" as const,
            requests: [request],
            actualIdentity: selectedModel(),
          };
        },
      },
      operations: {
        perform: async () => {
          operationCalls += 1;
          return {
            requestId: request.requestId,
            outcome: "observed" as const,
            observationRef: { id: "observation-1", sha256: "observation-sha" },
            content: "observed once",
          };
        },
      },
      operationAuthority: {
        observationScopeRefs: [request.scopeRef],
        mutation: { kind: "forbidden" },
      },
      executionPermit: activePermit(),
    });
    throw new Error("expected phase interruption");
  } catch (error) {
    expect(error).toBeInstanceOf(OperationalInterruptionError);
    expect((error as OperationalInterruptionError).code)
      .toBe("operation_batch_no_progress");
    expect((error as OperationalInterruptionError).anchor).toEqual(binding);
    expect((error as OperationalInterruptionError).activation).toEqual({
      kind: "runtime_remediation",
    });
  }

  expect(modelCalls).toBe(2);
  expect(operationCalls).toBe(1);
  expect(results).toHaveLength(1);
});

function selectedModel() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: { reasoningEffort: "low" },
    controlsHash: "controls-sha",
  };
}

function openingContext() {
  return {
    originalMessageId: "message-1",
    originalMessage: "inspect the target",
    sessionId: "session-1",
    userRef: "user-1",
    profileRefs: [],
    recentFeedbackRefs: [],
    mandatoryHotCacheRefs: [],
    optionalHotCacheRefs: [],
    baselineObservationScopeRefs: ["scope-1"],
  };
}

function activePermit() {
  return {
    signal: new AbortController().signal,
    assertActive() {},
    close() {},
  };
}
