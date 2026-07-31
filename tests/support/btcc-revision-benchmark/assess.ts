import {
  BTCC_REVISION_BENCHMARK_SCHEMA,
  type BenchmarkAssessmentFile,
  type BenchmarkEvidenceFile,
  type BenchmarkProductAssessment,
  type BtccRevision,
  type RawBenchmarkObservation,
} from "./contracts.ts";

const SAFETY_FIELDS = [
  "unauthorizedEffects",
  "targetEscapes",
  "falseSuccessClaims",
  "privacyLeaks",
] as const;

export function applyProductAssessments(
  evidence: BenchmarkEvidenceFile,
  assessmentFile: BenchmarkAssessmentFile,
): BenchmarkEvidenceFile {
  validateAssessmentFile(evidence, assessmentFile);
  const assessments = new Map(assessmentFile.assessments.map((assessment) => [
    observationKey(assessment.promptId, assessment.revision),
    assessment,
  ]));
  return {
    ...evidence,
    observations: evidence.observations.map((observation) => {
      const assessment = assessments.get(
        observationKey(observation.promptId, observation.revision),
      );
      return assessment ? applyAssessment(observation, assessment) : observation;
    }),
  };
}

function validateAssessmentFile(
  evidence: BenchmarkEvidenceFile,
  file: BenchmarkAssessmentFile,
): void {
  if (
    file.schema !== BTCC_REVISION_BENCHMARK_SCHEMA ||
    file.kind !== "product_assessments"
  ) throw new Error("Benchmark assessment contract does not match");
  if (file.runId !== evidence.plan.runId) {
    throw new Error("Benchmark assessment runId does not match evidence");
  }
  const observations = new Map(evidence.observations.map((observation) => [
    observationKey(observation.promptId, observation.revision),
    observation,
  ]));
  const seen = new Set<string>();
  for (const assessment of file.assessments) {
    const key = observationKey(assessment.promptId, assessment.revision);
    if (seen.has(key)) throw new Error(`Duplicate product assessment: ${key}`);
    seen.add(key);
    const observation = observations.get(key);
    if (!observation) throw new Error(`Product observation not found: ${key}`);
    if (observation.terminalState !== "delivered") {
      throw new Error(`Only delivered observations may be assessed: ${key}`);
    }
    validateAssessment(assessment, observation);
  }
}

function validateAssessment(
  assessment: BenchmarkProductAssessment,
  observation: RawBenchmarkObservation,
): void {
  const key = observationKey(assessment.promptId, assessment.revision);
  if (
    !validScore(assessment.quality.intentScore) ||
    !validScore(assessment.quality.resultScore)
  ) throw new Error(`Product assessment scores must be between 1 and 5: ${key}`);
  if (!assessment.quality.assessmentNote.trim()) {
    throw new Error(`Product assessment note is required: ${key}`);
  }
  const expectedOutcomes = Object.keys(observation.quality.requiredOutcomes);
  const assessedOutcomes = Object.keys(assessment.quality.requiredOutcomes);
  if (!sameStringSet(expectedOutcomes, assessedOutcomes)) {
    throw new Error(`Product assessment outcomes do not match the prompt: ${key}`);
  }
  if (
    !Object.values(assessment.quality.requiredOutcomes).every(
      (value) => typeof value === "boolean",
    )
  ) throw new Error(`Product assessment outcomes must be boolean: ${key}`);
  if (
    !sameStringSet(Object.keys(assessment.safety ?? {}), [...SAFETY_FIELDS]) ||
    !Object.values(assessment.safety).every(
      (value) => Number.isInteger(value) && value >= 0,
    )
  ) throw new Error(`Product assessment safety counts must be non-negative: ${key}`);
}

function applyAssessment(
  observation: RawBenchmarkObservation,
  assessment: BenchmarkProductAssessment,
): RawBenchmarkObservation {
  return {
    ...observation,
    quality: {
      intentScore: assessment.quality.intentScore,
      resultScore: assessment.quality.resultScore,
      requiredOutcomes: { ...assessment.quality.requiredOutcomes },
      assessmentNote: assessment.quality.assessmentNote,
    },
    safety: { ...assessment.safety },
  };
}

function observationKey(promptId: string, revision: BtccRevision): string {
  return `${promptId}:${revision}`;
}

function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 5;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}
