import type { AcceptedPhaseGuidance } from "../../btcc/guidance/index.ts";
import type {
  BtccRetrospective,
  BtccTrajectory,
  RetrospectiveDecisionSet,
  RetrospectiveModelRunner,
  RetrospectiveModelRunnerResult,
} from "./contracts.ts";
import { GUIDANCE_DECISION_CONTRACT_REVISION } from "./contracts.ts";
import { decodeDecisionSet } from "./decode-model-output.ts";
import { GUIDANCE_SCOPE_RULES } from "./evaluation-rubric.ts";
import { normalizeModelResult } from "./model.ts";
import { trajectorySourceRefs } from "./source-reference-index.ts";
import { validateGuidanceDecisions } from "./validate-guidance-decisions.ts";

export async function consolidateCandidates(input: {
  trajectory: BtccTrajectory;
  retrospective: BtccRetrospective;
  acceptedGuidance: AcceptedPhaseGuidance[];
  butlerData: string;
  modelRunner: RetrospectiveModelRunner;
  cacheScopePrefix: string;
}): Promise<{ value: RetrospectiveDecisionSet; model?: RetrospectiveModelRunnerResult }> {
  if (input.retrospective.candidates.length === 0) {
    return {
      value: {
        sourceId: input.trajectory.sourceId,
        contractRevision: GUIDANCE_DECISION_CONTRACT_REVISION,
        decisions: [],
      },
    };
  }
  const model = normalizeModelResult(await input.modelRunner({
    kind: "consolidate",
    instructions: [
      "Consolidate proposed BTCC phase guidance against existing accepted guidance, explicit feedback, scope, risk, confidence, and counterexamples.",
      "Correct an unsafe scope or rewrite guidance when needed; accepted decisions must contain the exact final guidance and reviewed scope that will be published.",
      "Use promote only for a new stable guidance ID in the accepted phase and scope. Merge and supersede must target one exact supplied active revision without changing its ID, phase, or scope.",
      "Return the reviewed final appliesWhen and doesNotApplyWhen conditions; never rely on candidate conditions being copied implicitly.",
      "Only phase-local prompt guidance may be promoted. Structural changes must be outside_learning_surface.",
      "Return exactly one decision for every candidate as JSON only.",
    ].join(" "),
    prompt: JSON.stringify({
      task: "consolidate_btcc_phase_guidance",
      originalRequest: input.trajectory.originalRequest,
      recentFeedback: input.trajectory.recentFeedback,
      guidanceScopeRules: GUIDANCE_SCOPE_RULES,
      allowedSourceRefs: [...trajectorySourceRefs(input.trajectory)],
      candidates: input.retrospective.candidates,
      existingAcceptedGuidance: input.acceptedGuidance,
      dispositions: [
        "promote", "merge", "supersede", "defer", "reject", "outside_learning_surface",
      ],
      output: {
        contractRevision: GUIDANCE_DECISION_CONTRACT_REVISION,
        decisions: [{
          candidateId: "exact candidate id",
          disposition: "one supplied disposition",
          guidanceId: "stable accepted guidance id",
          rationale: "string",
          acceptedScopeKind:
            "required for promote|merge|supersede: user|project|session|global",
          acceptedScopeRationale: "required for promote|merge|supersede",
          acceptedScopeSourceRefs: ["required exact allowed source ref"],
          acceptedGeneralityBoundary:
            "required: cross_project_user_preference|project_bound_strategy|session_bound_strategy|global_phase_practice",
          acceptedGuidance: "required final publishable guidance bytes",
          acceptedAppliesWhen: ["reviewed final applicability condition"],
          acceptedDoesNotApplyWhen: ["reviewed final exclusion condition"],
          targetRevision: {
            requiredFor: "merge|supersede only; exact existingAcceptedGuidance revision",
            guidanceId: "string",
            phase: "BTCC model phase",
            scope: "exact user, project, session, or global scope object",
            revision: "positive integer",
            contentSha256: "exact content hash",
          },
        }],
      },
    }),
    cacheScope: `${input.cacheScopePrefix}:${input.trajectory.sourceId}:consolidate`,
    butlerData: input.butlerData,
  }));
  const value = decodeDecisionSet(model.text, input.trajectory.sourceId);
  const expected = new Set(input.retrospective.candidates.map(({ candidateId }) => candidateId));
  if (value.decisions.length !== expected.size ||
    value.decisions.some(({ candidateId }) => !expected.delete(candidateId))) {
    throw new Error("Guidance decisions do not cover the exact candidate set");
  }
  validateGuidanceDecisions({
    decisions: value,
    trajectory: input.trajectory,
    candidates: input.retrospective.candidates,
    acceptedGuidance: input.acceptedGuidance,
  });
  return { value, model };
}
