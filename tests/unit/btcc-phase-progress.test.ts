import { expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type OperationResult,
  type PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
const binding: PhaseRunBinding = {
  turnId: "turn-phase-progress",
  turnRevision: 4,
  semanticState: "conception_deliberation",
  checkpointId: "checkpoint-phase-progress",
  checkpointRevision: 2,
  claimId: "claim-phase-progress",
  executionFence: 7,
};

test("accepts a corrected request that reuses its local ID in a later model round", async () => {
  const results: OperationResult[] = [];
  const firstRequest = {
    requestId: "request-1",
    publicTitle: "Test operation",
    kind: "observe" as const,
    capabilityRef: "capability-1",
    scopeRef: "scope-1",
    input: { query: "current state" },
  };
  const correctedRequest = { ...firstRequest, input: { query: "corrected state" } };
  let modelCalls = 0;
  let operationCalls = 0;
  const modelRounds: string[] = [];
  const waitingRounds: string[] = [];

  const product = await runPhaseConversation({
      binding,
      modelSelection: selectedModel(),
      context: openingContext(),
      phaseContract: {
        phase: "conception_deliberation",
        operationSurface: "authorized",
        objective: "produce_one_candidate",
        duties: [],
        prohibitions: [],
      },
      codec: {
        submissionSchema: objectSchema({}),
        decode: (submission) => submission as { kind: string },
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
        appendPhaseSubmission: async ({ binding: current }) => nextBinding(current),
        acceptPhaseProduct: async ({ binding: current }) => nextBinding(current),
      },
      model: {
        runRound: async () => {
          modelCalls += 1;
          if (modelCalls === 1) return operationRound(firstRequest);
          if (modelCalls === 2) return operationRound(correctedRequest);
          return {
            kind: "phase_submission" as const,
            submission: { kind: "complete" },
            actualIdentity: selectedModel(),
          };
        },
      },
      operations: {
        perform: async () => {
          operationCalls += 1;
          return {
            requestId: firstRequest.requestId,
            outcome: "observed" as const,
            observationRef: {
              id: `observation-${operationCalls}`,
              sha256: `observation-sha-${operationCalls}`,
            },
            content: "observed once",
          };
        },
      },
      operationAuthority: {
        observationScopeRefs: [firstRequest.scopeRef],
        mutation: { kind: "forbidden" },
      },
      executionPermit: activePermit(),
      activity: {
        publish: () => {},
        modelRoundWaiting: ({ checkpointId }) => {
          waitingRounds.push(checkpointId);
        },
      },
    });

  expect(product).toEqual({ kind: "complete" });
  expect(modelCalls).toBe(3);
  expect(operationCalls).toBe(2);
  expect(results).toHaveLength(2);
  expect(modelRounds).toEqual(["operation_requests", "operation_requests"]);
  expect(waitingRounds).toEqual([
    "checkpoint-phase-progress",
    "checkpoint-phase-progress",
    "checkpoint-phase-progress",
  ]);
});

function operationRound(request: {
  requestId: string;
  publicTitle: string;
  kind: "observe";
  capabilityRef: string;
  scopeRef: string;
  input: Record<string, unknown>;
}) {
  return {
    kind: "operation_requests" as const,
    requests: [request],
    actualIdentity: selectedModel(),
  };
}

test("projects a closed operation surface before the Opening model call", async () => {
  let modelCalls = 0;
  let accepted = false;
  const product = await runPhaseConversation({
    binding: {
      ...binding,
      semanticState: "conception_opening",
      checkpointId: "checkpoint-opening-closed",
    },
    modelSelection: selectedModel(),
    context: openingContext(),
    phaseContract: {
      phase: "conception_opening",
      operationSurface: "closed",
      objective: "publish_the_first_useful_message",
      duties: [],
      prohibitions: [],
    },
    codec: {
      submissionSchema: objectSchema({}),
      decode: () => ({ kind: "opening_continuation" }),
    },
    store: {
      restore: async (current) => ({
        binding: current,
        acceptedProduct: null,
        operationResults: [],
      }),
      appendOperationRound: async () => {
        throw new Error("Opening must not append an operation round");
      },
      appendOperationResults: async () => {
        throw new Error("Opening must not append operation results");
      },
      appendPhaseSubmission: async ({ binding: current }) => nextBinding(current),
      acceptPhaseProduct: async ({ binding: current }) => {
        accepted = true;
        return nextBinding(current);
      },
    },
    model: {
      runRound: async (envelope) => {
        modelCalls += 1;
        expect(envelope.operationSurface).toBe("closed");
        expect(envelope.operationAuthority).toEqual({
          observationScopeRefs: [],
          mutation: { kind: "forbidden" },
        });
        return {
          kind: "phase_submission",
          submission: { kind: "opening_continuation" },
          actualIdentity: selectedModel(),
        };
      },
    },
    operations: {
      perform: async () => {
        throw new Error("Opening must not perform an operation");
      },
    },
    operationAuthority: {
      observationScopeRefs: ["workspace:/repo", "ledger:project"],
      mutation: { kind: "forbidden" },
    },
    executionPermit: activePermit(),
  });

  expect(product).toEqual({ kind: "opening_continuation" });
  expect(modelCalls).toBe(1);
  expect(accepted).toBe(true);
});

test("does not checkpoint a malformed provider phase submission", async () => {
  let appended = false;
  const run = runPhaseConversation({
    binding,
    modelSelection: selectedModel(),
    context: openingContext(),
    phaseContract: {
      phase: "conception_deliberation" as const,
      operationSurface: "authorized" as const,
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
    publicTitle: "Test operation",
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
      operationSurface: "authorized" as const,
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

test("returns a phase authority rejection without dispatching the operation", async () => {
  const results: OperationResult[] = [];
  const workspaceRef = { id: "workspace-1", sha256: "workspace-sha" };
  let calls = 0;
  const product = await runPhaseConversation({
    binding,
    modelSelection: selectedModel(),
    context: openingContext(),
    phaseContract: {
      phase: "task_execution",
      operationSurface: "authorized",
      objective: "execute_only_the_accepted_target",
      duties: [],
      prohibitions: [],
    },
    codec: {
      submissionSchema: objectSchema({}),
      decode: () => ({ kind: "complete" }),
    },
    store: {
      restore: async (current) => ({
        binding: current,
        acceptedProduct: null,
        operationResults: [...results],
      }),
      appendOperationRound: async ({ binding: current }) => nextBinding(current),
      appendOperationResults: async ({ binding: current, results: appended }) => {
        results.push(...appended.map((item) => item.result));
        return nextBinding(current);
      },
      appendPhaseSubmission: async ({ binding: current }) => nextBinding(current),
      acceptPhaseProduct: async ({ binding: current }) => nextBinding(current),
    },
    model: {
      runRound: async (envelope) => {
        calls += 1;
        if (calls === 1) {
          return {
            kind: "operation_requests",
            requests: [{
              requestId: "denied-root",
              publicTitle: "Test operation",
              kind: "workspace_artifact_action",
              capabilityRef: "workspace:write",
              workspaceRef,
              relativeTarget: ".",
              input: { action: "inspect" },
              runtimeAdmission: {
                kind: "rejected",
                code: "operation_authority_mismatch",
              },
            }],
            actualIdentity: selectedModel(),
          };
        }
        expect(envelope.operationResults).toMatchObject([{
          requestId: "denied-root",
          outcome: "operation_rejected",
        }]);
        return {
          kind: "phase_submission",
          submission: { kind: "complete" },
          actualIdentity: selectedModel(),
        };
      },
    },
    operations: {
      perform: async () => {
        throw new Error("unadmitted operation must not be dispatched");
      },
    },
    operationAuthority: {
      observationScopeRefs: [],
      mutation: { kind: "forbidden" },
    },
    executionPermit: activePermit(),
  });

  expect(product).toEqual({ kind: "complete" });
  expect(calls).toBe(2);
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
