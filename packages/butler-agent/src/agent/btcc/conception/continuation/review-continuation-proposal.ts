import {
  contentRef,
  requireLiteral,
  requireRecord,
} from "../../core/index.ts";
import type {
  ContinuationBinding,
  ContinuationCandidate,
} from "../../continuation/index.ts";

export type ReviewedContinuationDecision =
  | { kind: "new_request" }
  | { kind: "bind"; continuationCandidateId: string }
  | {
      kind: "reject";
      continuationCandidateId: string;
      rationale: string;
    };

export function decideContinuation(
  submittedDecision: unknown,
  stateInput: unknown,
  inboxId: string,
  proposedCandidateId?: string,
): {
  binding: ContinuationBinding;
  reviewDecision: ReviewedContinuationDecision;
} {
  if (!proposedCandidateId) {
    if (submittedDecision !== undefined) {
      throw new Error("Goal Review cannot decide an unproposed continuation");
    }
    return newRequestContinuation(inboxId);
  }
  const decision = requireRecord(submittedDecision, "Continuation review decision");
  if (decision.continuationCandidateId !== proposedCandidateId) {
    throw new Error("Goal Review must decide the exact Opening continuation proposal");
  }
  if (decision.kind === "reject") {
    const rationale = typeof decision.rationale === "string" ? decision.rationale : "";
    if (!rationale) throw new Error("Continuation rejection requires a rationale");
    return {
      ...newRequestContinuation(inboxId),
      reviewDecision: {
        kind: "reject",
        continuationCandidateId: proposedCandidateId,
        rationale,
      },
    };
  }
  requireLiteral(decision.kind, "bind", "Continuation review decision kind");
  return bindProposedContinuation(stateInput, inboxId, proposedCandidateId);
}

export function openingContinuationProposalId(
  state: Record<string, unknown>,
): string | undefined {
  const opening = state.opening;
  if (!opening || typeof opening !== "object" || Array.isArray(opening)) return undefined;
  const proposal = (opening as Record<string, unknown>).continuationProposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return undefined;
  const candidateId = (proposal as Record<string, unknown>).candidateId;
  if (typeof candidateId !== "string" || candidateId.length === 0) {
    throw new Error("Opening continuation proposal has an invalid candidate id");
  }
  return candidateId;
}

function bindProposedContinuation(
  stateInput: unknown,
  inboxId: string,
  proposedCandidateId: string,
) {
  const candidates = requireRecord(stateInput, "Contract Review state input")
    .continuationCandidates;
  const available = Array.isArray(candidates)
    ? candidates as ContinuationCandidate[]
    : [];
  const candidate = available.find((item) => item.candidateId === proposedCandidateId);
  if (!candidate) throw new Error("Conception selected an unavailable continuation candidate");
  if (candidate.continuationKind === "managed_finalization") {
    if (!candidate.context?.finalization) {
      throw new Error("Finalization continuation is missing its resume state");
    }
    const context = {
      ...candidate.context,
      finalization: candidate.context.finalization,
    };
    const kind = "stopped_finalization" as const;
    const body = { kind, inboxId, ...candidate, context };
    return {
      binding: {
        kind,
        inboxId,
        ref: contentRef("continuation-binding", body),
        ...candidate,
        context,
      },
      reviewDecision: {
        kind: "bind" as const,
        continuationCandidateId: proposedCandidateId,
      },
    };
  }
  const kind = candidate.continuationKind === "user_stopped"
    ? "stopped_program" as const
    : "deferred_goal" as const;
  const body = { kind, inboxId, ...candidate };
  return {
    binding: {
      kind,
      inboxId,
      ref: contentRef("continuation-binding", body),
      ...candidate,
    },
    reviewDecision: {
      kind: "bind" as const,
      continuationCandidateId: proposedCandidateId,
    },
  };
}

function newRequestContinuation(inboxId: string) {
  const body = { kind: "new_request" as const, inboxId };
  return {
    binding: {
      kind: "new_request" as const,
      inboxId,
      ref: contentRef("continuation-binding", body),
    },
    reviewDecision: { kind: "new_request" as const },
  };
}
