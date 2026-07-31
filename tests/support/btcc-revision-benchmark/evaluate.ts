import {
  BTCC_REVISION_BENCHMARK_SCHEMA,
  type BenchmarkEvidenceFile,
  type BenchmarkPairComparison,
  type BenchmarkReport,
  type BenchmarkTarget,
  type BenchmarkTier,
  type BenchmarkTierSummary,
  type BtccRevision,
  type ObservationMetrics,
  type RawBenchmarkObservation,
} from "./contracts.ts";
import { calculateObservationMetrics } from "./metrics.ts";

const RATIO_REGRESSION_LIMIT = 1.25;
const RATIO_IMPROVEMENT_LIMIT = 0.85;
const QUALITY_DIFFERENCE = 0.25;
const TIERS: BenchmarkTier[] = ["direct", "simple_tool", "work_ledger", "project_ledger"];

export function evaluateBenchmarkEvidence(evidence: BenchmarkEvidenceFile): BenchmarkReport {
  if (
    evidence.schema !== BTCC_REVISION_BENCHMARK_SCHEMA ||
    evidence.kind !== "paired_e2e_evidence"
  ) throw new Error("Benchmark evidence contract does not match");
  const observationMap = new Map<string, RawBenchmarkObservation>();
  const reasons: string[] = [];
  for (const observation of evidence.observations) {
    const prompt = evidence.plan.prompts.find((item) => item.id === observation.promptId);
    const target = evidence.plan.targets[observation.revision];
    const key = observationKey(observation.promptId, observation.revision);
    if (
      !prompt ||
      observation.runId !== evidence.plan.runId ||
      observation.prompt !== prompt.prompt ||
      !sameStringSet(Object.keys(observation.quality.requiredOutcomes), prompt.requiredOutcomes) ||
      !sameTarget(observation.target, target) ||
      observation.ledger.expectedRoute !== prompt.expectedLedgerRoute ||
      (
        observation.providerReportedModel !== target.model &&
        !(observation.terminalState !== "delivered" &&
          observation.providerReportedModel === null)
      )
    ) reasons.push(`invalid_observation:${key}`);
    else if (observationMap.has(key)) reasons.push(`duplicate_observation:${key}`);
    else observationMap.set(key, observation);
  }
  const pairs = evidence.plan.prompts.map((prompt) => comparePair(
    prompt.id,
    prompt.tier,
    observationMap.get(observationKey(prompt.id, "r2")),
    observationMap.get(observationKey(prompt.id, "r3")),
  ));
  if (pairs.some((pair) => pair.winner === "undecided")) reasons.push("observations_incomplete");
  const tiers = TIERS.map((tier) => summarizeTier(tier, pairs));
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "paired_e2e_report",
    runId: evidence.plan.runId,
    verdict: resolveVerdict(pairs, tiers, reasons),
    reasons: [...new Set(reasons)],
    expectedObservations: evidence.plan.prompts.length * 2,
    observedObservations: observationMap.size,
    pairs,
    tiers,
  };
}

function comparePair(
  promptId: string,
  tier: BenchmarkTier,
  r2Observation: RawBenchmarkObservation | undefined,
  r3Observation: RawBenchmarkObservation | undefined,
): BenchmarkPairComparison {
  const r2 = r2Observation ? calculateObservationMetrics(r2Observation) : null;
  const r3 = r3Observation ? calculateObservationMetrics(r3Observation) : null;
  const qualityDelta = subtractNullable(r3?.qualityScore, r2?.qualityScore);
  const totalTokenRatio = ratio(r3?.totalTokens, r2?.totalTokens);
  const contextPreparationRatio = ratio(r3?.contextPreparationMs, r2?.contextPreparationMs);
  const firstMeaningfulRatio = ratio(r3?.firstMeaningfulMs, r2?.firstMeaningfulMs);
  const reasons: string[] = [];
  let winner: BenchmarkPairComparison["winner"] = "tie";
  if (
    knownTerminalFailure(r3Observation) &&
    knownDeliveredOutcome(r2Observation)
  ) {
    winner = "r2";
    reasons.push("r3_product_failure");
  } else if (
    knownTerminalFailure(r2Observation) &&
    knownDeliveredOutcome(r3Observation)
  ) {
    winner = "r3";
    reasons.push("r2_product_failure");
  } else if (!r2?.measurementComplete || !r3?.measurementComplete) {
    winner = "undecided";
    reasons.push("measurement_incomplete");
  } else if (hardFailure(r3) && !hardFailure(r2)) {
    winner = "r2";
    reasons.push("r3_product_failure");
  } else if (hardFailure(r2) && !hardFailure(r3)) {
    winner = "r3";
    reasons.push("r2_product_failure");
  } else if (qualityDelta !== null && qualityDelta >= QUALITY_DIFFERENCE) {
    winner = "r3";
    reasons.push("quality_improvement");
  } else if (qualityDelta !== null && qualityDelta <= -QUALITY_DIFFERENCE) {
    winner = "r2";
    reasons.push("quality_regression");
  } else {
    const ratios = [totalTokenRatio, contextPreparationRatio, firstMeaningfulRatio]
      .filter((value): value is number => value !== null);
    if (ratios.some((value) => value > RATIO_REGRESSION_LIMIT)) {
      winner = "r2";
      reasons.push("efficiency_or_ux_regression");
    } else if (ratios.filter((value) => value < RATIO_IMPROVEMENT_LIMIT).length >= 2) {
      winner = "r3";
      reasons.push("efficiency_and_ux_improvement");
    } else {
      reasons.push("no_material_difference");
    }
  }
  return {
    promptId,
    tier,
    r2,
    r3,
    qualityDelta,
    totalTokenRatio,
    contextPreparationRatio,
    firstMeaningfulRatio,
    winner,
    reasons,
  };
}

