import type { BenchmarkResultFile } from "./contracts.ts";
import type { BenchmarkVersion } from "./paired-contract.ts";
import type { M1V2ArmId, M1V2RepetitionResult } from "./m1-v2-types.ts";

export type PairEligibility = "eligible" | "descriptive" | "rejected";

export interface PairComparableIdentity {
  fixture: string; sourceRevision: string; model: string; reasoning: string;
  executionMode: string; provider: string; authMode: string; cache: string;
  route: string; retryOrdinal: number;
}

export function pairEligibility(input: {
  before: PairComparableIdentity;
  after: PairComparableIdentity;
}): { status: PairEligibility; reason: string } {
  const exactKeys = ["fixture", "model", "reasoning", "executionMode", "provider", "authMode"] as const;
  for (const key of exactKeys) {
    if (input.before[key] !== input.after[key]) return { status: "rejected", reason: `${key}_mismatch` };
  }
  if (input.before.sourceRevision === input.after.sourceRevision) return { status: "rejected", reason: "source_not_paired" };
  if (input.before.retryOrdinal > 0 || input.after.retryOrdinal > 0) return { status: "rejected", reason: "retry_contaminated" };
  if (input.before.route !== input.after.route) return { status: "rejected", reason: "route_mismatch" };
  if (input.before.cache !== input.after.cache) return { status: "descriptive", reason: "cache_mismatch" };
  return { status: "eligible", reason: "exact_pair" };
}

export interface PairedMetricRow {
  pairId: string; fixture: M1V2ArmId; version: BenchmarkVersion;
  eligibility: PairEligibility; providerSendBytes: number; physicalRequests: number;
  semanticRounds: number; toolCalls: number; elapsedMs: number;
  firstUsefulMs: number | null; usage: number | null; qualityPassed: boolean;
}

export function aggregatePairedMetrics(rows: readonly PairedMetricRow[]) {
  const eligible = paired(rows).filter(([before, after]) =>
    before.eligibility === "eligible" && after.eligibility === "eligible");
  const summarize = (pairs: Array<[PairedMetricRow, PairedMetricRow]>) => ({
    pairs: pairs.length,
    providerSendBytes: delta(pairs, "providerSendBytes"),
    physicalRequests: delta(pairs, "physicalRequests"),
    semanticRounds: delta(pairs, "semanticRounds"), toolCalls: delta(pairs, "toolCalls"),
    elapsedMs: delta(pairs, "elapsedMs"), firstUsefulMs: nullableDelta(pairs, "firstUsefulMs"),
    usage: nullableDelta(pairs, "usage"),
    qualityPassed: pairs.every(([before, after]) => before.qualityPassed && after.qualityPassed),
    totalProviderSendBytes: totalDelta(pairs, "providerSendBytes"),
    totalElapsedMs: totalDelta(pairs, "elapsedMs"),
  });
  return {
    byArm: Object.fromEntries((["direct-cold", "direct-warm", "current-web-cold", "landing-cold"] as const)
      .map((fixture) => [fixture, summarize(eligible.filter(([before]) => before.fixture === fixture))])),
    overall: summarize(eligible),
    governing: { dispersion: "paired_min_median_max", confidence: "all_12_eligible_pairs_required" },
  };
}

export function summarizePairedBenchmarkResult(result: BenchmarkResultFile) {
  if (result.plan.campaign !== "m1-v2-paired") return null;
  const rows = result.observations.flatMap((observation): PairedMetricRow[] => {
    const repetition = observation.m1V2;
    const version = observation.arm.version;
    const pairId = observation.arm.pairId;
    if (!repetition || !version || !pairId) return [];
    const reason = repetition.reasons.join("|");
    const eligibility: PairEligibility = repetition.status === "accepted"
      ? "eligible"
      : reason.includes("cache") ? "descriptive" : "rejected";
    const usageValues = repetition.agentAttempts.map((attempt) => attempt.totalTokens);
    return [{
      pairId, fixture: repetition.armId, version, eligibility,
      providerSendBytes: repetition.agentAttempts.reduce((sum, attempt) => sum + attempt.providerSendBytes, 0),
      physicalRequests: repetition.agentAttempts.length,
      semanticRounds: repetition.semanticRounds, toolCalls: repetition.toolCalls,
      elapsedMs: repetition.elapsedMs ?? 0, firstUsefulMs: repetition.firstUsefulMs,
      usage: usageValues.length > 0 && usageValues.every((value): value is number => value !== null)
        ? usageValues.reduce((sum, value) => sum + value, 0) : null,
      qualityPassed: repetition.armId === "landing-cold"
        ? landingQualityPassed(repetition) : repetition.status === "accepted",
    }];
  });
  const aggregate = aggregatePairedMetrics(rows);
  const byteReduction = aggregate.overall.totalProviderSendBytes.ratio;
  const elapsedReduction = aggregate.overall.totalElapsedMs.ratio;
  return {
    contractIdentity: result.plan.pairedCampaign?.identity ?? null, rows, aggregate,
    acceptance: {
      complete: rows.length === 24 && aggregate.overall.pairs === 12,
      providerSendReductionPassed: byteReduction !== null && byteReduction <= -0.30,
      elapsedTargetPassed: elapsedReduction !== null && elapsedReduction <= -0.18 && elapsedReduction >= -0.30,
      zeroQualityRegressionPassed: aggregate.overall.qualityPassed,
    },
  };
}

