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
  publicTitle: "Test operation",
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
  expect(product.result.operationResultRefs).toHaveLength(2);
  expect(product.result.operationResultReadScopeRefs).toHaveLength(2);
  expect(product.result.operationResultReadScopeRefs.every(
    (scopeRef) => scopeRef.startsWith("result:operation-result"),
  )).toBe(true);
  expect("operationResults" in product.result).toBe(false);
  expect(JSON.stringify(product)).not.toContain("applied first");
  expect(JSON.stringify(product)).not.toContain("applied final");
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
  expect(product.review.reviewedResultRefs[0]).toEqual(ref("result-summary"));
  expect(product.review.reviewedResultRefs).toHaveLength(2);
  expect(product.review.criterionVerdicts[0]?.reviewedResultRefs)
    .toEqual(product.review.reviewedResultRefs);
});

test("Task Review records an independent improvement as backlog without reopening the Task", async () => {
  const validated: OperationResult = {
    requestId: "review-validation",
    request: reviewValidationRequest(),
    outcome: "review_validated",
    observationRef: ref("review-observation"),
    validationReceiptRef: ref("validation-receipt"),
    content: "validation passed in disposable overlay",
  };
  const product = await reviewTask(reviewInvocation([validated], {
    criterionVerdicts: [{
      criterionRef: ref("criterion"),
      observation: "The accepted criterion is satisfied.",
      verdict: "satisfied",
      findingCategory: "verification_incomplete",
      finding: "A broader benchmark would improve future confidence.",
      priority: "P2",
      recommendedDisposition: "backlog",
      findingOrigin: "backlog_candidate",
    }],
  }));

  expect(product.kind).toBe("task_review");
  if (product.kind !== "task_review") throw new Error("expected task review");
  expect(product.review.verdict).toBe("passed");
  expect(product.review.findings[0]).toMatchObject({
    priority: "P2",
    recommendedDisposition: "backlog",
    origin: { kind: "backlog_candidate" },
  });
});

test("Task Review freezes one root finding across several failed criteria", async () => {
  const criterionOne = ref("criterion");
  const criterionTwo = ref("criterion-two");
  const affectedCriterionRefs = [criterionOne, criterionTwo];
  const shared = {
    rootCauseKey: "shared-storage-boundary",
    affectedCriterionRefs,
    findingCategory: "implementation_nonconformance",
    finding: "One storage boundary defect violates both criteria.",
    priority: "P1",
    recommendedDisposition: "required_now",
    findingOrigin: "initial_review",
  };
  const product = await reviewTask(reviewInvocation([], {
    criteria: [{ ref: criterionOne }, { ref: criterionTwo }],
    verificationQuestions: [
      { ref: ref("question-one"), criterionRef: criterionOne },
      { ref: ref("question-two"), criterionRef: criterionTwo },
    ],
    criterionVerdicts: [
      {
        criterionRef: criterionOne,
        observation: "The first criterion exposes the shared defect.",
        verdict: "not_satisfied",
        ...shared,
      },
      {
        criterionRef: criterionTwo,
        observation: "The second criterion exposes the same shared defect.",
        verdict: "not_satisfied",
        ...shared,
      },
    ],
  }));

  if (product.kind !== "task_review") throw new Error("expected task review");
  if (product.review.verdict !== "not_passed") throw new Error("expected failed review");
  expect(product.review.findings).toHaveLength(1);
  expect(product.review.findingSet.findingRefs).toHaveLength(1);
  expect(product.review.findings[0]?.affectedCriterionRefs)
    .toEqual(expect.arrayContaining(affectedCriterionRefs));
});

test("Task re-review requires exact frozen root-cause coverage", async () => {
  const prior = priorFinding("finding-prior");
  const changed = reviewTask(reviewInvocation([], {
    priorCorrectionFindings: [prior],
    criterionVerdicts: [{
      criterionRef: ref("criterion"),
      observation: "The correction still does not satisfy the criterion.",
      verdict: "not_satisfied",
    }],
    priorFindingVerdicts: [{
      rootCauseKey: "another-root-cause",
      verdict: "unresolved",
      observation: "The original blocker remains.",
    }],
  }));

  await expect(changed).rejects.toThrow("provider_phase_submission_invalid");
});

test("Task correction regressions remain under the exact frozen root finding", async () => {
  const prior = priorFinding("finding-prior");
  const product = await reviewTask(reviewInvocation([], {
    priorCorrectionFindings: [prior],
    criterionVerdicts: [{
      criterionRef: ref("criterion"),
      observation: "The correction introduced a replacement regression.",
      verdict: "not_satisfied",
    }],
    priorFindingVerdicts: [{
      rootCauseKey: prior.rootCauseKey,
      verdict: "regressed",
      observation: "The attempted repair regressed the same frozen root cause.",
    }],
  }));

  expect(product.kind).toBe("task_review");
  if (product.kind !== "task_review") throw new Error("expected task review");
  expect(product.review.findings).toEqual([prior]);
});