function resolveVerdict(
  pairs: BenchmarkPairComparison[],
  tiers: BenchmarkTierSummary[],
  reasons: string[],
): BenchmarkReport["verdict"] {
  if (reasons.length > 0 || pairs.some((pair) => pair.winner === "undecided")) {
    return "insufficient_evidence";
  }
  if (pairs.some((pair) =>
    pair.r3 && hardFailure(pair.r3) && pair.r2 && !hardFailure(pair.r2),
  )) {
    reasons.push("r3_hard_product_regression");
    return "r2_better";
  }
  const r2Tiers = tiers.filter((tier) => tier.r2Wins > tier.r3Wins).length;
  const r3Tiers = tiers.filter((tier) => tier.r3Wins > tier.r2Wins).length;
  if (r3Tiers > r2Tiers && r2Tiers === 0) return "r3_better";
  if (r2Tiers > r3Tiers && r3Tiers === 0) return "r2_better";
  return "no_clear_winner";
}

function summarizeTier(
  tier: BenchmarkTier,
  pairs: BenchmarkPairComparison[],
): BenchmarkTierSummary {
  const selected = pairs.filter((pair) => pair.tier === tier);
  return {
    tier,
    pairs: selected.length,
    r2Wins: selected.filter((pair) => pair.winner === "r2").length,
    r3Wins: selected.filter((pair) => pair.winner === "r3").length,
    ties: selected.filter((pair) => pair.winner === "tie").length,
    meanQualityDelta: averageComplete(selected.map((pair) => pair.qualityDelta)),
    meanTotalTokenRatio: averageComplete(selected.map((pair) => pair.totalTokenRatio)),
    meanContextPreparationRatio: averageComplete(
      selected.map((pair) => pair.contextPreparationRatio),
    ),
    meanFirstMeaningfulRatio: averageComplete(
      selected.map((pair) => pair.firstMeaningfulRatio),
    ),
  };
}

function sameTarget(left: BenchmarkTarget, right: BenchmarkTarget): boolean {
  return (Object.keys(right) as Array<keyof BenchmarkTarget>).every(
    (field) => left[field] === right[field],
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function hardFailure(metrics: ObservationMetrics): boolean {
  return !metrics.outcomeSuccess ||
    metrics.durabilityPass !== true ||
    metrics.safetyPass !== true ||
    !metrics.ledgerRoutePass ||
    !metrics.ledgerCloseoutPass ||
    (metrics.unrecoveredToolErrors ?? 1) > 0;
}

function knownTerminalFailure(
  observation: RawBenchmarkObservation | undefined,
): boolean {
  return Boolean(observation && observation.terminalState !== "delivered");
}

function knownDeliveredOutcome(
  observation: RawBenchmarkObservation | undefined,
): boolean {
  return Boolean(
    observation &&
    calculateObservationMetrics(observation).outcomeSuccess,
  );
}

function observationKey(promptId: string, revision: BtccRevision): string {
  return `${promptId}:${revision}`;
}

function ratio(numerator: number | null | undefined, denominator: number | null | undefined) {
  if (
    numerator === null || numerator === undefined ||
    denominator === null || denominator === undefined ||
    !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0
  ) return null;
  return numerator / denominator;
}

function subtractNullable(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return left - right;
}

function averageComplete(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null) && values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}
