import { expect, test } from "bun:test";
import {
  objectSchema,
  runPhaseConversation,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";

test("publishes committed model-authored activity before an operation batch", async () => {
  const published: unknown[] = [];
  const eventOrder: string[] = [];
  const request = {
    requestId: "inspect-current-state",
    kind: "observe" as const,
    capabilityRef: "read_file",
    scopeRef: "workspace:test",
    input: { path: "src/current.ts" },
  };
  let modelRound = 0;

  const product = await runPhaseConversation({
    binding,
    modelSelection,
    context,
    phaseContract: {
      phase: "planning",
      operationSurface: "authorized",
      objective: "author_the_plan",
      duties: [],
      prohibitions: [],
    },
    codec: {
      submissionSchema: objectSchema({}),
      decode: () => ({ kind: "plan_candidate" }),
    },
    store: {
      async restore(current) {
        return { binding: current, acceptedProduct: null, operationResults: [] };
      },
      async appendOperationRound({ binding: current }) {
        eventOrder.push("operation_round_committed");
        return nextBinding(current);
      },
      async appendOperationResults({ binding: current }) {
        return nextBinding(current);
      },
      async appendPhaseSubmission({ binding: current }) {
        return nextBinding(current);
      },
      async acceptPhaseProduct({ binding: current }) {
        return nextBinding(current);
      },
    },
    model: {
      async runRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            kind: "operation_requests" as const,
            requests: [request],
            phaseContinuity: {
              objectiveState: "The accepted goal is ready for planning.",
              decisions: ["Inspect the current module before authoring."],
              unresolved: ["The current implementation boundary is unknown."],
              nextOperationPurpose: "Read the current module.",
              publicActivity: {
                summary: "현재 구현 경계를 확인하고 있습니다.",
                rationale: "설계에 맞는 최소 변경 범위를 정하기 위해 필요합니다.",
                nextStep: "확인 결과로 계획 후보를 작성합니다.",
              },
            },
            actualIdentity: modelSelection,
          };
        }
        return {
          kind: "phase_submission" as const,
          submission: { kind: "plan_candidate" },
          publicActivity: {
            summary: "구현 경계를 반영한 계획 후보를 만들었습니다.",
            rationale: "확인한 현재 구조와 요청 목표를 함께 보존했습니다.",
            nextStep: "계획의 완전성과 실행 가능성을 검토합니다.",
          },
          actualIdentity: modelSelection,
        };
      },
    },
    operations: {
      async perform() {
        eventOrder.push("operation_performed");
        return {
          requestId: request.requestId,
          outcome: "observed" as const,
          observationRef: { id: "observation", sha256: "observation-sha" },
          content: "current implementation",
        };
      },
    },
    operationAuthority: {
      observationScopeRefs: [request.scopeRef],
      mutation: { kind: "forbidden" },
    },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
      close() {},
    },
    activity: {
      publish(update) {
        eventOrder.push("activity_published");
        published.push(update);
      },
    },
  });

  expect(product).toEqual({ kind: "plan_candidate" });
  expect(eventOrder).toEqual([
    "operation_round_committed",
    "activity_published",
    "operation_performed",
    "activity_published",
  ]);
  expect(published).toEqual([
    {
      turnId: binding.turnId,
      semanticState: "planning",
      activity: {
        summary: "현재 구현 경계를 확인하고 있습니다.",
        rationale: "설계에 맞는 최소 변경 범위를 정하기 위해 필요합니다.",
        nextStep: "확인 결과로 계획 후보를 작성합니다.",
      },
    },
    {
      turnId: binding.turnId,
      semanticState: "planning",
      activity: {
        summary: "구현 경계를 반영한 계획 후보를 만들었습니다.",
        rationale: "확인한 현재 구조와 요청 목표를 함께 보존했습니다.",
        nextStep: "계획의 완전성과 실행 가능성을 검토합니다.",
      },
    },
  ]);
});

const binding = {
  turnId: "turn-phase-activity",
  turnRevision: 4,
  semanticState: "planning" as const,
  checkpointId: "checkpoint-phase-activity",
  checkpointRevision: 1,
  claimId: "claim-phase-activity",
  executionFence: 0,
};

const modelSelection = {
  provider: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "low" as const,
  controls: { reasoningEffort: "low" },
  controlsHash: "controls-sha",
};

const context = {
  originalMessageId: "message-phase-activity",
  originalMessage: "Plan the requested change.",
  sessionId: "session-phase-activity",
  userRef: "user-phase-activity",
  profileRefs: [],
  recentFeedbackRefs: [],
  mandatoryHotCacheRefs: [],
  optionalHotCacheRefs: [],
  baselineObservationScopeRefs: ["workspace:test"],
};

function nextBinding<Binding extends { checkpointRevision: number }>(
  current: Binding,
): Binding {
  return { ...current, checkpointRevision: current.checkpointRevision + 1 };
}
