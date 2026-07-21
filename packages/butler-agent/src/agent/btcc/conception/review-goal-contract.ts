import {
  contentRef,
  digest,
  requireLiteral,
  requireRecord,
  runPhaseConversation,
  stableJson,
  type PhaseCodec,
  type PhaseContract,
  type PhaseInvocation,
} from "../core/index.ts";
import type {
  ConceptionLensId,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
} from "./managed-contracts.ts";
import type {
  ContinuationBinding,
  DeferredContinuationCandidate,
} from "../continuation/index.ts";

const CONTRACT: PhaseContract = {
  phase: "contract_review",
  objective: "independently_review_the_exact_goal_candidate",
  duties: ["preserve_selected_model", "state_input_only", "review_goal_contract_exactly"],
  prohibitions: [
    "no_successor_choice", "no_runtime_semantic_judgment", "no_model_substitution",
    "no_heuristic_route", "no_generic_evidence", "no_hidden_retry_loop",
    "no_mutation", "no_repair",
  ],
};

const codec: PhaseCodec<GoalContractAcceptedProduct> = {
  decode(submission, envelope) {
    const candidate = loadCandidate(envelope.context.stateInput);
    const value = requireRecord(submission, "Goal Contract Review submission");
    requireLiteral(value.kind, "goal_contract_review", "Goal Contract Review kind");
    requireLiteral(value.verdict, "accepted", "Goal Contract Review verdict");
    requireLiteral(value.strategy, "managed", "Goal Contract Review strategy");
    if (stableJson(value.candidateRef) !== stableJson(candidate.candidate.ref)) {
      throw new Error("Goal Contract Review did not review the exact candidate");
    }
    const reviewedLensIds = requireExactStringArray(value.reviewedLensIds, [
      "requested_content", "related_memory", "connected_current_knowledge",
      "user_preferences_and_resolution_style", "expert_perspective",
      "intended_result_and_acceptance",
    ], "reviewedLensIds") as ConceptionLensId[];
    const reviewedFieldIds = requireExactStringArray(
      value.reviewedFieldIds,
      ["request", "intended_result"],
      "reviewedFieldIds",
    ) as ["request", "intended_result"];
    const reviewedOutcomeIds = requireExactStringArray(
      value.reviewedOutcomeIds,
      [candidate.candidate.proposedContract.requiredOutcome.outcomeId],
      "reviewedOutcomeIds",
    ) as [string];
    const inboxId = requireStringState(envelope.context.stateInput, "inboxId");
    const sessionId = requireStringState(envelope.context.stateInput, "sessionId");
    const projectRef = optionalStringState(envelope.context.stateInput, "projectRef");
    const continuation = selectContinuation(
      value.continuationCandidateId,
      envelope.context.stateInput,
      inboxId,
    );
    const reviewBody = {
      candidateRef: candidate.candidate.ref,
      originalGoalContractRef: candidate.candidate.proposedContract.ref,
      reviewedLensIds,
      reviewedFieldIds,
      reviewedOutcomeIds,
      continuationBindingRef: continuation.ref,
      verdict: "accepted" as const,
    };
    const ledgerScope = projectRef
      ? { kind: "project" as const, projectRef }
      : { kind: "session" as const, sessionId };
    const defaultLedgerId = projectRef
      ? digest(`btcc-project-ledger.v1\0${projectRef}`)
      : digest(`btcc-session-ledger.v1\0${sessionId}`);
    const ledgerId = continuation.kind === "deferred_goal"
      ? continuation.ledgerId
      : defaultLedgerId;
    const programId = continuation.kind === "deferred_goal"
      ? continuation.programId
      : digest(
          `btcc-program.v1\0${ledgerId}\0${inboxId}\0${envelope.binding.turnId}\0${candidate.candidate.proposedContract.ref.sha256}`,
        );
    const authorityBody = {
      goalContractRef: candidate.candidate.proposedContract.ref,
      route: "managed" as const,
      ledgerScope,
      managedBinding: {
        ledgerId,
        programId,
        expectedManifestRevision: continuation.kind === "deferred_goal"
          ? continuation.expectedManifestRevision
          : 0,
        source: continuation.kind === "deferred_goal" ? "deferred_goal" as const : "new_program" as const,
        continuationBinding: continuation,
      },
    };
    return {
      kind: "goal_contract_accepted",
      review: { ref: contentRef("goal-review", reviewBody), ...reviewBody },
      goalContract: candidate.candidate.proposedContract,
      authority: { ref: contentRef("authority-revision", authorityBody), ...authorityBody },
    };
  },
};

export function reviewGoalContract(command: PhaseInvocation) {
  return runPhaseConversation({ ...command, phaseContract: CONTRACT, codec });
}

function selectContinuation(
  submittedCandidateId: unknown,
  input: unknown,
  inboxId: string,
): ContinuationBinding {
  const candidates = requireRecord(input, "Contract Review state input")
    .continuationCandidates;
  const available = Array.isArray(candidates)
    ? candidates as DeferredContinuationCandidate[]
    : [];
  if (submittedCandidateId === undefined || submittedCandidateId === null) {
    const body = { kind: "new_request" as const, inboxId };
    return { kind: "new_request", ref: contentRef("continuation-binding", body) };
  }
  if (typeof submittedCandidateId !== "string") {
    throw new Error("Continuation candidate id must be a string");
  }
  const candidate = available.find((item) => item.candidateId === submittedCandidateId);
  if (!candidate) throw new Error("Conception selected an unavailable continuation candidate");
  const body = {
    kind: "deferred_goal" as const,
    inboxId,
    ...candidate,
  };
  return {
    kind: "deferred_goal",
    ref: contentRef("continuation-binding", body),
    ...candidate,
  };
}

function requireExactStringArray(
  value: unknown,
  expected: string[],
  label: string,
): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a string array`);
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not cover the exact reviewed subjects`);
  }
  return value;
}

function loadCandidate(input: unknown): GoalContractCandidateProduct {
  const state = requireRecord(input, "Contract Review state input");
  const candidate = state.goalCandidate as GoalContractCandidateProduct | undefined;
  if (candidate?.kind !== "goal_contract_candidate") {
    throw new Error("Contract Review is missing its exact Goal candidate");
  }
  return candidate;
}

function requireStringState(input: unknown, key: string): string {
  const value = requireRecord(input, "Contract Review state input")[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Contract Review state input is missing ${key}`);
  }
  return value;
}

function optionalStringState(input: unknown, key: string): string | undefined {
  const value = requireRecord(input, "Contract Review state input")[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Contract Review state input has an invalid ${key}`);
  }
  return value;
}
