import {
  contentRef,
  requireRecord,
  runPhaseConversation,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type { ReviewFinding, TaskReviewProduct } from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import {
  normalizeRootFindings,
  requirePriorFindings,
  validateCorrectionFindingScope,
} from "./review-findings.ts";
import { taskReviewSubmissionSchema } from "./submission-schema.ts";
import {
  decodeCriterionVerdicts,
  requireContentRef,
  requireRecords,
  sameContentRef,
  uniqueRefs,
} from "./criterion-verdicts.ts";

const CONTRACT: PhaseContract = {
  phase: "task_review",
  operationSurface: "authorized",
  objective: "independently_compare_every_task_criterion_with_current_targets",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_task_independently", "author_managed_deferral",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_assurance_layer", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

function semanticReviewCodec(
  priorFindings: ReviewFinding[],
): PhaseCodec<TaskReviewProduct> {
  return {
  submissionSchema: taskReviewSubmissionSchema(
    "semantic",
    priorFindings.map((finding) => finding.rootCauseKey),
  ),
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Task Review state");
    const result = state.resultCandidate as ResultCandidateProduct | undefined;
    if (result?.kind !== "result_candidate") {
      throw new Error("Task Review is missing its exact ResultCandidate");
    }
    const criteria = requireRecords(state.criteria, "criteria");
    const questions = requireRecords(state.verificationQuestions, "verificationQuestions");
    if (priorFindings.length > 0) {
      requireCorrectionContext(state.correctionContext, priorFindings);
    }
    const value = requireRecord(submission, "Task Review submission");
    if (value.kind !== "task_review") throw new Error("Task Review submission has an invalid kind");
    const decoded = decodeCriterionVerdicts({
      submitted: value.criterionVerdicts,
      submittedFindings: value.findings,
      submittedPriorFindingVerdicts: value.priorFindingVerdicts,
      criteria,
      questions,
      result,
      checkpointId: envelope.binding.checkpointId,
      runtimeBoundResultRefs: uniqueRefs([
        result.result.resultSummary.ref,
        ...envelope.operationResults.map((operation) => operation.resultRef),
      ]),
      priorFindings,
    });
      const orderedFindings = normalizeRootFindings(
        decoded.findings,
        decoded.verdicts,
      );
      validateCorrectionFindingScope(orderedFindings, priorFindings);
    const passed = decoded.verdicts.every((verdict) => verdict.verdict === "satisfied");
    if (result.result.kind === "repository_promotion" && !passed) {
      throw new Error("Promotion Review is identity-only and cannot fail semantically");
    }
    const validationReceiptRefs = envelope.operationResults
      .filter((operation) =>
        operation.outcome === "review_validated" &&
        operation.request.kind === "review_validation" &&
        result.result.kind === "workspace_artifact" &&
        sameContentRef(
          operation.request.reviewSourceRef,
          result.result.workspaceRevisionRef,
        ))
      .map((operation, index) => requireContentRef(
        operation.validationReceiptRef,
        `validationReceiptRef[${index}]`,
      ));
    if (
      result.result.kind === "workspace_artifact" &&
      passed &&
      validationReceiptRefs.length === 0
    ) {
      throw new Error(
        "Workspace artifact Review requires successful disposable validation before passing",
      );
    }
    const reviewBase = {
      kind: result.result.kind,
      turnId: envelope.binding.turnId,
      goalContractRef: result.result.goalContractRef,
      authorityRef: requireContentRef(state.reviewAuthorityRef, "reviewAuthorityRef"),
      resultAuthorityRef: result.result.authorityRef,
      resultCandidateRef: result.result.ref,
      workRef: result.result.workRef,
      taskRef: result.result.taskRef,
      taskRevisionSha256: result.result.taskRevisionSha256,
      attemptRef: result.result.attemptRef,
      executionTargetRef: result.result.executionTargetRef,
      reviewCheckpointRef: envelope.binding.checkpointId,
      criterionVerdicts: decoded.verdicts,
      observations: decoded.observations,
      findings: orderedFindings,
      findingVerdicts: decoded.findingVerdicts,
      reviewedResultRefs: uniqueRefs(
        decoded.verdicts.flatMap((verdict) => verdict.reviewedResultRefs),
      ),
      reviewedTargetStateRevisionRefs: result.result.targetStateRevisions.map((item) => item.ref),
      reviewedArtifactRevisionRefs: result.result.artifactRevisionRefs,
      reviewedEffectReceiptRefs: [] as [],
      reviewValidationReceiptSetRefs: validationReceiptRefs,
      ...(result.result.kind === "workspace_artifact"
        ? { reviewSourceRef: result.result.workspaceRevisionRef }
        : result.result.kind === "repository_promotion"
          ? { reviewSourceRef: result.result.promotedSnapshotRef }
          : {}),
    };
    if (passed) {
      const body = { ...reviewBase, verdict: "passed" as const };
      return { kind: "task_review", review: { ref: contentRef("task-review", body), ...body } };
    }
    const findingRefs = orderedFindings
      .filter((finding) => finding.recommendedDisposition === "required_now")
      .map((finding) => finding.ref);
    const findingSetBody = { owner: "task_review" as const, findingRefs };
    const findingSetRef = contentRef("finding-set", findingSetBody);
    const correctionScopeBody = {
      origin: "task_review" as const,
      sourceTaskRef: result.result.taskRef,
      sourceAttemptRef: result.result.attemptRef,
      findingSetRef,
    };
    const correctionScopeRef = contentRef("correction-scope", correctionScopeBody);
    const body = {
      ...reviewBase,
      verdict: "not_passed" as const,
      findingSetRef,
      findingSet: { ref: findingSetRef, ...findingSetBody },
      correctionScopeRef,
      correctionScope: { ref: correctionScopeRef, ...correctionScopeBody },
    };
    return { kind: "task_review", review: { ref: contentRef("task-review", body), ...body } };
  },
};
}

function requireCorrectionContext(
  value: unknown,
  priorFindings: ReviewFinding[],
): void {
  const context = requireRecord(value, "Task re-review correctionContext");
  if (!Array.isArray(context.frozenFindings)) {
    throw new Error("Task re-review is missing its frozen FindingSet");
  }
  const frozen = context.frozenFindings as ReviewFinding[];
  const expected = new Set(priorFindings.map((finding) => finding.ref.id));
  if (
    frozen.length !== priorFindings.length ||
    frozen.some((finding) => !expected.has(finding.ref.id))
  ) {
    throw new Error("Task re-review frozen FindingSet changed");
  }
  if (!Array.isArray(context.findingDecisions)) {
    throw new Error("Task re-review is missing its finding decisions");
  }
  const decisions = context.findingDecisions.map((item, index) => {
    const decision = requireRecord(item, `Task re-review findingDecision[${index}]`);
    return requireContentRef(decision.findingRef, `findingDecision[${index}].findingRef`);
  });
  if (
    decisions.length !== priorFindings.length ||
    new Set(decisions.map((ref) => ref.id)).size !== decisions.length ||
    decisions.some((ref) => !expected.has(ref.id))
  ) {
    throw new Error("Task re-review finding decisions changed");
  }
  const plan = requireRecord(context.correctionPlan, "Task re-review CorrectionPlan");
  if (!Array.isArray(plan.findingDecisions) ||
    plan.findingDecisions.length !== decisions.length) {
    throw new Error("Task re-review CorrectionPlan omitted finding decisions");
  }
}

function promotionCodec() {
  return {
  ...semanticReviewCodec([]),
  submissionSchema: taskReviewSubmissionSchema("promotion_identity"),
};
}

export function reviewTask(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Task Review state");
  const result = state.resultCandidate as ResultCandidateProduct | undefined;
  if (result?.kind !== "result_candidate") {
    throw new Error("Task Review is missing its exact ResultCandidate");
  }
  const priorFindings = requirePriorFindings(state.priorCorrectionFindings);
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: result.result.kind === "repository_promotion"
      ? promotionCodec()
      : withManagedDeferral(semanticReviewCodec(priorFindings)),
  });
}