test("workspace review diagnoses a criterion outside the current Task", async () => {
  const error = await reviewTask(reviewInvocation([], {
    criterionVerdicts: [{
      criterionRef: ref("another-task-criterion"),
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
    priorCorrectionFindings?: unknown[];
    priorFindingVerdicts?: unknown[];
  } = {},
): PhaseInvocation {
  const result = workspaceResult();
  if (result.result.kind !== "workspace_artifact") {
    throw new Error("expected workspace artifact result fixture");
  }
  return invocation("task_review", results, {
    resultCandidate: result,
    currentTask: { ref: result.result.taskRef },
    criteria: overrides.criteria ?? [{ ref: ref("criterion") }],
    verificationQuestions: overrides.verificationQuestions ?? [{
      ref: ref("verification-question"),
      criterionRef: ref("criterion"),
    }],
    reviewAuthorityRef: ref("authority"),
    reviewSourceRef: result.result.workspaceRevisionRef,
    ...(overrides.priorCorrectionFindings
      ? {
          priorCorrectionFindings: overrides.priorCorrectionFindings,
          correctionContext: correctionContextFor(
            overrides.priorCorrectionFindings,
          ),
        }
      : {}),
  }, normalizeTaskReviewRootFindings(
    overrides.criterionVerdicts,
    overrides.priorFindingVerdicts,
  ));
}

function correctionContextFor(findings: unknown[]) {
  const frozen = findings as Array<{ ref: ReturnType<typeof ref> }>;
  const findingDecisions = frozen.map((finding) => ({
    findingRef: finding.ref,
    decision: "apply_now",
    rationale: "Apply the frozen correction.",
  }));
  return {
    frozenFindings: findings,
    findingDecisions,
    correctionPlan: {
      findingDecisions,
    },
  };
}

function normalizeTaskReviewRootFindings(
  verdicts: unknown[] | undefined,
  priorFindingVerdicts: unknown[] | undefined,
): {
  criterionVerdicts: unknown[];
  findings: unknown[];
  priorFindingVerdicts?: unknown[];
} | undefined {
  if (!verdicts) return undefined;
  const findings = new Map<string, Record<string, unknown>>();
  const criterionVerdicts = verdicts.map((value) => {
    const verdict = value as Record<string, unknown>;
    if (!("finding" in verdict)) {
      return verdict;
    }
    const rootCauseKey = String(
      verdict.rootCauseKey ?? verdict.priorFindingId ?? verdict.finding,
    );
    findings.set(rootCauseKey, {
      rootCauseKey,
      affectedCriterionRefs: [verdict.criterionRef],
      findingCategory: verdict.findingCategory,
      finding: verdict.finding,
      priority: verdict.priority,
      scopeRelation: verdict.scopeRelation ?? "current_task",
      recommendedDisposition: verdict.recommendedDisposition,
      dispositionRationale: verdict.dispositionRationale ??
        "The submitted finding is evaluated against the current Task criterion.",
      findingOrigin: verdict.findingOrigin,
      ...("priorFindingId" in verdict
        ? { priorFindingId: verdict.priorFindingId }
        : {}),
      ...("affectedCriterionRefs" in verdict
        ? { affectedCriterionRefs: verdict.affectedCriterionRefs }
        : {}),
    });
    const {
      rootCauseKey: _rootCauseKey,
      affectedCriterionRefs: _affectedCriterionRefs,
      findingCategory: _findingCategory,
      finding: _finding,
      priority: _priority,
      scopeRelation: _scopeRelation,
      recommendedDisposition: _recommendedDisposition,
      dispositionRationale: _dispositionRationale,
      findingOrigin: _findingOrigin,
      priorFindingId: _priorFindingId,
      ...criterion
    } = verdict;
    return criterion;
  });
  return {
    criterionVerdicts,
    findings: [...findings.values()],
    ...(priorFindingVerdicts ? { priorFindingVerdicts } : {}),
  };
}

function invocation(
  semanticState: "task_execution" | "task_review",
  results: OperationResult[],
  stateInput: Record<string, unknown>,
  reviewSubmission?: {
    criterionVerdicts: unknown[];
    findings: unknown[];
    priorFindingVerdicts?: unknown[];
  },
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
              criterionVerdicts: reviewSubmission?.criterionVerdicts ?? [{
                criterionRef: ref("criterion"),
                observation: "the disposable validation passed",
                verdict: "satisfied",
              }],
              findings: reviewSubmission?.findings ?? [],
              ...(reviewSubmission?.priorFindingVerdicts
                ? { priorFindingVerdicts: reviewSubmission.priorFindingVerdicts }
                : {}),
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
      operationResultReadScopeRefs: ["result:operation-result:operation-result-sha"],
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
    publicTitle: "Test operation",
    kind: "review_validation" as const,
    capabilityRef: "test-runner",
    reviewSourceRef: ref("workspace-revision"),
    input: { command: "test" },
  };
}

function ref(id: string) {
  return { id, sha256: `${id}-sha` };
}

function priorFinding(id: string) {
  return {
    ref: ref(id),
    rootCauseKey: id,
    affectedCriterionRefs: [ref("criterion")],
    taskRef: ref("task"),
    attemptRef: ref("prior-attempt"),
    category: "implementation_nonconformance" as const,
    statement: "The implementation omits the required behavior.",
    priority: "P1" as const,
    scopeRelation: "current_task" as const,
    recommendedDisposition: "required_now" as const,
    dispositionRationale: "The accepted current Task criterion is materially unmet.",
    origin: { kind: "initial_review" as const },
    targetRevisionRefs: [],
  };
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
