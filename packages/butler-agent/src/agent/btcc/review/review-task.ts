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
  ReviewFindingCategory,
  ReviewObservation,
  TaskReviewProduct,
} from "./contracts.ts";
import { withManagedDeferral } from "../deferral/index.ts";
import { taskReviewSubmissionSchema } from "./submission-schema.ts";

const CONTRACT: PhaseContract = {
  phase: "task_review",
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

const semanticReviewCodec: PhaseCodec<TaskReviewProduct> = {
  submissionSchema: taskReviewSubmissionSchema("semantic"),
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
      criteria,
      questions,
      result,
      checkpointId: envelope.binding.checkpointId,
      reviewOperationRefs: envelope.operationResults.map((operation) => operation.resultRef),
    });
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
      findings: decoded.findings,
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
    const findingRefs = decoded.findings.map((finding) => finding.ref);
    const findingSetRef = contentRef("finding-set", { owner: "task_review", findingRefs });
    const correctionScopeRef = contentRef("correction-scope", {
      origin: "task_review",
      sourceTaskRef: result.result.taskRef,
      sourceAttemptRef: result.result.attemptRef,
      findingSetRef,
    });
    const body = {
      ...reviewBase,
      verdict: "not_passed" as const,
      findingSetRef,
      correctionScopeRef,
    };
    return { kind: "task_review", review: { ref: contentRef("task-review", body), ...body } };
  },
};

const codec = withManagedDeferral(semanticReviewCodec);

const promotionCodec = {
  ...semanticReviewCodec,
  submissionSchema: taskReviewSubmissionSchema("promotion_identity"),
};

export function reviewTask(command: PhaseInvocation) {
  const state = requireRecord(command.context.stateInput, "Task Review state");
  const result = state.resultCandidate as ResultCandidateProduct | undefined;
  if (result?.kind !== "result_candidate") {
    throw new Error("Task Review is missing its exact ResultCandidate");
  }
  return runPhaseConversation({
    ...command,
    phaseContract: CONTRACT,
    codec: result.result.kind === "repository_promotion" ? promotionCodec : codec,
  });
}

function decodeCriterionVerdicts(input: {
  submitted: unknown;
  criteria: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  result: ResultCandidateProduct;
  checkpointId: string;
  reviewOperationRefs: ContentRef[];
}): {
  verdicts: CriterionVerdict[];
  observations: ReviewObservation[];
  findings: ReviewFinding[];
} {
  if (!Array.isArray(input.submitted) || input.submitted.length !== input.criteria.length) {
    throw new Error("Task Review must judge every accepted criterion exactly once");
  }
  const criteria = new Map(input.criteria.map((criterion) => {
    const ref = requireContentRef(criterion.ref, "criterion.ref");
    return [refKey(ref), { criterion, ref }];
  }));
  const allowedResultRefs = new Map([
    input.result.result.resultSummary.ref,
    ...input.result.result.operationResults.map((result) => result.resultRef),
    ...input.reviewOperationRefs,
  ].map((ref) => [refKey(ref), ref]));
  const reviewedCriteria = new Set<string>();
  const observations: ReviewObservation[] = [];
  const findings: ReviewFinding[] = [];
  const targetRevisionRefs = input.result.result.targetStateRevisions.map((item) => item.ref);
  const verdicts = input.submitted.map((item, index) => {
    const submitted = requireRecord(item, `criterionVerdicts[${index}]`);
    const criterionRef = requireContentRef(
      submitted.criterionRef,
      `criterionVerdicts[${index}].criterionRef`,
    );
    const criterionKey = refKey(criterionRef);
    if (!criteria.has(criterionKey) || reviewedCriteria.has(criterionKey)) {
      throw new Error("Task Review changed or repeated an accepted criterion");
    }
    reviewedCriteria.add(criterionKey);
    const reviewedResultRefs = requireContentRefs(
      submitted.reviewedResultRefs,
      `criterionVerdicts[${index}].reviewedResultRefs`,
    );
    if (reviewedResultRefs.some((ref) => !allowedResultRefs.has(refKey(ref)))) {
      throw new Error("Task Review cited a result outside the current Execution or Review");
    }
    const questionRefs = input.questions
      .filter((question) => stableJson(question.criterionRef) === stableJson(criterionRef))
      .map((question) => requireContentRef(question.ref, "question.ref"));
    if (submitted.verdict !== "satisfied" && submitted.verdict !== "not_satisfied") {
      throw new Error("Task Review criterion verdict is invalid");
    }
    const criterionVerdict = submitted.verdict as "satisfied" | "not_satisfied";
    const observationBody = {
      taskRef: input.result.result.taskRef,
      attemptRef: input.result.result.attemptRef,
      executionTargetRef: input.result.result.executionTargetRef,
      targetRevisionRefs,
      description: requireString(submitted.observation, "criterion observation"),
      reviewedResultRefs,
      reviewCheckpointRef: input.checkpointId,
    };
    const observation = {
      ref: contentRef("review-observation", observationBody), ...observationBody,
    };
    observations.push(observation);
    const findingRefs: ContentRef[] = [];
    if (criterionVerdict === "not_satisfied") {
      const category = requireFindingCategory(submitted.findingCategory);
      const findingBody = {
        taskRef: input.result.result.taskRef,
        attemptRef: input.result.result.attemptRef,
        category,
        statement: requireString(submitted.finding, "criterion finding"),
        targetRevisionRefs,
      };
      const finding = { ref: contentRef("finding", findingBody), ...findingBody };
      findings.push(finding);
      findingRefs.push(finding.ref);
    }
    return {
      criterionRef,
      verificationQuestionRefs: questionRefs,
      currentTargetRevisionRefs: targetRevisionRefs,
      reviewedResultRefs,
      observationRefs: [observation.ref],
      verdict: criterionVerdict,
      findingRefs,
    };
  });
  if (reviewedCriteria.size !== criteria.size) {
    throw new Error("Task Review did not cover every accepted criterion");
  }
  return { verdicts, observations, findings };
}

function requireFindingCategory(value: unknown): ReviewFindingCategory {
  const allowed: ReviewFindingCategory[] = [
    "implementation_nonconformance", "authority_contradiction", "goal_drift",
    "task_decomposition", "dependency_invalid", "verification_incomplete",
    "missing_observation",
  ];
  if (typeof value !== "string" || !allowed.includes(value as ReviewFindingCategory)) {
    throw new Error("Task Review finding category is invalid");
  }
  return value as ReviewFindingCategory;
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

function requireContentRefs(value: unknown, label: string): ContentRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty reference array`);
  }
  return value.map((item, index) => requireContentRef(item, `${label}[${index}]`));
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
