import { expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
  type OperationRequest,
  type OperationResult,
  type PhaseRunBinding,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";

const binding: PhaseRunBinding = {
  turnId: "turn-result-read",
  turnRevision: 1,
  semanticState: "conception_deliberation",
  checkpointId: "checkpoint-result-read",
  checkpointRevision: 1,
  claimId: "claim-result-read",
  executionFence: 1,
};

test("authorizes an exact read from a prior operation result without rerunning it", async () => {
  const results: OperationResult[] = [];
  const observed = {
    requestId: "observe-large",
    kind: "observe" as const,
    capabilityRef: "web_read",
    scopeRef: "web:https://example.com",
    input: { url: "https://example.com" },
  };
  const resultRef = { id: "operation-result:large", sha256: "large-sha" };
  const readScopeRef = "result:operation-result%3Alarge:large-sha";
  let modelCalls = 0;
  let observedCalls = 0;
  let readCalls = 0;

  const product = await runPhaseConversation({
    binding,
    modelSelection: selectedModel(),
    context: phaseContext(),
    phaseContract: {
      phase: "conception_deliberation",
      operationSurface: "authorized",
      objective: "read_the_missing_range",
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
      appendOperationRound: async ({ binding: current }) => next(current),
      appendOperationResults: async ({ binding: current, results: appended }) => {
        results.push(...appended.map((item) => item.result));
        return next(current);
      },
      appendPhaseSubmission: async ({ binding: current }) => next(current),
      acceptPhaseProduct: async ({ binding: current }) => next(current),
    },
    model: {
      runRound: async (envelope) => {
        modelCalls += 1;
        if (modelCalls === 1) return operationRound(observed);
        if (modelCalls === 2) {
          expect(envelope.operationAuthority.observationScopeRefs).toContain(readScopeRef);
          return operationRound({
            requestId: "read-large-middle",
            kind: "observe",
            capabilityRef: "read_operation_result",
            scopeRef: readScopeRef,
            input: { selector: "bytes", start: 50_000, length: 200 },
          });
        }
        return {
          kind: "phase_submission" as const,
          submission: { kind: "complete" },
          actualIdentity: selectedModel(),
        };
      },
    },
    operations: {
      perform: async ({ request }) => {
        if (request.capabilityRef === "read_operation_result") {
          readCalls += 1;
          return projection(request, {
            resultRef,
            readScopeRef,
            requestRef: { id: "operation-request:read", sha256: "read-sha" },
            preview: "",
            view: {
              selector: { kind: "bytes" as const, start: 50_000, length: 200 },
              content: "exact middle",
              byteStart: 50_000,
              byteEnd: 50_012,
              complete: true,
            },
          });
        }
        observedCalls += 1;
        return projection(request, {
          resultRef,
          readScopeRef,
          requestRef: { id: "operation-request:large", sha256: "request-sha" },
          preview: "bounded preview",
        });
      },
    },
    operationAuthority: {
      observationScopeRefs: [observed.scopeRef],
      mutation: { kind: "forbidden" },
    },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
      close() {},
    },
  });

  expect(product).toEqual({ kind: "complete" });
  expect({ observedCalls, readCalls }).toEqual({ observedCalls: 1, readCalls: 1 });
});

function projection(
  request: OperationRequest,
  input: {
    resultRef: { id: string; sha256: string };
    requestRef: { id: string; sha256: string };
    readScopeRef: string;
    preview: string;
    view?: {
      selector: { kind: "bytes"; start: number; length: number };
      content: string;
      byteStart: number;
      byteEnd: number;
      complete: boolean;
    };
  },
) {
  return {
    requestId: request.requestId,
    request,
    capabilityRef: request.capabilityRef,
    outcome: "observed" as const,
    resultRef: input.resultRef,
    requestRef: input.requestRef,
    completeness: "complete" as const,
    byteLength: 120_000,
    observationRef: { id: "observation:large", sha256: "observation-sha" },
    preview: input.preview,
    omittedBytes: 120_000 - Buffer.byteLength(input.preview),
    readScopeRef: input.readScopeRef,
    ...(input.view ? { view: input.view } : {}),
  };
}

function operationRound(request: {
  requestId: string;
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

function selectedModel() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: {},
    controlsHash: "controls",
  };
}

function next(current: PhaseRunBinding): PhaseRunBinding {
  return { ...current, checkpointRevision: current.checkpointRevision + 1 };
}

function phaseContext() {
  return {
    originalMessageId: "message-1",
    originalMessage: "inspect exact output",
    sessionId: "session-1",
    userRef: "user-1",
    profileRefs: [],
    recentFeedbackRefs: [],
    mandatoryHotCacheRefs: [],
    optionalHotCacheRefs: [],
    baselineObservationScopeRefs: [observedScope()],
  };
}

function observedScope(): string {
  return "web:https://example.com";
}
