import {
  contentRef,
  requireRecord,
  requireString,
  runPhaseConversation,
  stableJson,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  CriterionVerdict,
  ReviewFinding,
  ReviewObservation,
  TaskReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import {
  decodeReviewFindings,
  normalizeRootFindings,
  requirePriorFindings,
  validateCorrectionFindingScope,
} from "./review-findings.ts";
import { taskReviewSubmissionSchema } from "./submission-schema.ts";

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
    priorFindings.map((finding) => finding.ref.id),
  ),
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Task Review state");
    const result = state.resultCandidate as ResultCandidateProduct | undefined;
    if (result?.kind !== "result_candidate") {
      throw new Error("Task Review is missing its exact ResultCandidate");
    }
    const criteria = requireRecords(state.criteria, "criteria");
    const questions = requireRecords(state.verificationQuestions, "verificationQuestions");
    const value = requireRecord(submission, "Task Review submission");
    if (value.kind !== "task_review") throw new Error("Task Review submission has an invalid kind");
    const decoded = decodeCriterionVerdicts({
      submitted: value.criterionVerdicts,
      submittedFindings: value.findings,
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

function decodeCriterionVerdicts(input: {
  submitted: unknown;
  submittedFindings: unknown;
  criteria: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  result: ResultCandidateProduct;
  checkpointId: string;
  runtimeBoundResultRefs: ContentRef[];
  priorFindings: ReviewFinding[];
}): {
  verdicts: CriterionVerdict[];
  observations: ReviewObservation[];
  findings: ReviewFinding[];
} {
  if (!Array.isArray(input.submitted) || input.submitted.length !== input.criteria.length) {
    throw new Error(
      "Task Review must submit exactly one verdict for each stateInput.criteria entry",
    );
  }
  const criteria = new Map(input.criteria.map((criterion) => {
    const ref = requireContentRef(criterion.ref, "criterion.ref");
    return [refKey(ref), { criterion, ref }];
  }));
  const reviewedCriteria = new Set<string>();
  const observations: ReviewObservation[] = [];
  const targetRevisionRefs = input.result.result.targetStateRevisions.map((item) => item.ref);
  const findings = decodeReviewFindings({
    submitted: input.submittedFindings,
    criterionRefs: [...criteria.values()].map((item) => item.ref),
    taskRef: input.result.result.taskRef,
    attemptRef: input.result.result.attemptRef,
    targetRevisionRefs,
    priorFindings: input.priorFindings,
  });
  const findingByRootCause = new Map(
    findings.map((finding) => [finding.rootCauseKey, finding]),
  );
  const verdicts = input.submitted.map((item, index) => {
    const submitted = requireRecord(item, `criterionVerdicts[${index}]`);
    const criterionRef = requireContentRef(
      submitted.criterionRef,
      `criterionVerdicts[${index}].criterionRef`,
    );
    const criterionKey = refKey(criterionRef);
    if (!criteria.has(criterionKey)) {
      throw new Error("Task Review submitted a criterion outside stateInput.criteria");
    }
    if (reviewedCriteria.has(criterionKey)) {
      throw new Error("Task Review repeated a current Task criterion");
    }
    reviewedCriteria.add(criterionKey);
    const questionRefs = input.questions
      .filter((question) => stableJson(question.criterionRef) === stableJson(criterionRef))
      .map((question) => requireContentRef(question.ref, "question.ref"));
    if (submitted.verdict !== "satisfied" && submitted.verdict !== "not_satisfied") {
      throw new Error("Task Review criterion verdict is invalid");
    }
    const criterionVerdict = submitted.verdict as "satisfied" | "not_satisfied";
    const findingRootCauseKeys = requireFindingRootCauseKeys(
      submitted.findingRootCauseKeys,
      findingByRootCause,
    );
    const criterionFindings = findingRootCauseKeys
      .map((rootCauseKey) => findingByRootCause.get(rootCauseKey)!);
    const hasBlockingFinding = criterionFindings.some(
      (finding) => finding.recommendedDisposition === "required_now",
    );
    if ((criterionVerdict === "not_satisfied") !== hasBlockingFinding) {
      throw new Error("Task Review criterion verdict conflicts with required-now findings");
    }
    const observationBody = {
      taskRef: input.result.result.taskRef,
      attemptRef: input.result.result.attemptRef,
      executionTargetRef: input.result.result.executionTargetRef,
      targetRevisionRefs,
      description: requireString(submitted.observation, "criterion observation"),
      reviewedResultRefs: input.runtimeBoundResultRefs,
      reviewCheckpointRef: input.checkpointId,
    };
    const observation = {
      ref: contentRef("review-observation", observationBody), ...observationBody,
    };
    observations.push(observation);
    return {
      criterionRef,
      verificationQuestionRefs: questionRefs,
      currentTargetRevisionRefs: targetRevisionRefs,
      reviewedResultRefs: input.runtimeBoundResultRefs,
      observationRefs: [observation.ref],
      verdict: criterionVerdict,
      findingRefs: criterionFindings.map((finding) => finding.ref),
    };
  });
  if (reviewedCriteria.size !== criteria.size) {
    throw new Error("Task Review did not cover every accepted criterion");
  }
  return { verdicts, observations, findings };
}

function requireFindingRootCauseKeys(
  value: unknown,
  findings: Map<string, ReviewFinding>,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Task Review criterion findingRootCauseKeys must be an array");
  }
  const keys = value.map((item) =>
    requireString(item, "Task Review criterion root cause key"));
  if (
    new Set(keys).size !== keys.length ||
    keys.some((rootCauseKey) => !findings.has(rootCauseKey))
  ) {
    throw new Error("Task Review criterion root cause refs must be exact and unique");
  }
  return keys;
}

function requireRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is empty`);
  return value.map((item, index) => requireRecord(item, `${label}[${index}]`));
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}

function uniqueRefs(refs: ContentRef[]): ContentRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
