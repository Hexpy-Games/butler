import type {
  M1V2ArmId,
  M1V2RepetitionResult,
} from "./m1-v2-types.ts";

export function applyM1V2StabilityReasons(
  armId: M1V2ArmId,
  work: M1V2RepetitionResult["work"],
  reasons: string[],
): void {
  if (work.duplicateEvidenceCount === null) {
    reasons.push("duplicate_effect_evidence_unavailable");
  } else if (work.duplicateEvidenceCount > 0) reasons.push("duplicate_effect_detected");
  if (work.lostCorrectionEvidenceCount === null) {
    reasons.push("correction_evidence_unavailable");
  } else if (work.lostCorrectionEvidenceCount > 0) reasons.push("lost_correction_detected");
  if (work.lostRequiredAnchorCount === null) {
    reasons.push("required_anchor_evidence_unavailable");
  } else if (work.lostRequiredAnchorCount > 0) reasons.push("lost_required_anchor_detected");
  if (work.workspaceAuthorityPassed === null) {
    reasons.push("workspace_authority_evidence_unavailable");
  } else if (!work.workspaceAuthorityPassed) reasons.push("workspace_authority_violation");
  if (work.providerRoutingPassed === null) {
    reasons.push("provider_routing_evidence_unavailable");
  } else if (!work.providerRoutingPassed) reasons.push("provider_routing_violation");
  if (work.stallObserved === null) reasons.push("work_stall_evidence_unavailable");
  else if (work.stallObserved) reasons.push("work_stall_detected");
  if (armId !== "landing-cold") return;
  if (!work.observed || work.status !== "completed") reasons.push("landing_durable_work_missing");
  if (work.planReviewVerdict !== "accept") reasons.push("landing_plan_review_missing");
  if (work.resultReviewVerdict !== "accept") reasons.push("landing_result_review_missing");
  if (work.completionValidationVerdict !== "accept") {
    reasons.push("landing_completion_validation_missing");
  }
}
