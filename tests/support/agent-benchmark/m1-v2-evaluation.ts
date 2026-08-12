import { OBSERVED_M1_REQUEST_SEGMENT_KINDS, POTENTIALLY_REDUCIBLE_M1_SEGMENTS, type M1RequestSegmentKind } from
  "./m1-v2-types.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type {
  M1V2AssessmentInput,
  M1V2AttemptSummary,
  M1V2QualitySummary,
  M1V2RepetitionResult,
} from "./m1-v2-types.ts";
import {
  firstUsefulMs,
  summarizePhysicalRequests,
  summarizeWorkEvidence,
} from "./m1-v2-evidence-summary.ts";
import { applyM1V2StabilityReasons } from "./m1-v2-stability.ts";

export function assessM1V2Repetition(
  input: M1V2AssessmentInput,
): M1V2RepetitionResult {
  const reasons: string[] = [];
  const evidenceOk = input.evidence.ok === true;
  if (!evidenceOk) reasons.push("product_evidence_not_ok");
  const observations = recordArray(input.evidence.observations);
  const target = observations.find((row) => row.stepId === input.targetStepId);
  if (!target) reasons.push("target_step_missing");
  const submittedAtMs = numberValue(recordValue(target?.timing)?.submittedAtMs);
  const terminalAtMs = numberValue(recordValue(target?.timing)?.terminalAtMs);
  const terminalState = stringValue(target?.terminalState);
  if (terminalState !== "delivered") reasons.push("target_not_delivered");
  const reload = recordValue(target?.reload);
  const reloadPassed = reload?.tested === true && reload.finalMatched === true;
  if (!reloadPassed) reasons.push("reload_failed_or_unmeasured");

  const intervalMetrics = input.metrics.filter((event) =>
    submittedAtMs !== null && terminalAtMs !== null &&
    event.ts >= submittedAtMs && event.ts <= terminalAtMs + 5_000);
  const envelopes = intervalMetrics.filter((event) =>
    event.name === "m1_v2_request_envelope" &&
    event.dimensions?.armId === input.armId);
  if (envelopes.length === 0) reasons.push("agent_attempt_missing");
  if (input.sourceRevision && envelopes.some((event) =>
    event.dimensions?.sourceRevision !== input.sourceRevision)) {
    reasons.push("source_revision_identity_mismatch");
  }
  const duplicateAttempts = duplicateValues(envelopes.map((event) =>
    stringValue(event.dimensions?.attemptDigest)).filter(Boolean) as string[]);
  if (duplicateAttempts.length > 0) reasons.push("duplicate_request_envelope");
  const attempts = envelopes.map((envelope) => summarizeAttempt(
    envelope,
    intervalMetrics,
    reasons,
  ));
  const totalBytes = sum(attempts.map((attempt) => attempt.providerSendBytes));
  const otherBytes = sum(attempts.map((attempt) =>
    attempt.segments.other_typed_context ?? 0));
  const reducibleBytes = sum(attempts.map((attempt) =>
    sum(Object.entries(attempt.segments)
      .filter(([kind]) => POTENTIALLY_REDUCIBLE_M1_SEGMENTS.has(kind as M1RequestSegmentKind))
      .map(([, bytes]) => bytes ?? 0))));
  const otherShare = totalBytes > 0 ? otherBytes / totalBytes : null;
  const reducibleShare = totalBytes > 0 ? reducibleBytes / totalBytes : null;
  if (otherShare !== null && otherShare > 0.02) {
    reasons.push("other_typed_context_above_2_percent");
  }

  const providerRequests = recordArray(input.evidence.providerRequests);
  const allEnvelopes = intervalMetrics.filter((event) =>
    event.name === "m1_v2_request_envelope");
  const physical = summarizePhysicalRequests(
    providerRequests,
    allEnvelopes,
    input.armId,
    target ?? {},
  );
  if (physical.unmatchedEnvelopeDigests.length > 0 ||
    physical.unmatchedRequestOrdinals.length > 0 ||
    physical.invalidRequestIdentityCount > 0 ||
    physical.duplicateEnvelopeDigests.length > 0) {
    reasons.push("physical_attempt_identity_join_failed");
  }
  const db = input.db ?? null;
  if (!db) reasons.push("database_evidence_missing");
  if (db && !db.quickCheckPassed) reasons.push("database_quick_check_failed");
  const finalText = stringValue(target?.finalText) ?? "";
  const quality = qualitySummary(input, finalText, attempts);
  applyQualityReasons(input.armId, quality, db, reasons);
  const firstUseful = firstUsefulMs(
    physical.targetAgentRequests,
    target,
    submittedAtMs,
  );
  const work = summarizeWorkEvidence(target, terminalState, firstUseful, {
    db,
    evidence: input.evidence,
    expectedModel: "openai/gpt-5.6-sol",
  });
  applyM1V2StabilityReasons(input.armId, work, reasons);

  return {
    armId: input.armId,
    repetition: input.repetition ?? 0,
    status: reasons.length === 0 ? "accepted" : "rejected",
    reasons: [...new Set(reasons)],
    targetTerminalState: terminalState,
    agentAttempts: attempts,
    auxiliaryPhysicalAttempts: physical.auxiliary.attempts,
    titlePhysicalAttempts: physical.title.attempts,
    providerToolPhysicalAttempts: physical.toolProvider.attempts,
    unarmedPhysicalOverhead: {
      auxiliary: physical.auxiliary,
      title: physical.title,
      toolProvider: physical.toolProvider,
    },
    otherShare,
    reducibleShare,
    semanticRounds: new Set(envelopes.map((event) =>
      numberValue(event.dimensions?.roundIndex)).filter((value) => value !== null)).size,
    toolCalls: db?.toolCalls ?? 0,
    elapsedMs: numberValue(recordValue(target?.timing)?.elapsedMs),
    firstUsefulMs: firstUseful,
    reloadPassed,
    quality,
    db,
    work,
  };
}

