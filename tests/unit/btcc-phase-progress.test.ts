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
  const modelRounds: string[] = [];

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
        restore: async (current) => ({
          binding: current,
          acceptedProduct: null,
          operationResults: [...results],
        }),
        appendOperationRound: async ({ binding: current }) => {
          modelRounds.push("operation_requests");
          return nextBinding(current);
        },
        appendOperationResults: async ({ binding: current, results: appended }) => {
          results.push(...appended.map((item) => item.result));
          return nextBinding(current);
        },
        appendPhaseSubmission: async () => {
          throw new Error("unexpected phase submission");
        },
        acceptPhaseProduct: async () => {
          throw new Error("unexpected phase product");
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
    expect((error as OperationalInterruptionError).anchor).toEqual({
      ...binding,
      checkpointRevision: 5,
    });
    expect((error as OperationalInterruptionError).activation).toEqual({
      kind: "runtime_remediation",
    });
  }

  expect(modelCalls).toBe(2);
  expect(operationCalls).toBe(1);
  expect(results).toHaveLength(1);
  expect(modelRounds).toEqual(["operation_requests", "operation_requests"]);
});

test("does not checkpoint a malformed provider phase submission", async () => {
  let appended = false;
  const run = runPhaseConversation({
    binding,
    modelSelection: selectedModel(),
    context: openingContext(),
    phaseContract: {
      phase: "conception_deliberation" as const,
      objective: "produce_one_candidate",
      duties: [],
      prohibitions: [],
    },
    codec: {
      submissionSchema: objectSchema({}),
      decode: () => { throw new Error("malformed submission"); },
    },
    store: {
      restore: async (current) => ({
        binding: current,
        acceptedProduct: null,
        operationResults: [],
      }),
      appendOperationRound: async () => { throw new Error("unexpected operation"); },
      appendOperationResults: async () => { throw new Error("unexpected result"); },
      appendPhaseSubmission: async ({ binding: current }) => {
        appended = true;
        return nextBinding(current);
      },
      acceptPhaseProduct: async () => { throw new Error("unexpected product"); },
    },
    model: {
      runRound: async () => ({
        kind: "phase_submission" as const,
        submission: { malformed: true },
        actualIdentity: selectedModel(),
      }),
    },
    operations: {
      perform: async () => { throw new Error("unexpected operation"); },
    },
    operationAuthority: {
      observationScopeRefs: [],
      mutation: { kind: "forbidden" as const },
    },
    executionPermit: activePermit(),
  });

  await expect(run).rejects.toMatchObject({
    code: "provider_phase_submission_invalid",
    activation: { kind: "automatic_provider_recovery" },
  });
  expect(appended).toBe(false);
});

test("anchors provider recovery after the latest operation checkpoint", async () => {
  const request = {
    requestId: "request-before-interruption",
    kind: "observe" as const,
    capabilityRef: "capability-1",
    scopeRef: "scope-1",
    input: {},
  };
  let calls = 0;
  const run = runPhaseConversation({
    binding,
    modelSelection: selectedModel(),
    context: openingContext(),
    phaseContract: {
      phase: "conception_deliberation" as const,
      objective: "recover_exactly",
      duties: [],
      prohibitions: [],
    },
    codec: { submissionSchema: objectSchema({}), decode: () => ({}) },
    store: {
      restore: async (current) => ({
        binding: current,
        acceptedProduct: null,
        operationResults: [],
      }),
      appendOperationRound: async ({ binding: current }) => nextBinding(current),
      appendOperationResults: async ({ binding: current }) => nextBinding(current),
      appendPhaseSubmission: async () => { throw new Error("unexpected submission"); },
      acceptPhaseProduct: async () => { throw new Error("unexpected product"); },
    },
    model: {
      runRound: async () => calls++ === 0
        ? { kind: "operation_requests", requests: [request], actualIdentity: selectedModel() }
        : {
            kind: "interruption",
            code: "provider_api_error",
            activation: { kind: "automatic_provider_recovery" },
          },
    },
    operations: {
      perform: async () => ({
        requestId: request.requestId,
        outcome: "observed" as const,
        observationRef: { id: "observation", sha256: "observation-sha" },
        content: "observed",
      }),
    },
    operationAuthority: {
      observationScopeRefs: [request.scopeRef],
      mutation: { kind: "forbidden" as const },
    },
    executionPermit: activePermit(),
  });

  await expect(run).rejects.toMatchObject({
    code: "provider_api_error",
    anchor: { checkpointRevision: binding.checkpointRevision + 2 },
  });
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

function nextBinding(current: PhaseRunBinding): PhaseRunBinding {
  return { ...current, checkpointRevision: current.checkpointRevision + 1 };
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
