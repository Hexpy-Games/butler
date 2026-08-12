import type { BenchmarkArmPlan, BenchmarkResultFile } from "./contracts.ts";
import type { BenchmarkVersion } from "./paired-contract.ts";
import { pairedObservationIdentityMatches } from "./paired-observation-identity.ts";
import { OBSERVED_M1_REQUEST_SEGMENT_KINDS, type M1RequestSegmentKind, type M1V2ArmId, type M1V2RepetitionResult } from "./m1-v2-types.ts";

export type PairEligibility = "eligible" | "descriptive" | "rejected";
export interface PairComparableIdentity {
  fixture: string; sourceRevision: string; model: string; reasoning: string;
  executionMode: string; provider: string; authMode: string; cache: string;
  route: string; retryOrdinal: number;
}
export interface PairDecision { pairId: string; status: PairEligibility; reason: string }

export function comparableIdentityForArm(arm: BenchmarkArmPlan, repetition: M1V2RepetitionResult | null,
  runtime: { reasoning: string; route: string; provider: string; model: string; authMode: string; executionMode: string } | null = null): PairComparableIdentity | null {
  const attempts = repetition?.agentAttempts ?? [];
  if (attempts.length === 0) return null;
  const observedField = (key: keyof (typeof attempts)[number]): string | null => {
    const values = [...new Set(attempts.map((attempt) => attempt[key]))];
    return values.length === 1 && typeof values[0] === "string" ? values[0] :
      values.length > 1 ? `observed_conflict:${String(key)}` : null;
  };
  const source = observedField("sourceRevision"), model = observedField("modelRef"), provider = observedField("providerId"),
    cacheBoundary = observedField("cacheBoundaryRevision");
  if (!source || !model || !provider || !cacheBoundary || !runtime) return null;
  const cache = attempts.some((attempt) => attempt.eligibility === "cache_mismatch") ? "cache_mismatch" :
    attempts.every((attempt) => attempt.eligibility === "eligible") ? "eligible" : "rejected";
  return { fixture: `${arm.scenario}:${arm.fixtureHash}`, sourceRevision: source, model, reasoning: runtime.reasoning,
    executionMode: runtime.executionMode, provider, authMode: runtime.authMode,
    cache: `${cache}:${cacheBoundary}`, route: runtime.route, retryOrdinal: Math.max(0, ...attempts.map((attempt) => attempt.retryOrdinal)) };
}

export function pairEligibility(input: { before: PairComparableIdentity; after: PairComparableIdentity }): Omit<PairDecision, "pairId"> {
  const exact = ["fixture", "model", "reasoning", "executionMode", "provider", "authMode"] as const;
  for (const key of exact) if (input.before[key] !== input.after[key]) return { status: "rejected", reason: `${key}_mismatch` };
  if (input.before.sourceRevision === input.after.sourceRevision) return { status: "rejected", reason: "source_not_paired" };
  if (input.before.retryOrdinal > 0 || input.after.retryOrdinal > 0) return { status: "rejected", reason: "retry_contaminated" };
  if (input.before.route !== input.after.route) return { status: "rejected", reason: "route_mismatch" };
  if (input.before.sourceRevision !== "c46aae1af1b78a6f81ea40c3099edde0ba35ebd5" ||
      input.after.sourceRevision !== "394c98a97428b741f8ea54273a226cb062455ab0")
    return { status: "rejected", reason: "source_mismatch" };
  for (const identity of [input.before, input.after]) {
    if (identity.model !== "openai/gpt-5.6-sol" || identity.reasoning !== "medium" ||
        identity.executionMode !== "ordinary_non_fast" || identity.provider !== "openai" ||
        identity.authMode !== "managed" || identity.route.length === 0)
      return { status: "rejected", reason: "observed_execution_identity_mismatch" };
  }
  if (input.before.cache.startsWith("rejected:") || input.after.cache.startsWith("rejected:"))
    return { status: "rejected", reason: "ineligible_observation" };
  if (input.before.cache.startsWith("cache_mismatch:") || input.after.cache.startsWith("cache_mismatch:") ||
      input.before.cache !== input.after.cache) return { status: "descriptive", reason: "cache_mismatch" };
  return { status: "eligible", reason: "exact_pair" };
}

