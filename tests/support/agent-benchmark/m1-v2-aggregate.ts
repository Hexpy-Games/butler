import { OBSERVED_M1_REQUEST_SEGMENT_KINDS } from "./m1-v2-types.ts";
import type {
  M1V2ArmAggregate,
  M1V2CampaignResult,
  M1V2NullableRange,
  M1V2RepetitionResult,
} from "./m1-v2-types.ts";

const USAGE_KEYS = [
  "promptTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

export function buildCampaignResult(
  repetitionsPerArm: number,
  repetitions: M1V2RepetitionResult[],
): M1V2CampaignResult {
  const counts = {
    accepted: repetitions.filter((item) => item.status === "accepted").length,
    rejected: repetitions.filter((item) => item.status === "rejected").length,
    gated: repetitions.filter((item) => item.status === "gated").length,
  };
  const arms = (["direct-cold", "direct-warm", "current-web-cold", "landing-cold"] as const)
    .map((armId) => aggregateArm(armId, repetitions));
  return {
    schema: "butler.agent-benchmark.m1-v2.v1",
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
    sequential: true,
    repetitionsPerArm,
    complete: repetitions.length === repetitionsPerArm * 4 &&
      arms.every((arm) => arm.accepted >= repetitionsPerArm),
    counts,
    repetitions: [...repetitions],
    arms,
    privacy: {
      rawPromptStored: false,
      rawFinalStored: false,
      rawToolPayloadStored: false,
      urlOrQueryStored: false,
      privatePathStored: false,
      credentialStored: false,
      generatedContentHashStored: false,
    },
  };
}

export function emptyM1V2Repetition(
  armId: M1V2RepetitionResult["armId"],
  repetition: number,
  status: "gated" | "rejected",
  reason: string,
): M1V2RepetitionResult {
  return {
    armId,
    repetition,
    status,
    reasons: [reason],
    targetTerminalState: null,
    agentAttempts: [],
    auxiliaryPhysicalAttempts: 0,
    titlePhysicalAttempts: 0,
    providerToolPhysicalAttempts: 0,
    unarmedPhysicalOverhead: {
      auxiliary: { attempts: 0, providerSendBytes: 0 },
      title: { attempts: 0, providerSendBytes: 0 },
      toolProvider: { attempts: 0, providerSendBytes: 0 },
    },
    otherShare: null,
    reducibleShare: null,
    semanticRounds: 0,
    toolCalls: 0,
    elapsedMs: null,
    firstUsefulMs: null,
    reloadPassed: false,
    quality: {
      conciseGreeting: null,
      fixedDatePresent: null,
      umbrellaRecommendationPresent: null,
      sourceReferenceCount: null,
      sourceGrounded: null,
      landing: null,
    },
    db: null,
    work: {
      observed: false,
      status: null,
      planRevision: null,
      checkpointStage: null,
      checkpointStages: 0,
      planReviewVerdict: null,
      resultReviewVerdict: null,
      completionValidationVerdict: null,
      resultToolNames: 0,
      projectLedgerWorkRecords: 0,
      projectLedgerCompletedWorkRecords: 0,
      projectLedgerCloseoutObserved: false,
      duplicateEvidenceCount: null,
      lostCorrectionEvidenceCount: null,
      lostRequiredAnchorCount: null,
      workspaceAuthorityPassed: null,
      providerRoutingPassed: null,
      stallObserved: null,
    },
  };
}

function aggregateArm(
  armId: M1V2ArmAggregate["armId"],
  repetitions: M1V2RepetitionResult[],
): M1V2ArmAggregate {
  const all = repetitions.filter((item) => item.armId === armId);
  const accepted = all.filter((item) => item.status === "accepted");
  const allAttempts = all.flatMap((item) => item.agentAttempts);
  const retryAttempts = allAttempts.filter((attempt) =>
    attempt.eligibility === "retry_contaminated");
  const segments = Object.fromEntries(OBSERVED_M1_REQUEST_SEGMENT_KINDS.flatMap((kind) => {
    const values = accepted.map((item) => sum(item.agentAttempts.map((attempt) =>
      attempt.segments[kind] ?? 0)));
    return values.length > 0 ? [[kind, range(values)]] : [];
  }));
  return {
    armId,
    accepted: accepted.length,
    rejected: all.filter((item) => item.status === "rejected").length,
    gated: all.filter((item) => item.status === "gated").length,
    providerSendBytes: range(accepted.map((item) =>
      sum(item.agentAttempts.map((attempt) => attempt.providerSendBytes)))),
    reducibleShare: range(accepted.flatMap((item) =>
      item.reducibleShare === null ? [] : [item.reducibleShare])),
    semanticRounds: range(accepted.map((item) => item.semanticRounds)),
    toolCalls: range(accepted.map((item) => item.toolCalls)),
    elapsedMs: range(accepted.flatMap((item) =>
      item.elapsedMs === null ? [] : [item.elapsedMs])),
    firstUsefulMs: range(accepted.flatMap((item) =>
      item.firstUsefulMs === null ? [] : [item.firstUsefulMs])),
    responseUsage: Object.fromEntries(USAGE_KEYS.map((key) => [
      key,
      nullableRange(accepted.map((item) => repetitionUsage(item, key))),
    ])) as M1V2ArmAggregate["responseUsage"],
    retry: {
      physicalAttempts: allAttempts.length,
      contaminatedAttempts: retryAttempts.length,
      rate: allAttempts.length > 0 ? retryAttempts.length / allAttempts.length : null,
      providerSendBytes: sum(retryAttempts.map((attempt) => attempt.providerSendBytes)),
      bytesPerRepetition: range(all.map((item) => sum(item.agentAttempts
        .filter((attempt) => attempt.eligibility === "retry_contaminated")
        .map((attempt) => attempt.providerSendBytes)))),
    },
    unarmedPhysicalOverhead: {
      auxiliary: aggregateOverhead(all, "auxiliary"),
      title: aggregateOverhead(all, "title"),
      toolProvider: aggregateOverhead(all, "toolProvider"),
    },
    work: {
      observedAcceptedRepetitions: accepted.filter((item) => item.work.observed).length,
      completedAcceptedRepetitions: accepted.filter((item) =>
        item.work.status === "completed").length,
      acceptedPlanReviews: accepted.filter((item) =>
        item.work.planReviewVerdict === "accept").length,
      acceptedResultReviews: accepted.filter((item) =>
        item.work.resultReviewVerdict === "accept").length,
      acceptedCompletionValidations: accepted.filter((item) =>
        item.work.completionValidationVerdict === "accept").length,
      projectLedgerCloseouts: accepted.filter((item) =>
        item.work.projectLedgerCloseoutObserved).length,
      duplicateEvidenceCount: sumNullable(all.map((item) =>
        item.work.duplicateEvidenceCount)),
      lostCorrectionEvidenceCount: sumNullable(all.map((item) =>
        item.work.lostCorrectionEvidenceCount)),
      lostRequiredAnchorCount: sumNullable(all.map((item) =>
        item.work.lostRequiredAnchorCount)),
      workspaceAuthorityFailures: sumNullable(all.map((item) =>
        item.work.workspaceAuthorityPassed === null
          ? null
          : Number(!item.work.workspaceAuthorityPassed))),
      providerRoutingFailures: sumNullable(all.map((item) =>
        item.work.providerRoutingPassed === null
          ? null
          : Number(!item.work.providerRoutingPassed))),
      stalledRepetitions: sumNullable(all.map((item) =>
        item.work.stallObserved === null ? null : Number(item.work.stallObserved))),
    },
    segmentProviderSendBytes: segments,
  };
}

function repetitionUsage(
  repetition: M1V2RepetitionResult,
  key: typeof USAGE_KEYS[number],
): number | null {
  if (repetition.agentAttempts.length === 0) return null;
  const values = repetition.agentAttempts.map((attempt) => attempt[key]);
  return values.every((value): value is number => value !== null)
    ? sum(values)
    : null;
}

function nullableRange(values: Array<number | null>): M1V2NullableRange {
  const available = values.filter((value): value is number => value !== null);
  return {
    available: available.length,
    unavailable: values.length - available.length,
    ...range(available),
  };
}

function aggregateOverhead(
  repetitions: M1V2RepetitionResult[],
  kind: keyof M1V2RepetitionResult["unarmedPhysicalOverhead"],
) {
  const rows = repetitions.map((item) => item.unarmedPhysicalOverhead[kind]);
  return {
    attempts: sum(rows.map((row) => row.attempts)),
    providerSendBytes: sum(rows.map((row) => row.providerSendBytes)),
    bytesPerRepetition: range(rows.map((row) => row.providerSendBytes)),
  };
}

function sumNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : sum(values as number[]);
}

function range(values: number[]): { median: number | null; min: number | null; max: number | null } {
  if (values.length === 0) return { median: null, min: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  return { median, min: sorted[0]!, max: sorted.at(-1)! };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
