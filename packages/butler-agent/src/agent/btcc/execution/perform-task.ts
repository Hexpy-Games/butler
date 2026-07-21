import {
  contentRef,
  requireLiteral,
  requireRecord,
  requireString,
  runPhaseConversation,
  type ContentRef,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type { ResultCandidateProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "task_execution",
  objective: "execute_the_exact_accepted_task_and_record_its_result",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "execute_accepted_task", "record_concrete_result",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_self_review",
  ],
};

const codec: PhaseCodec<ResultCandidateProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Task Execution state");
    const value = requireRecord(submission, "Task Execution submission");
    requireLiteral(value.kind, "result_candidate", "Task Execution kind");
    const goalContractRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
    const workRef = requireContentRef(state.workRef, "workRef");
    const taskRef = requireContentRef(state.taskRef, "taskRef");
    const attemptRef = requireContentRef(state.attemptRef, "attemptRef");
    const executionTargetRef = requireContentRef(state.executionTargetRef, "executionTargetRef");
    const observedBody = {
      attemptRef,
      executionTargetRef,
      state: "present" as const,
      description: requireString(value.observedState, "observedState"),
    };
    const observedState = {
      ref: contentRef("target-state-revision", observedBody), ...observedBody,
    };
    const resultBody = {
      goalContractRef, authorityRef, workRef, taskRef, attemptRef, executionTargetRef,
      resultSummary: requireString(value.resultSummary, "resultSummary"),
      observedState, artifactRevisionRefs: [] as [], effectReceiptRefs: [] as [],
    };
    return {
      kind: "result_candidate",
      result: { ref: contentRef("result-candidate", resultBody), ...resultBody },
    };
  },
};

export function performTask(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}