export interface ComparisonIndexEntry {
  id: "hermes" | "opencode" | "historical-butler" | "paired-butler";
  status: "ranked" | "unranked"; reason: string; metrics: Record<string, number | null>;
}

export function createComparisonIndex(input: {
  paired: Record<string, number | null>;
  historical: readonly Omit<ComparisonIndexEntry, "status">[];
}): readonly ComparisonIndexEntry[] {
  return [
    ...input.historical.map((entry) => ({ ...entry, status: "unranked" as const })),
    { id: "paired-butler" as const, status: "ranked" as const, reason: "final_paired_contract", metrics: input.paired },
  ];
}

export function comparisonIndexHtml(entries: readonly ComparisonIndexEntry[]): string {
  const rows = entries.map((entry) => `<tr><td>${escape(entry.id)}</td><td>${entry.status}</td><td>${escape(entry.reason)}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><table><thead><tr><th>Agent</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function landingQualityPassed(result: M1V2RepetitionResult): boolean {
  const landing = result.quality.landing;
  return Boolean(landing && landing.buildPassed && landing.desktopPassed && landing.mobilePassed &&
    landing.durableProjectWorkGrounded && landing.memoryContextGrounded &&
    landing.toolsWorkspaceGrounded && landing.providerRoutingGrounded && landing.recoveryGrounded &&
    result.work.observed && result.work.status === "completed" &&
    result.work.planReviewVerdict === "accept" && result.work.resultReviewVerdict === "accept" &&
    result.work.completionValidationVerdict === "accept" &&
    result.work.projectLedgerCloseoutObserved && result.reloadPassed);
}

function paired(rows: readonly PairedMetricRow[]): Array<[PairedMetricRow, PairedMetricRow]> {
  const groups = new Map<string, Partial<Record<BenchmarkVersion, PairedMetricRow>>>();
  for (const row of rows) groups.set(row.pairId, { ...(groups.get(row.pairId) ?? {}), [row.version]: row });
  return [...groups.values()].flatMap((group) => group.before && group.after ? [[group.before, group.after]] : []);
}

function delta(pairs: Array<[PairedMetricRow, PairedMetricRow]>, key: "providerSendBytes" | "physicalRequests" | "semanticRounds" | "toolCalls" | "elapsedMs") {
  return ranges(pairs.map(([before, after]) => ({ absolute: after[key] - before[key], ratio: before[key] === 0 ? null : (after[key] - before[key]) / before[key] })));
}

function nullableDelta(pairs: Array<[PairedMetricRow, PairedMetricRow]>, key: "firstUsefulMs" | "usage") {
  return ranges(pairs.flatMap(([before, after]) => before[key] === null || after[key] === null
    ? [] : [{ absolute: after[key]! - before[key]!, ratio: before[key] === 0 ? null : (after[key]! - before[key]!) / before[key]! }]));
}

function totalDelta(pairs: Array<[PairedMetricRow, PairedMetricRow]>, key: "providerSendBytes" | "elapsedMs") {
  const before = pairs.reduce((sum, pair) => sum + pair[0][key], 0);
  const after = pairs.reduce((sum, pair) => sum + pair[1][key], 0);
  return { before, after, absolute: after - before, ratio: before === 0 ? null : (after - before) / before };
}

function ranges(values: Array<{ absolute: number; ratio: number | null }>) {
  const field = (key: "absolute" | "ratio") => {
    const nums = values.flatMap((value) => value[key] === null ? [] : [value[key]!]).sort((a, b) => a - b);
    if (!nums.length) return { min: null, median: null, max: null };
    const middle = Math.floor(nums.length / 2);
    const median = nums.length % 2 === 0 ? (nums[middle - 1]! + nums[middle]!) / 2 : nums[middle]!;
    return { min: nums[0]!, median, max: nums.at(-1)! };
  };
  return { absolute: field("absolute"), ratio: field("ratio") };
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
