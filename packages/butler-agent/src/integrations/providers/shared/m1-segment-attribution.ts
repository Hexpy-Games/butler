import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordOperationalMetric } from "../../../operations/metrics/operational-metrics.ts";
import { serializeM1RequestPartition } from "./m1-request-partition.ts";
import type {
  M1AttemptEligibility,
  M1ProviderAttemptObservation,
  M1RequestEnvelopeObservation,
  M1RequestSegmentKind,
  M1ProviderRequestSegmentManifestEntry,
  M1ResponseUsageObservation,
  M1SegmentStability,
} from "../../../agent/btcc/ports/provider-request-attribution.ts";
import {
  loadPrivateInstallationKey,
  privateInstallationDigest,
} from "./private-installation-identity.ts";

export const M1_PHYSICAL_ATTEMPT_HEADER = "x-butler-m1-physical-attempt";

const FLAG_NAME = "BUTLER_M1_V2_SEGMENT_ATTRIBUTION";
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const finalizedObservations = new WeakSet<M1ProviderAttemptObservation>();

export function isM1SegmentAttributionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUE_VALUES.has(env[FLAG_NAME]?.trim().toLowerCase() ?? "");
}

export function observeM1ProviderAttempt(input: {
  providerId: string;
  modelRef: string;
  body: Record<string, unknown>;
  turnId?: string;
  phase?: string;
  roundIndex: number;
  routeTransportAttemptOrdinal: number;
  providerRetryOrdinal: number;
  estimatedInputTokens?: number | null;
  eligibility?: M1AttemptEligibility;
  segmentManifest?: readonly M1ProviderRequestSegmentManifestEntry[];
  armId?: string;
  cacheBoundaryRevision?: string;
  butlerData?: string;
  env?: Record<string, string | undefined>;
  deferRecord?: boolean;
}): { serializedRequest: string; observation: M1ProviderAttemptObservation | null } {
  const serializedRequest = JSON.stringify(input.body);
  const env = input.env ?? process.env;
  if (!isM1SegmentAttributionEnabled(env)) {
    return { serializedRequest, observation: null };
  }

  try {
    const butlerData = input.butlerData || env.BUTLER_DATA || join(homedir(), ".butler");
    const key = loadPrivateInstallationKey(butlerData);
    const partition = serializeM1RequestPartition(
      input.body,
      input.segmentManifest,
    );
    if (partition.serialized !== serializedRequest) {
      return { serializedRequest, observation: null };
    }
    const requestDigest = privateInstallationDigest(key, "m1-attribution-v1", serializedRequest);
    const attemptDigest = privateInstallationDigest(
      key,
      "m1-attribution-v1",
      [input.providerId, input.modelRef, input.turnId ?? "", input.phase ?? "", input.roundIndex,
        input.routeTransportAttemptOrdinal, input.providerRetryOrdinal,
        randomUUID(), requestDigest].join("\u0000"),
    );
    const segments = [...partition.parts.entries()].map(([identity, part], index) => {
      const [kind, stability] = identity.split("\u0000") as [M1RequestSegmentKind, M1SegmentStability];
      return {
        schemaVersion: "butler.m1-request-segment.v2" as const,
        attemptDigest,
        segmentId: `segment-${String(index + 1).padStart(2, "0")}-${kind}`,
        kind,
        stability,
        providerSendBytes: part.bytes,
        estimatedInputTokens: null,
        keyedContentDigest: privateInstallationDigest(
          key, "m1-attribution-v1", part.serializedFragments.join(""),
        ),
      };
    });
    const envelope: M1RequestEnvelopeObservation = {
      schemaVersion: "butler.m1-request-envelope.v2",
      attemptDigest,
      turnDigest: privateInstallationDigest(key, "m1-attribution-v1", input.turnId ?? "unattributed"),
      phaseDigest: privateInstallationDigest(key, "m1-attribution-v1", input.phase ?? "unattributed"),
      roundIndex: nonNegativeInteger(input.roundIndex),
      retryOrdinal: combinedRetryOrdinal(
        input.routeTransportAttemptOrdinal,
        input.providerRetryOrdinal,
      ),
      providerId: boundedIdentifier(input.providerId, "unknown"),
      modelRef: boundedIdentifier(input.modelRef, "unknown"),
      armId: optionalIdentifier(input.armId),
      sourceRevision: optionalRevision(env.BUTLER_M1_SOURCE_REVISION),
      cacheBoundaryRevision: boundedIdentifier(
        input.cacheBoundaryRevision ?? "current",
        "current",
      ),
      providerSendBytes: Buffer.byteLength(serializedRequest, "utf8"),
      estimatedInputTokens: nullableNonNegativeInteger(input.estimatedInputTokens),
      eligibility: input.eligibility ?? (
        input.routeTransportAttemptOrdinal > 0 || input.providerRetryOrdinal > 0
          ? "retry_contaminated"
          : "eligible"
      ),
    };
    const observation = { envelope, segments };
    if (!input.deferRecord) recordRequestObservation(observation, butlerData, env);
    return { serializedRequest, observation };
  } catch {
    return { serializedRequest, observation: null };
  }
}

