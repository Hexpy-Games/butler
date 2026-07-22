import { contentRef } from "../../core/index.ts";
import type { PlanningProposal } from "../contracts.ts";
import { authorPlanCandidate, type AuthoringState } from "./author-plan-candidate.ts";
import { PlanningProposalDefect } from "./planning-proposal-defect.ts";

export function authorPlanningProposal(
  submission: Record<string, unknown>,
  state: AuthoringState,
): PlanningProposal {
  try {
    return authorPlanCandidate(submission, state);
  } catch (error) {
    if (!(error instanceof PlanningProposalDefect)) throw error;
    const body = {
      kind: "planning_draft" as const,
      ledgerId: state.ledgerId,
      programId: state.programId,
      observedManifestRevision: state.observedManifestRevision,
      goalContractRef: state.goalContractRef,
      authorityRef: state.authorityRef,
      governingSpecRefs: state.governingSpecRefs,
      submission,
      validationFindings: [{ code: error.code, message: error.message }],
    };
    return { ref: contentRef("planning-draft", body), ...body };
  }
}
