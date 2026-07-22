import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceRevisionRef,
} from "./contracts.ts";

export function phaseGuidanceRevisionRef(
  guidance: AcceptedPhaseGuidance,
): PhaseGuidanceRevisionRef {
  return {
    guidanceId: guidance.guidanceId,
    phase: guidance.phase,
    scope: guidance.scope,
    revision: guidance.revision,
    contentSha256: guidance.contentSha256,
  };
}
