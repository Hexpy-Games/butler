import type { AcceptedPhaseGuidance } from "../../btcc/guidance/index.ts";
import type {
  BtccRetrospective,
  BtccTrajectory,
  RetrospectiveDecisionSet,
  RetrospectiveModelRunner,
  RetrospectiveModelRunnerResult,
} from "./contracts.ts";
import { decodeDecisionSet } from "./decode-model-output.ts";
import { normalizeModelResult } from "./model.ts";

export async function consolidateCandidates(input: {
  trajectory: BtccTrajectory;
  retrospective: BtccRetrospective;
  acceptedGuidance: AcceptedPhaseGuidance[];
  butlerData: string;
  modelRunner: RetrospectiveModelRunner;
  cacheScopePrefix: string;
}): Promise<{ value: RetrospectiveDecisionSet; model?: RetrospectiveModelRunnerResult }> {
  if (input.retrospective.candidates.length === 0) {
    return { value: { sourceId: input.trajectory.sourceId, decisions: [] } };
  }
  const model = normalizeModelResult(await input.modelRunner({
    kind: "consolidate",
    instructions: [
      "Consolidate proposed BTCC phase guidance against existing accepted guidance, explicit feedback, scope, risk, confidence, and counterexamples.",
      "Only phase-local prompt guidance may be promoted. Structural changes must be outside_learning_surface.",
      "Return exactly one decision for every candidate as JSON only.",
    ].join(" "),
    prompt: JSON.stringify({
      task: "consolidate_btcc_phase_guidance",
      originalRequest: input.trajectory.originalRequest,
      recentFeedback: input.trajectory.recentFeedback,
      candidates: input.retrospective.candidates,
      existingAcceptedGuidance: input.acceptedGuidance,
      dispositions: [
        "promote", "merge", "supersede", "defer", "reject", "outside_learning_surface",
      ],
      output: {
        decisions: [{
          candidateId: "exact candidate id",
          disposition: "one supplied disposition",
          guidanceId: "stable accepted guidance id",
          rationale: "string",
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
  return { value, model };
}
