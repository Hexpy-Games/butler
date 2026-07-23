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

test("workspace execution rejects a candidate without a successful workspace snapshot", async () => {
  const rejected: OperationResult = {
    requestId: workspaceRequest.requestId,
    request: workspaceRequest,
    outcome: "operation_rejected",
    observationRef: ref("workspace-rejection"),
    content: "operation denied",
  };

  await expect(performTask(executionInvocation([rejected]))).rejects.toThrow(
    "BTCC operational interruption: provider_phase_submission_invalid",
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
  expect(product.result.operationResults).toHaveLength(2);
  expect(product.result.operationResultRefs).toEqual(
    product.result.operationResults.map((result) => result.resultRef),
  );
  expect(product.result.targetStateRevisions.map((revision) => revision.target)).toEqual([
    { kind: "workspace", workspaceRef },
    { kind: "workspace", workspaceRef },
  ]);
});

test("workspace execution records a snapshot-only revision after validation", async () => {
  const validation = observedWorkspaceResult("validation", "snapshot-validated");
  const product = await performTask(executionInvocation([validation]));

  expect(product.kind).toBe("result_candidate");
  if (product.kind !== "result_candidate" || product.result.kind !== "workspace_artifact") {
    throw new Error("expected snapshot-only workspace revision");
  }
  expect(product.result.artifactRevisionRefs).toEqual([]);
  expect(product.result.workspaceRevision.targetSnapshotRef).toEqual(
    ref("snapshot-validated"),
  );
  expect(product.result.workspaceRevision.producedByOperationRefs).toEqual([
    ref("observation-validation"),
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
    "BTCC operational interruption: provider_phase_submission_invalid",
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

test("workspace review diagnoses a criterion outside the current Task", async () => {
  const error = await reviewTask(reviewInvocation([], {
    criterionVerdicts: [{
      criterionRef: ref("another-task-criterion"),
      reviewedResultRefs: [ref("result-summary")],
      observation: "unrelated criterion",
      verdict: "satisfied",
    }],
  })).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toMatchObject({
    message: "Task Review submitted a criterion outside stateInput.criteria",
  });
});

test("workspace review diagnoses a duplicate current Task criterion", async () => {
  const duplicateVerdict = {
    criterionRef: ref("criterion"),
    reviewedResultRefs: [ref("result-summary")],
    observation: "duplicate criterion",
    verdict: "satisfied",
  };
  const error = await reviewTask(reviewInvocation([], {
    criteria: [{ ref: ref("criterion") }, { ref: ref("criterion-two") }],
    verificationQuestions: [{
      ref: ref("verification-question"),
      criterionRef: ref("criterion"),
    }, {
      ref: ref("verification-question-two"),
      criterionRef: ref("criterion-two"),
    }],
    criterionVerdicts: [duplicateVerdict, duplicateVerdict],
  })).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toMatchObject({
    message: "Task Review repeated a current Task criterion",
  });
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

function reviewInvocation(
  results: OperationResult[],
  overrides: {
    criteria?: Array<{ ref: ReturnType<typeof ref> }>;
    verificationQuestions?: Array<{
      ref: ReturnType<typeof ref>;
      criterionRef: ReturnType<typeof ref>;
    }>;
    criterionVerdicts?: unknown[];
  } = {},
): PhaseInvocation {
  const result = workspaceResult();
  if (result.result.kind !== "workspace_artifact") {
    throw new Error("expected workspace artifact result fixture");
  }
  return invocation("task_review", results, {
    resultCandidate: result,
    criteria: overrides.criteria ?? [{ ref: ref("criterion") }],
    verificationQuestions: overrides.verificationQuestions ?? [{
      ref: ref("verification-question"),
      criterionRef: ref("criterion"),
    }],
    reviewAuthorityRef: ref("authority"),
    reviewSourceRef: result.result.workspaceRevisionRef,
  }, overrides.criterionVerdicts);
}

function invocation(
  semanticState: "task_execution" | "task_review",
  results: OperationResult[],
  stateInput: Record<string, unknown>,
  criterionVerdicts?: unknown[],
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
      restore: async (binding) => ({ binding, acceptedProduct: null, operationResults: results }),
      appendOperationRound: async () => { throw new Error("unexpected operation round"); },
      appendOperationResults: async () => { throw new Error("unexpected operation results"); },
      appendPhaseSubmission: async ({ binding }) => ({
        ...binding,
        checkpointRevision: binding.checkpointRevision + 1,
      }),
      acceptPhaseProduct: async ({ binding }) => ({
        ...binding,
        checkpointRevision: binding.checkpointRevision + 1,
      }),
    },
    model: {
      runRound: async () => ({
        kind: "phase_submission",
        submission: semanticState === "task_execution"
          ? { kind: "result_candidate", resultSummary: "artifact updated" }
          : {
              kind: "task_review",
              criterionVerdicts: criterionVerdicts ?? [{
                criterionRef: ref("criterion"),
                reviewedResultRefs: [ref("result-summary")],
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
      ? {
          observationScopeRefs: [],
          mutation: {
            kind: "workspace_only",
            workspaceRef,
            operationRoot: { kind: "file", relativeTarget: "target" },
            mutationScope: { kind: "contained_paths", writablePaths: ["target"] },
          },
        }
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
      resultSummary: { ref: ref("result-summary"), content: "artifact updated" },
      operationResultRefs: [ref("observation-final")],
      operationResults: [],
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

function observedWorkspaceResult(suffix: string, snapshot: string): OperationResult {
  return {
    requestId: `${workspaceRequest.requestId}-${suffix}`,
    request: {
      ...workspaceRequest,
      requestId: `${workspaceRequest.requestId}-${suffix}`,
      capabilityRef: "run-command",
      input: { command: "bun test" },
    },
    outcome: "observed",
    observationRef: ref(`observation-${suffix}`),
    targetSnapshotRef: ref(snapshot),
    content: "validation passed without changing artifact bytes",
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
