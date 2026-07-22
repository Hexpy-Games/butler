import type {
  BtccRetrospective,
  BtccTrajectory,
  RetrospectiveModelRunner,
  RetrospectiveModelRunnerResult,
} from "./contracts.ts";
import { RETROSPECTIVE_DIMENSIONS } from "./contracts.ts";
import { decodeRetrospective } from "./decode-model-output.ts";
import { normalizeModelResult } from "./model.ts";

export async function evaluateTrajectory(input: {
  trajectory: BtccTrajectory;
  butlerData: string;
  modelRunner: RetrospectiveModelRunner;
  cacheScopePrefix: string;
}): Promise<{ value: BtccRetrospective; model: RetrospectiveModelRunnerResult }> {
  const model = normalizeModelResult(await input.modelRunner({
    kind: "evaluate",
    instructions: [
      "Evaluate the complete BTCC trajectory against the immutable original request and its structured products.",
      "Do not judge only the final prose and do not propose changes outside phase-local prompt guidance.",
      "Return one JSON object only, with no markdown or commentary.",
    ].join(" "),
    prompt: JSON.stringify({
      task: "btcc_whole_trajectory_retrospective",
      dimensions: RETROSPECTIVE_DIMENSIONS,
      learningSurface: {
        allowed: "phase_prompt_guidance_only",
        forbidden: [
          "state_machine", "phase_order", "schema", "operation_authority",
          "ledger_algorithm", "model_selection", "provider", "source_code", "product_version",
        ],
      },
      trajectory: input.trajectory,
      output: {
        summary: "string",
        dimensions: "object with every supplied dimension; each value has score 1..5, assessment, sourceRefs",
        strengths: ["string"],
        misses: ["string"],
        candidates: [{
          candidateId: "string", phase: "BTCC model phase", scopeKind: "user|project",
          problem: "string", guidance: "string", appliesWhen: ["string"],
          doesNotApplyWhen: ["string"], expectedBenefit: "string", risks: ["string"],
          confidence: "number 0..1", sourceRefs: ["string"],
        }],
        outsideLearningSurface: [{
          finding: "string", requiredChange: "string", sourceRefs: ["string"],
        }],
      },
    }),
    cacheScope: `${input.cacheScopePrefix}:${input.trajectory.sourceId}:evaluate`,
    butlerData: input.butlerData,
  }));
  return {
    value: decodeRetrospective(model.text, input.trajectory.sourceId),
    model,
  };
}
