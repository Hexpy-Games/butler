import { expect, test } from "bun:test";
import type {
  OperationResult,
  PhaseInvocation,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { performTask } from
  "../../packages/butler-agent/src/agent/btcc/execution/perform-task.ts";
import type { ResultCandidateProduct } from
  "../../packages/butler-agent/src/agent/btcc/execution/index.ts";
import { reviewTask } from
  "../../packages/butler-agent/src/agent/btcc/review/review-task.ts";

const workspaceRef = ref("workspace");
const workspaceRequest = {
  requestId: "workspace-action",
  kind: "workspace_artifact_action" as const,
  capabilityRef: "workspace-editor",
  workspaceRef,
  relativeTarget: "guide.md",
  input: { content: "updated" },
};

test("workspace execution rejects a candidate without an applied artifact result", async () => {
  const rejected: OperationResult = {
    requestId: workspaceRequest.requestId,
    request: workspaceRequest,
    outcome: "operation_rejected",
    observationRef: ref("workspace-rejection"),
    content: "operation denied",
  };

  await expect(performTask(executionInvocation([rejected]))).rejects.toThrow(
    "BTCC operational interruption: phase_contract_interruption",
  );
});

test("workspace execution binds the final successfully applied snapshot", async () => {
  const first = appliedResult("first", "snapshot-first");
  const final = appliedResult("final", "snapshot-final");
  const product = await performTask(executionInvocation([first, final]));

  expect(product.kind).toBe("result_candidate");
  if (product.kind !== "result_candidate" || product.result.kind !== "workspace_artifact") {
    throw new Error("expected workspace artifact result");
  }
  expect(product.result.workspaceRevision.targetSnapshotRef).toEqual(
    ref("snapshot-final"),
  );
  expect(product.result.workspaceRevision.producedByOperationRefs).toEqual([
    ref("observation-first"),
    ref("observation-final"),
  ]);
});

test("workspace review cannot pass when validation was rejected", async () => {
  const rejectedValidation: OperationResult = {
    requestId: "review-validation",
    request: reviewValidationRequest(),
    outcome: "operation_rejected",
    observationRef: ref("review-rejection"),
    content: "validation could not run",
  };

  await expect(reviewTask(reviewInvocation([rejectedValidation]))).rejects.toThrow(
    "BTCC operational interruption: phase_contract_interruption",
  );
});

test("workspace review passes with a successful disposable validation receipt", async () => {
  const validated: OperationResult = {
    requestId: "review-validation",
    request: reviewValidationRequest(),
    outcome: "review_validated",
    observationRef: ref("review-observation"),
    validationReceiptRef: ref("validation-receipt"),
    content: "validation passed in disposable overlay",
  };
  const product = await reviewTask(reviewInvocation([validated]));

  expect(product.kind).toBe("task_review");
  if (product.kind !== "task_review") throw new Error("expected task review");
  expect(product.review.verdict).toBe("passed");
  expect(product.review.reviewValidationReceiptSetRefs).toEqual([
    ref("validation-receipt"),
  ]);
});

function executionInvocation(results: OperationResult[]): PhaseInvocation {
  return invocation("task_execution", results, {
    goalContractRef: ref("goal"),
    authorityRef: ref("authority"),
    workRef: ref("work"),
    taskRef: ref("task"),
    taskRevisionSha256: "task-revision-sha",
    attemptRef: ref("attempt"),
    executionTargetRef: ref("execution-target"),
    executionTarget: {
      target: {
        kind: "provisioned_workspace",
        workspaceRef,
        baselineSnapshotRef: ref("baseline-snapshot"),
        acceptedBaseRevisionRefs: [],
      },
    },
    targetScopeRefs: ["guide.md"],
  });
}

function reviewInvocation(results: OperationResult[]): PhaseInvocation {
  const result = workspaceResult();
  if (result.result.kind !== "workspace_artifact") {
    throw new Error("expected workspace artifact result fixture");
  }
  return invocation("task_review", results, {
    resultCandidate: result,
    criteria: [{ ref: ref("criterion") }],
    verificationQuestions: [{
      ref: ref("verification-question"),
      criterionRef: ref("criterion"),
    }],
    reviewSourceRef: result.result.workspaceRevisionRef,
  });
}

function invocation(
  semanticState: "task_execution" | "task_review",
  results: OperationResult[],
  stateInput: Record<string, unknown>,
): PhaseInvocation {
  return {
    binding: {
      turnId: "turn-artifact-required",
      turnRevision: 8,
      semanticState,
      checkpointId: `checkpoint-${semanticState}`,
      checkpointRevision: 1,
      claimId: `claim-${semanticState}`,
      executionFence: 3,
    },
    modelSelection: selectedModel(),
    context: {
      originalMessageId: "message-1",
      originalMessage: "change and validate the artifact",
      sessionId: "session-1",
      userRef: "user-1",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
      stateInput,
    },
    store: {
      loadAcceptedProduct: async () => null,
      persistAcceptedProduct: async () => undefined,
      loadOperationResults: async () => results,
      appendOperationResult: async () => undefined,
    },
    model: {
      runRound: async () => ({
        kind: "phase_submission",
        submission: semanticState === "task_execution"
          ? { kind: "result_candidate", resultSummary: "artifact updated" }
          : {
              kind: "task_review",
              criterionVerdicts: [{
                observation: "the disposable validation passed",
                verdict: "satisfied",
              }],
            },
        actualIdentity: selectedModel(),
      }),
    },
    operations: {
      perform: async () => {
        throw new Error("unexpected operation request");
      },
    },
    operationAuthority: semanticState === "task_execution"
      ? { observationScopeRefs: [], mutation: { kind: "workspace_only", workspaceRef } }
      : {
          observationScopeRefs: [],
          mutation: {
            kind: "validation_overlay_only",
            reviewSourceRef: ref("workspace-revision"),
          },
        },
    executionPermit: activePermit(),
  };
}

function workspaceResult(): ResultCandidateProduct {
  const revision = {
    ref: ref("workspace-revision"),
    workspaceRef,
    producingWorkRef: ref("work"),
    producingTaskRef: ref("task"),
    producingAttemptRef: ref("attempt"),
    baseAcceptedRevisionRefs: [],
    artifactRevisionRefs: [ref("artifact")],
    targetSnapshotRef: ref("snapshot-final"),
    producedByOperationRefs: [ref("observation-final")],
  };
  return {
    kind: "result_candidate",
    result: {
      ref: ref("result"),
      kind: "workspace_artifact",
      turnId: "turn-artifact-required",
      goalContractRef: ref("goal"),
      authorityRef: ref("authority"),
      workRef: ref("work"),
      taskRef: ref("task"),
      taskRevisionSha256: "task-revision-sha",
      attemptRef: ref("attempt"),
      executionTargetRef: ref("execution-target"),
      executionCheckpointRef: "checkpoint-task_execution",
      resultSummaryRef: ref("result-summary"),
      operationResultRefs: [ref("observation-final")],
      unresolvedConditionRefs: [],
      targetStateRevisions: [],
      effectReceiptRefs: [],
      workspaceRef,
      workspaceRevisionRef: revision.ref,
      workspaceRevision: revision,
      artifactRevisionRefs: revision.artifactRevisionRefs,
    },
  };
}

function appliedResult(suffix: string, snapshot: string): OperationResult {
  return {
    requestId: `${workspaceRequest.requestId}-${suffix}`,
    request: { ...workspaceRequest, requestId: `${workspaceRequest.requestId}-${suffix}` },
    outcome: "workspace_artifact_applied",
    observationRef: ref(`observation-${suffix}`),
    artifactRevisionRef: ref(`artifact-${suffix}`),
    targetSnapshotRef: ref(snapshot),
    content: `applied ${suffix}`,
  };
}

function reviewValidationRequest() {
  return {
    requestId: "review-validation",
    kind: "review_validation" as const,
    capabilityRef: "test-runner",
    reviewSourceRef: ref("workspace-revision"),
    input: { command: "test" },
  };
}

function ref(id: string) {
  return { id, sha256: `${id}-sha` };
}

function selectedModel() {
  return {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "low" as const,
    controls: { reasoningEffort: "low" },
    controlsHash: "controls-sha",
  };
}

function activePermit() {
  return {
    signal: new AbortController().signal,
    assertActive() {},
    close() {},
  };
}