type Usage = Record<"promptTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens" | "totalTokens", number | null>;
export interface PairedMetricRow {
  pairId: string; fixture: M1V2ArmId; version: BenchmarkVersion; identity: PairComparableIdentity;
  providerSendBytes: number; physicalRequests: number; modelRounds: number; toolCalls: number;
  elapsedMs: number | null; firstUsefulMs: number | null; usage: Usage;
  segments: Partial<Record<M1RequestSegmentKind, number>>; qualityPassed: boolean;
}

export function aggregatePairedMetrics(rows: readonly PairedMetricRow[]) {
  const allPairs = paired(rows);
  const decisions = allPairs.map(([before, after]) => ({ pairId: before.pairId, ...pairEligibility({ before: before.identity, after: after.identity }) }));
  const eligibleIds = new Set(decisions.filter((item) => item.status === "eligible").map((item) => item.pairId));
  const eligible = allPairs.filter(([before]) => eligibleIds.has(before.pairId));
  const summarize = (pairs: Array<[PairedMetricRow, PairedMetricRow]>) => ({
    pairs: pairs.length,
    providerSendBytes: metric(pairs, (row) => row.providerSendBytes),
    physicalRequests: metric(pairs, (row) => row.physicalRequests),
    modelRounds: metric(pairs, (row) => row.modelRounds), toolCalls: metric(pairs, (row) => row.toolCalls),
    elapsedMs: metric(pairs, (row) => row.elapsedMs), firstUsefulMs: metric(pairs, (row) => row.firstUsefulMs),
    usage: Object.fromEntries((["promptTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const)
      .map((key) => [key, metric(pairs, (row) => row.usage[key])])),
    segments: Object.fromEntries(OBSERVED_M1_REQUEST_SEGMENT_KINDS.map((kind) =>
      [kind, metric(pairs, (row) => row.segments[kind] ?? 0)])),
    qualityPassed: pairs.length > 0 && pairs.every(([before, after]) => before.qualityPassed && after.qualityPassed),
  });
  const byArm = Object.fromEntries((["direct-cold", "direct-warm", "current-web-cold", "landing-cold"] as const)
    .map((fixture) => [fixture, summarize(eligible.filter(([before]) => before.fixture === fixture))]));
  return { byArm, overall: summarize(eligible), decisions,
    complete: decisions.length === 12 && eligible.length === 12 && Object.values(byArm).every((arm) => arm.pairs === 3),
    governing: { dispersion: "paired_before_after_delta_min_median_max_range", confidence: "all_12_eligible_pairs_required" } };
}

export function summarizePairedBenchmarkResult(result: BenchmarkResultFile) {
  if (result.plan.campaign !== "m1-v2-paired") return null;
  const cardinality = observationCardinality(result);
  const rows = result.observations.flatMap((observation): PairedMetricRow[] => {
    const repetition = observation.m1V2;
    const version = observation.arm.version;
    const pairId = observation.arm.pairId;
    const execution = observation.arm.pairedExecution;
    if (!repetition || !version || !pairId || !execution) return [];
    const attempt = repetition.agentAttempts;
    const usage = (key: keyof Usage) => attempt.length > 0 && attempt.every((item) => item[key] !== null)
      ? attempt.reduce((sum, item) => sum + (item[key] ?? 0), 0) : null;
    const identity = observation.pairedComparableIdentity;
    if (!identity) return [];
    return [{ pairId, fixture: repetition.armId, version,
      identity,
      providerSendBytes: attempt.reduce((sum, item) => sum + item.providerSendBytes, 0) +
        Object.values(repetition.unarmedPhysicalOverhead).reduce((sum, item) => sum + item.providerSendBytes, 0),
      physicalRequests: attempt.length + repetition.auxiliaryPhysicalAttempts + repetition.titlePhysicalAttempts + repetition.providerToolPhysicalAttempts,
      modelRounds: repetition.semanticRounds, toolCalls: repetition.toolCalls,
      elapsedMs: repetition.elapsedMs, firstUsefulMs: repetition.firstUsefulMs,
      usage: { promptTokens: usage("promptTokens"), cacheReadTokens: usage("cacheReadTokens"), cacheWriteTokens: usage("cacheWriteTokens"), outputTokens: usage("outputTokens"), reasoningTokens: usage("reasoningTokens"), totalTokens: usage("totalTokens") },
      segments: Object.fromEntries(OBSERVED_M1_REQUEST_SEGMENT_KINDS.map((kind) => [kind, attempt.reduce((sum, item) => sum + (item.segments[kind] ?? 0), 0)])),
      qualityPassed: observation.terminalState === "accepted" && observation.evaluation.accepted === true && repetitionQualityPassed(repetition) }];
  });
  const aggregate = aggregatePairedMetrics(rows);
  const bytes = aggregate.overall.providerSendBytes.total.ratio;
  const elapsed = aggregate.overall.elapsedMs.total.ratio;
  const requestBefore = aggregate.overall.physicalRequests.total.before;
  const requestAfter = aggregate.overall.physicalRequests.total.after;
  const complete = aggregate.complete && cardinality.valid;
  const acceptance = { complete,
    providerSendReductionPassed: complete && bytes !== null && bytes <= -0.30,
    requestCountReductionPassed: complete && requestBefore === 45 && requestAfter !== null && requestAfter >= 38 && requestAfter <= 40,
    elapsedTargetPassed: complete && elapsed !== null && elapsed <= -0.18 && elapsed >= -0.30,
    zeroQualityRegressionPassed: complete && aggregate.overall.qualityPassed };
  return { contractIdentity: result.plan.pairedCampaign?.identity ?? null, rows, aggregate, cardinality, acceptance };
}

export function observationCardinality(result: BenchmarkResultFile): { valid: boolean; reason: string } {
  const expected = result.plan.arms, actual = result.observations;
  const actualKeys = actual.map((row) => row.arm.key);
  return expected.length === 24 && actual.length === 24 && expected.every((arm, index) =>
    actual[index]?.arm.key === arm.key && pairedObservationIdentityMatches(arm, actual[index]!.arm)) &&
    new Set(actualKeys).size === 24 ? { valid: true, reason: "exact_24_plan_order" } :
    { valid: false, reason: "observation_identity_or_cardinality_mismatch" };
}

function landingQualityPassed(result: M1V2RepetitionResult): boolean {
  const landing = result.quality.landing;
  const db = result.db;
  return Boolean(result.status === "accepted" && landing && landing.buildPassed && landing.desktopPassed && landing.mobilePassed &&
    landing.desktopScreenshotPresent && landing.mobileScreenshotPresent && landing.indexChanged && landing.stylesChanged &&
    landing.butlerGrounded && landing.usageScenePresent && landing.ctaPresent && landing.responsiveCssPresent &&
    landing.genericCopyAbsent && landing.approvedCapabilityClaims.length === 5 &&
    landing.approvedCapabilityClaims.every((claim) => claim.passed && !claim.negated && !claim.misrepresented) &&
    landing.durableProjectWorkGrounded && landing.memoryContextGrounded && landing.toolsWorkspaceGrounded &&
    landing.providerRoutingGrounded && landing.recoveryGrounded && result.work.observed &&
    result.work.status === "completed" && result.work.planReviewVerdict === "accept" &&
    result.work.resultReviewVerdict === "accept" && result.work.completionValidationVerdict === "accept" &&
    result.work.projectLedgerCloseoutObserved && result.work.workspaceAuthorityPassed === true &&
    result.work.providerRoutingPassed === true && result.work.stallObserved === false &&
    result.work.duplicateEvidenceCount === 0 && result.work.lostCorrectionEvidenceCount === 0 &&
    result.work.lostRequiredAnchorCount === 0 && db?.quickCheckPassed === true && db.duplicateAppliedEffects === 0 &&
    db.unresolvedCorrections === 0 && db.lostRequiredAnchors === 0 && result.reloadPassed);
}

function repetitionQualityPassed(result: M1V2RepetitionResult): boolean {
  if (result.status !== "accepted" || !result.db?.quickCheckPassed || result.db.duplicateAppliedEffects !== 0 ||
      result.db.unresolvedCorrections !== 0 || result.db.lostRequiredAnchors !== 0 || !result.reloadPassed) return false;
  return result.armId === "landing-cold" ? landingQualityPassed(result) : true;
}

function paired(rows: readonly PairedMetricRow[]): Array<[PairedMetricRow, PairedMetricRow]> {
  const groups = new Map<string, Partial<Record<BenchmarkVersion, PairedMetricRow>>>();
  for (const row of rows) groups.set(row.pairId, { ...(groups.get(row.pairId) ?? {}), [row.version]: row });
  return [...groups.values()].flatMap((group) => group.before && group.after ? [[group.before, group.after]] : []);
}

function metric(pairs: Array<[PairedMetricRow, PairedMetricRow]>, select: (row: PairedMetricRow) => number | null) {
  const complete = pairs.flatMap(([before, after]) => {
    const left = select(before), right = select(after);
    return left === null || right === null ? [] : [{ before: left, after: right, delta: right - left, ratio: left === 0 ? null : (right - left) / left }];
  });
  const stats = (values: number[]) => values.length === 0 ? { min: null, median: null, max: null, range: null } :
    { min: Math.min(...values), median: median(values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) };
  const before = complete.reduce((sum, item) => sum + item.before, 0), after = complete.reduce((sum, item) => sum + item.after, 0);
  return { availablePairs: complete.length, unavailablePairs: pairs.length - complete.length,
    before: stats(complete.map((item) => item.before)), after: stats(complete.map((item) => item.after)),
    delta: stats(complete.map((item) => item.delta)), ratio: stats(complete.flatMap((item) => item.ratio === null ? [] : [item.ratio])),
    total: { before: complete.length ? before : null, after: complete.length ? after : null,
      delta: complete.length ? after - before : null, ratio: complete.length && before !== 0 ? (after - before) / before : null } };
}

function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2; }

export interface ComparisonIndexEntry { id: "hermes" | "opencode" | "historical-butler" | "paired-butler"; status: "ranked" | "unranked"; reason: string; metrics: Record<string, number | null> }
export function comparisonIndexForResult(result: BenchmarkResultFile): readonly ComparisonIndexEntry[] {
  const summary = summarizePairedBenchmarkResult(result);
  const ranked = Boolean(summary?.acceptance.complete && summary.acceptance.providerSendReductionPassed && summary.acceptance.requestCountReductionPassed && summary.acceptance.elapsedTargetPassed && summary.acceptance.zeroQualityRegressionPassed);
  return [
    { id: "hermes", status: "unranked", reason: "frozen_historical", metrics: {} },
    { id: "opencode", status: "unranked", reason: "frozen_historical", metrics: {} },
    { id: "historical-butler", status: "unranked", reason: "provenance_only", metrics: {} },
    { id: "paired-butler", status: ranked ? "ranked" : "unranked", reason: ranked ? "final_paired_accepted" : "paired_incomplete_or_rejected", metrics: { providerSendRatio: summary?.aggregate.overall.providerSendBytes.total.ratio ?? null } },
  ];
}
export function comparisonIndexHtml(entries: readonly ComparisonIndexEntry[]): string { return `<!doctype html><meta charset="utf-8"><table><tbody>${entries.map((entry) => `<tr><td>${entry.id}</td><td>${entry.status}</td><td>${entry.reason}</td></tr>`).join("")}</tbody></table>`; }
