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
import type { PlanningCandidateProduct } from "./contracts.ts";

const CONTRACT: PhaseContract = {
  phase: "planning",
  objective: "author_the_smallest_complete_managed_work_graph",
  duties: [
    "preserve_original_goal", "preserve_selected_model", "state_input_only",
    "author_smallest_sufficient_plan", "apply_authoring_contracts",
    "bind_normative_goal_sets", "declare_work_task_dependencies",
    "declare_verification_integration", "declare_effects_risks_assumptions",
    "author_artifact_lifecycle", "candidate_revision_lineage",
  ],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_self_review",
  ],
  authoringContractRefs: [
    "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    "SPEC-BTCC-PLANNING-RECORD-CONTRACT",
    "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
  ],
};

const codec: PhaseCodec<PlanningCandidateProduct> = {
  decode(submission, envelope) {
    const state = requireRecord(envelope.context.stateInput, "Planning state");
    const goalRef = requireContentRef(state.goalContractRef, "goalContractRef");
    const authorityRef = requireContentRef(state.authorityRef, "authorityRef");
    const requiredOutcomeId = requireString(state.requiredOutcomeId, "requiredOutcomeId");
    const value = requireRecord(submission, "Planning submission");
    requireLiteral(value.kind, "plan_candidate", "Planning kind");
    const ledgerId = requireString(state.ledgerId, "ledgerId");
    const programId = requireString(state.programId, "programId");
    const criterionBody = {
      programId,
      statement: requireString(value.acceptanceCriterion, "acceptanceCriterion"),
      sourceGoalFieldIds: ["request", "intended_result"] as const,
      sourceRequiredOutcomeRefs: [requiredOutcomeId] as const,
    };
    const criterion = { ref: contentRef("acceptance-criterion", criterionBody), ...criterionBody };
    const questionBody = {
      criterionRef: criterion.ref,
      question: requireString(value.verificationQuestion, "verificationQuestion"),
    };
    const verificationQuestion = {
      ref: contentRef("verification-question", questionBody),
      ...questionBody,
    };
    const workId = contentRef("work-logical-id", { programId, ordinal: 1 }).id;
    const taskSeed = {
      programId, goalContractRef: goalRef, workId,
      intendedOutcome: requireString(value.taskOutcome, "taskOutcome"),
      executionOrdinal: 1 as const, artifactPolicy: "non_artifact" as const,
      criterionRef: criterion.ref, verificationQuestionRef: verificationQuestion.ref,
    };
    const taskRef = contentRef("task", taskSeed);
    const workBody = {
      workId, programId, goalContractRef: goalRef,
      outcome: requireString(value.workOutcome, "workOutcome"), taskRef,
    };
    const work = { ref: contentRef("work", workBody), ...workBody };
    const task = { ref: taskRef, ...taskSeed };
    const lifecycleBody = {
      programId, taskRef: task.ref, policy: "non_artifact" as const,
      promotionBindings: [] as [],
    };
    const artifactLifecycle = {
      ref: contentRef("artifact-lifecycle", lifecycleBody), ...lifecycleBody,
    };
    const planBody = {
      programId, goalContractRef: goalRef,
      strategy: requireString(value.strategy, "strategy"),
      workRef: work.ref, taskRef: task.ref, criterionRef: criterion.ref,
      verificationQuestionRef: verificationQuestion.ref,
      artifactLifecycleRef: artifactLifecycle.ref,
    };
    const plan = { ref: contentRef("work-plan", planBody), ...planBody };
    const recordRefs = [
      criterion.ref,
      verificationQuestion.ref,
      task.ref,
      work.ref,
      artifactLifecycle.ref,
      plan.ref,
    ] as const;
    const bundle = {
      ref: contentRef("planning-candidate-bundle", { ledgerId, programId, recordRefs }),
      recordRefs,
    };
    const candidateBody = {
      ledgerId, programId, goalContractRef: goalRef, authorityRef,
      plan, work, task, criterion, verificationQuestion, artifactLifecycle, bundle,
    };
    return {
      kind: "plan_candidate",
      candidate: { ref: contentRef("plan-candidate", candidateBody), ...candidateBody },
    };
  },
};

export function proposePlan(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return { id: requireString(record.id, `${label}.id`), sha256: requireString(record.sha256, `${label}.sha256`) };
}
