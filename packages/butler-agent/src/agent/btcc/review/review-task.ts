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
import type { TaskReviewProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "task_review",
  objective: "independently_compare_the_result_with_the_accepted_criterion",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "review_task_independently", "review_verification_integration",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec: PhaseCodec<TaskReviewProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Task Review state");
    const result = state.resultCandidate as ResultCandidateProduct | undefined;
    if (result?.kind !== "result_candidate") {
      throw new Error("Task Review is missing its exact ResultCandidate");
    }
    const criterionRef = requireContentRef(state.criterionRef, "criterionRef");
    const value = requireRecord(submission, "Task Review submission");
    if (value.kind !== "task_review" || (value.verdict !== "passed" && value.verdict !== "not_passed")) {
      throw new Error("Task Review submission has an invalid branch");
    }
    if (stableJson(value.resultCandidateRef) !== stableJson(result.result.ref)) {
      throw new Error("Task Review did not inspect the exact ResultCandidate");
    }
    const observationBody = {
      taskRef: result.result.taskRef,
      attemptRef: result.result.attemptRef,
      observedStateRef: result.result.observedState.ref,
      description: requireString(value.observation, "observation"),
    };
    const observation = { ref: contentRef("review-observation", observationBody), ...observationBody };
    const reviewBase = {
      goalContractRef: result.result.goalContractRef,
      authorityRef: result.result.authorityRef,
      resultCandidateRef: result.result.ref,
      taskRef: result.result.taskRef,
      attemptRef: result.result.attemptRef,
      criterionRef,
      observation,
    };
    if (value.verdict === "passed") {
      const body = { ...reviewBase, verdict: "passed" as const };
      return { kind: "task_review", review: { ref: contentRef("task-review", body), ...body } };
    }
    const findingBody = {
      taskRef: result.result.taskRef,
      attemptRef: result.result.attemptRef,
      category: "implementation_nonconformance" as const,
      statement: requireString(value.finding, "finding"),
    };
    const finding = { ref: contentRef("finding", findingBody), ...findingBody };
    const findingSetRef = contentRef("finding-set", { owner: "task_review", findingRefs: [finding.ref] });
    const correctionScopeRef = contentRef("correction-scope", {
      origin: "task_review", sourceTaskRef: result.result.taskRef,
      sourceAttemptRef: result.result.attemptRef, findingSetRef,
    });
    const body = {
      ...reviewBase, verdict: "not_passed" as const, findingSetRef,
      correctionScopeRef, finding,
    };
    return { kind: "task_review", review: { ref: contentRef("task-review", body), ...body } };
  },
};

export function reviewTask(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}