function combinedRetryOrdinal(routeOrdinal: number, providerOrdinal: number): number {
  return nonNegativeInteger(routeOrdinal) * 1_000_000 + nonNegativeInteger(providerOrdinal);
}

export function finalizeM1ProviderAttempt(input: {
  observation: M1ProviderAttemptObservation | null;
  eligibility: M1AttemptEligibility;
  butlerData?: string;
  env?: Record<string, string | undefined>;
}): void {
  if (!input.observation) return;
  if (finalizedObservations.has(input.observation)) return;
  finalizedObservations.add(input.observation);
  try {
    input.observation.envelope.eligibility = input.eligibility;
    recordRequestObservation(
      input.observation,
      input.butlerData || input.env?.BUTLER_DATA || process.env.BUTLER_DATA || join(homedir(), ".butler"),
      input.env ?? process.env,
    );
  } catch {
    // Observation is best effort and cannot affect provider dispatch.
  }
}

export function recordM1ResponseUsage(input: {
  attemptDigest: string | undefined;
  response: unknown;
  butlerData?: string;
  env?: Record<string, string | undefined>;
}): void {
  const env = input.env ?? process.env;
  if (!input.attemptDigest || !isM1SegmentAttributionEnabled(env)) return;
  try {
    const usage = responseUsage(input.response);
    const row: M1ResponseUsageObservation = {
      schemaVersion: "butler.m1-response-usage.v2",
      attemptDigest: input.attemptDigest,
      status: usage ? "usage_bearing" : "unavailable",
      promptTokens: usage?.promptTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
    };
    recordOperationalMetric({
      category: "context",
      name: "m1_v2_response_usage",
      status: "ok",
      value: row.totalTokens ?? undefined,
      unit: "tokens",
      dimensions: { ...row },
    }, { butlerData: input.butlerData, env });
  } catch {
    // Observation is best effort and cannot affect provider result handling.
  }
}

function recordRequestObservation(
  observation: M1ProviderAttemptObservation,
  butlerData: string,
  env: Record<string, string | undefined>,
): void {
  recordOperationalMetric({
    category: "context",
    name: "m1_v2_request_envelope",
    status: "ok",
    value: observation.envelope.providerSendBytes,
    unit: "bytes",
    dimensions: { ...observation.envelope },
  }, { butlerData, env });
  for (const segment of observation.segments) {
    recordOperationalMetric({
      category: "context",
      name: "m1_v2_request_segment",
      status: "ok",
      value: segment.providerSendBytes,
      unit: "bytes",
      dimensions: { ...segment },
    }, { butlerData, env });
  }
}

function responseUsage(response: unknown): {
  promptTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
} | null {
  if (!response || typeof response !== "object") return null;
  const usage = (response as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const row = usage as Record<string, unknown>;
  const inputDetails = objectValue(row.input_tokens_details ?? row.prompt_tokens_details);
  const outputDetails = objectValue(row.output_tokens_details ?? row.completion_tokens_details);
  return {
    promptTokens: nullableNonNegativeInteger(row.input_tokens ?? row.prompt_tokens),
    cacheReadTokens: nullableNonNegativeInteger(inputDetails?.cached_tokens),
    cacheWriteTokens: nullableNonNegativeInteger(inputDetails?.cache_write_tokens),
    outputTokens: nullableNonNegativeInteger(row.output_tokens ?? row.completion_tokens),
    reasoningTokens: nullableNonNegativeInteger(outputDetails?.reasoning_tokens),
    totalTokens: nullableNonNegativeInteger(row.total_tokens),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number {
  return nullableNonNegativeInteger(value) ?? 0;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function boundedIdentifier(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/u.test(trimmed) ? trimmed : fallback;
}

function optionalIdentifier(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const bounded = boundedIdentifier(value, "");
  return bounded || null;
}

function optionalRevision(value: string | undefined): string | null {
  const revision = value?.trim();
  return revision && /^[a-f0-9]{7,64}$/iu.test(revision) ? revision : null;
}