function summarizeAttempt(
  envelopeEvent: OperationalMetricEvent,
  events: OperationalMetricEvent[],
  reasons: string[],
): M1V2AttemptSummary {
  const envelope = envelopeEvent.dimensions ?? {};
  const attemptDigest = stringValue(envelope.attemptDigest);
  const segmentEvents = events.filter((event) =>
    event.name === "m1_v2_request_segment" &&
    event.dimensions?.attemptDigest === attemptDigest);
  const usageEvents = events.filter((event) =>
    event.name === "m1_v2_response_usage" &&
    event.dimensions?.attemptDigest === attemptDigest);
  if (usageEvents.length > 1) reasons.push("duplicate_response_usage");
  const segmentIds = segmentEvents.map((event) =>
    stringValue(event.dimensions?.segmentId)).filter(Boolean) as string[];
  if (duplicateValues(segmentIds).length > 0) reasons.push("duplicate_request_segment");
  const segments: Partial<Record<M1RequestSegmentKind, number>> = {};
  for (const event of segmentEvents) {
    const kind = stringValue(event.dimensions?.kind);
    const bytes = numberValue(event.dimensions?.providerSendBytes);
    if (!kind || !OBSERVED_M1_REQUEST_SEGMENT_KINDS.includes(kind as M1RequestSegmentKind) || bytes === null) {
      reasons.push("invalid_request_segment");
      continue;
    }
    segments[kind as M1RequestSegmentKind] =
      (segments[kind as M1RequestSegmentKind] ?? 0) + bytes;
  }
  const providerSendBytes = numberValue(envelope.providerSendBytes) ?? 0;
  const segmentSendBytes = sum(Object.values(segments).map((value) => value ?? 0));
  const exactByteSum = segmentSendBytes === providerSendBytes;
  if (!exactByteSum) reasons.push("exact_byte_sum_failed");
  const eligibility = stringValue(envelope.eligibility) ?? "missing";
  if (eligibility !== "eligible") {
    reasons.push(eligibility === "retry_contaminated"
      ? "retry_contaminated"
      : `ineligible_${eligibility}`);
  }
  const usage = usageEvents[0]?.dimensions;
  const usageStatus = usage?.status === "usage_bearing"
    ? "usage_bearing"
    : "unavailable";
  return {
    exactByteSum,
    providerSendBytes,
    segmentSendBytes,
    retryOrdinal: numberValue(envelope.retryOrdinal) ?? 0,
    eligibility,
    providerId: stringValue(envelope.providerId),
    modelRef: stringValue(envelope.modelRef),
    sourceRevision: stringValue(envelope.sourceRevision),
    cacheBoundaryRevision: stringValue(envelope.cacheBoundaryRevision),
    responseUsageStatus: usageStatus,
    promptTokens: nullableMetric(usage?.promptTokens),
    cacheReadTokens: nullableMetric(usage?.cacheReadTokens),
    cacheWriteTokens: nullableMetric(usage?.cacheWriteTokens),
    outputTokens: nullableMetric(usage?.outputTokens),
    reasoningTokens: nullableMetric(usage?.reasoningTokens),
    totalTokens: nullableMetric(usage?.totalTokens),
    otherShare: providerSendBytes > 0
      ? (segments.other_typed_context ?? 0) / providerSendBytes
      : 0,
    segments,
  };
}

function qualitySummary(
  input: M1V2AssessmentInput,
  finalText: string,
  attempts: M1V2AttemptSummary[],
): M1V2QualitySummary {
  if (input.armId === "direct-cold" || input.armId === "direct-warm") {
    const normalized = finalText.replace(/\s+/gu, " ").trim();
    const sentenceMarks = normalized.match(/[.!?。！？]+/gu)?.length ?? 0;
    return {
      conciseGreeting: normalized.length > 0 && normalized.length <= 160 && sentenceMarks <= 1,
      fixedDatePresent: null,
      umbrellaRecommendationPresent: null,
      sourceReferenceCount: null,
      sourceGrounded: null,
      landing: null,
    };
  }
  if (input.armId === "current-web-cold") {
    const sourceReferenceCount = finalText.match(/https?:\/\//giu)?.length ?? 0;
    const sourceBytes = sum(attempts.map((attempt) =>
      attempt.segments.source_reference ?? 0));
    return {
      conciseGreeting: null,
      fixedDatePresent: /2026\s*(?:년|[-./])\s*0?8\s*(?:월|[-./])\s*10/u.test(finalText),
      umbrellaRecommendationPresent: /우산/u.test(finalText) &&
        /(필요|불필요|챙기|권장|안\s*가져|가져)/u.test(finalText),
      sourceReferenceCount,
      sourceGrounded: sourceReferenceCount > 0 && sourceBytes > 0 &&
        (input.db?.webToolCalls ?? 0) > 0,
      landing: null,
    };
  }
  return {
    conciseGreeting: null,
    fixedDatePresent: null,
    umbrellaRecommendationPresent: null,
    sourceReferenceCount: null,
    sourceGrounded: null,
    landing: input.landingValidation ?? null,
  };
}

function applyQualityReasons(
  armId: M1V2AssessmentInput["armId"],
  quality: M1V2QualitySummary,
  db: M1V2AssessmentInput["db"],
  reasons: string[],
): void {
  if ((armId === "direct-cold" || armId === "direct-warm") &&
    quality.conciseGreeting !== true) reasons.push("direct_quality_failed");
  if (armId === "current-web-cold") {
    if (quality.fixedDatePresent !== true) reasons.push("fixed_date_missing");
    if (quality.umbrellaRecommendationPresent !== true) {
      reasons.push("umbrella_recommendation_missing");
    }
    if (quality.sourceGrounded !== true) reasons.push("source_evidence_missing");
  }
  if (armId === "landing-cold") {
    const landing = quality.landing;
    if (!landing || Object.entries(landing).some(([key, value]) => {
      if (key === "approvedCapabilityClaims") return false;
      return key === "featureBlockCount" ? Number(value) < 3 : value !== true;
    }) || landing.approvedCapabilityClaims.length !== 5 ||
      landing.approvedCapabilityClaims.some((claim) => !claim.passed)) {
      reasons.push("landing_quality_or_visual_gate_failed");
    }
    if (!db || db.pagePreviewToolCalls < 1 || db.buildCommandToolCalls < 1 ||
      db.fileMutationToolCalls < 1) reasons.push("landing_product_tool_evidence_missing");
  }
}
function nullableMetric(value: unknown): number | null {
  return value === null ? null : numberValue(value);
}
function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}
