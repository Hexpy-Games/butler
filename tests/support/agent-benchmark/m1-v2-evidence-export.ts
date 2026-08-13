import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { OperationalMetricEvent } from "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { BenchmarkArmPlan, BenchmarkFixture } from "./contracts.ts";
import { M1_V2_ARM_IDS, OBSERVED_M1_REQUEST_SEGMENT_KINDS, POTENTIALLY_REDUCIBLE_M1_SEGMENTS, type M1RequestSegmentKind, type M1V2ArmId, type M1V2AttemptSummary } from "./m1-v2-types.ts";
import { isAgentSc01Role, isPhysicalRequestRole, physicalAttemptDigest, physicalRequestEnvelopeMatches, physicalRequestIdentityMatches, terminalStatusMatchesProviderStatus, type PhysicalRequestRole } from "./physical-request-identity.ts";
import { createM1V2DurableAuthority, publishM1V2DurableAuthority, readM1V2DurableAuthority } from "./m1-v2-durable-authority.ts";

const SCHEMA = "butler.agent-benchmark.sc01-public-evidence.v2" as const;
const FILE = "sc01-public-evidence.json";
const TEMP = `${FILE}.tmp`;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL_STATUS = new Set(["cancelled", "completed", "failed"]);
const ELIGIBILITY = new Set(["eligible", "usage_unavailable", "retry_contaminated", "cache_mismatch", "rejected"]);

export interface M1V2EvidenceExportIdentity {
  planIdentity: string; sourceRevision: string; fixtureHash: string; armKey: string;
  armId: M1V2ArmId; repetition: number; block: number | null; stepId: string;
  version: "before" | "after" | null; pairId: string | null; armOrder: number;
  sessionId: string; turnId: string;
  expectedProviderId: "openai-codex" | "openai"; expectedModelRef: string;
  expectedRouteId: "openai-codex-responses" | "openai-responses"; expectedCacheBoundaryRevision: string | null;
  membershipSha256: string;
}

type M1V2EvidenceMaterializationIdentity = Omit<M1V2EvidenceExportIdentity, "membershipSha256"> & {
  membershipSha256: null;
};

export interface M1V2EvidenceExport {
  schema: typeof SCHEMA;
  identity: M1V2EvidenceExportIdentity;
  attempts: Array<{
    ordinal: number; role: "agent"; ownership: "target_step" | "other_step"; stepId: string; sessionId: string; turnId: string;
    attemptDigest: string; requestStartedAtMs: number;
    terminatedAtMs: number; durationMs: number; terminalStatus: string; providerStatus: number | null;
    routeId: "openai-codex-responses" | "openai-responses";
    requestedModel: string; providerReportedModel: string | null; requestedReasoning: "medium"; authorizationScheme: "bearer";
    requestedServiceTierMode: "auto_by_omission"; effectiveServiceTier: string | null;
    effectiveServiceTierAvailability: "reported" | "unavailable";
    effectiveServiceTierReason: "provider_response_reported" | "provider_response_omitted";
    serializerContract: "butler.openai-codex-final-json.v1" | "butler.openai-responses-final-json.v1";
    serializedRequestBytes: number; serializedRequestDigest: string; serializedRequestDigestAlgorithm: "hmac-sha256-observer-private-v1";
    envelope: Record<string, string | number | boolean | null>;
    segments: Array<Record<string, string | number | boolean | null>>;
    usage: Record<string, string | number | boolean | null>;
  }>;
  overhead: Array<{ ordinal: number; role: "auxiliary" | "title" | "tool_provider"; ownership: "target_step" | "other_step" | "unarmed_physical_overhead";
    stepId: string | null; sessionId: string | null; turnId: string | null; attemptDigest: string; armed: false; armId: null; providerSendBytes: number;
    requestStartedAtMs: number; terminatedAtMs: number; durationMs: number; terminalStatus: string;
    providerStatus: number | null; routeId: "openai-codex-responses" | "openai-responses";
    requestedModel: string | null; providerReportedModel: string | null; requestedReasoning: string | null; authorizationScheme: string | null;
    requestedServiceTierMode: "auto_by_omission"; effectiveServiceTier: string | null;
    effectiveServiceTierAvailability: "reported" | "unavailable"; effectiveServiceTierReason: "provider_response_reported" | "provider_response_omitted";
    serializerContract: "butler.openai-codex-final-json.v1" | "butler.openai-responses-final-json.v1"; serializedRequestDigest: string; serializedRequestDigestAlgorithm: "hmac-sha256-observer-private-v1" }>;
  counts: { attempts: number; segments: number; canonicalUsageRows: number; projectedUsage: number; overhead: number };
  retention: { owner: "agent-benchmark-run"; cleanup: "with-run-evidence" };
  contentSha256: string;
}

export function materializeM1V2EvidenceExport(input: {
  runRoot: string; evidenceRoot: string; identity: M1V2EvidenceMaterializationIdentity;
  target: Record<string, unknown>; observations: Record<string, unknown>[]; providerRequests: Record<string, unknown>[];
  metrics: OperationalMetricEvent[];
}): { absolutePath: string; handle: string; sha256: string; evidence: M1V2EvidenceExport } {
  assertSafeEvidenceRoot(input.runRoot, input.evidenceRoot);
  const absolutePath = join(resolve(input.evidenceRoot), FILE);
  const tempPath = join(resolve(input.evidenceRoot), TEMP);
  const handle = safeHandle(input.runRoot, absolutePath);
  if (existsSync(tempPath)) throw new Error("sc01_export_temporary_state_conflict");
  const evidence = buildExport(input);
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const sha256 = digest(bytes);
  publishM1V2DurableAuthority(input.runRoot, createM1V2DurableAuthority({ handle, sha256, identity: evidence.identity }));
  if (existsSync(absolutePath)) {
    const current = readFileSync(absolutePath, "utf8");
    if (current !== bytes) throw new Error("sc01_export_immutable_conflict");
    const verified = verifyM1V2EvidenceExport({ path: absolutePath, expected: evidence.identity });
    return { absolutePath, handle, sha256: verified.sha256, evidence: verified.evidence };
  }
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd); closeSync(fd); fd = null;
    linkSync(tempPath, absolutePath);
    unlinkSync(tempPath);
    const directory = openSync(resolve(input.evidenceRoot), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
  const verified = verifyM1V2EvidenceExport({ path: absolutePath, expected: evidence.identity });
  return { absolutePath, handle, sha256: verified.sha256, evidence: verified.evidence };
}

export { hasM1V2DurableAuthority } from "./m1-v2-durable-authority.ts";

export function recoverM1V2DurableProjection(input: {
  planIdentity: string; runRoot: string; arm: BenchmarkArmPlan; fixture: BenchmarkFixture;
}) {
  const authority = readM1V2DurableAuthority({ runRoot: input.runRoot, planIdentity: input.planIdentity, armKey: input.arm.key });
  return verifyM1V2DurableProjection({ ...input, target: {
    sessionId: authority.identity.sessionId, turnId: authority.identity.turnId,
  }, durable: { handle: authority.handle, sha256: authority.sha256, identity: authority.identity } });
}

export function verifyM1V2EvidenceExport(input: { path: string; expected: M1V2EvidenceExportIdentity }) {
  if (hasSymlinkComponent(input.path)) throw new Error("sc01_export_symlink_rejected");
  const stat = lstatSync(input.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("sc01_export_file_invalid");
  const text = readFileSync(input.path, "utf8");
  const value = JSON.parse(text) as M1V2EvidenceExport;
  assertExactKeys(value, ["schema", "identity", "attempts", "overhead", "counts", "retention", "contentSha256"]);
  assertIdentity(value.identity);
  if (value.schema !== SCHEMA || JSON.stringify(value.identity) !== JSON.stringify(input.expected)) throw new Error("sc01_export_identity_mismatch");
  const contentSha256 = digest({ ...value, contentSha256: "" });
  if (value.contentSha256 !== contentSha256) throw new Error("sc01_export_content_hash_mismatch");
  if (value.counts.attempts !== value.attempts.length || value.counts.overhead !== value.overhead.length ||
      value.counts.segments !== value.attempts.reduce((sum, row) => sum + row.segments.length, 0) || value.counts.projectedUsage !== value.attempts.length ||
      value.counts.canonicalUsageRows !== value.attempts.filter((row) => row.usage.availabilityReason !== "provider_usage_row_absent").length) {
    throw new Error("sc01_export_count_mismatch");
  }
  assertExportRows(value);
  assertExactKeys(value.counts, ["attempts", "segments", "canonicalUsageRows", "projectedUsage", "overhead"]);
  assertExactKeys(value.retention, ["owner", "cleanup"]);
  if (value.retention.owner !== "agent-benchmark-run" || value.retention.cleanup !== "with-run-evidence") throw new Error("sc01_export_retention_invalid");
  assertNoUnsafeMaterial(value);
  return { evidence: value, sha256: digest(text) };
}

export function verifyM1V2DurableProjection(input: {
  planIdentity: string; runRoot: string; arm: BenchmarkArmPlan; fixture: BenchmarkFixture;
  target: { sessionId: string; turnId: string };
  durable: { handle: string; sha256: string; identity: M1V2EvidenceExportIdentity };
}) {
  const m1 = input.fixture.m1V2;
  if (!m1) throw new Error("sc01_export_fixture_identity_missing");
  const identity: M1V2EvidenceExportIdentity = {
    planIdentity: input.planIdentity, sourceRevision: input.arm.sourceRevision, fixtureHash: input.arm.fixtureHash,
    armKey: input.arm.key, armId: m1.armId, repetition: input.arm.repetition, block: input.arm.block ?? null,
    stepId: m1.targetStepId, version: input.arm.version ?? null, pairId: input.arm.pairId ?? null, armOrder: input.arm.order,
    sessionId: input.target.sessionId, turnId: input.target.turnId, expectedProviderId: "openai-codex",
    expectedModelRef: m1.scenario.model!, expectedRouteId: "openai-codex-responses",
    expectedCacheBoundaryRevision: m1.scenario.cacheBoundaryEvidence?.expectedRevision ?? "current",
    membershipSha256: input.durable.identity.membershipSha256,
  };
  if (JSON.stringify(input.durable.identity) !== JSON.stringify(identity)) throw new Error("sc01_export_durable_identity_mismatch");
  const path = join(resolve(input.arm.evidenceRoot), FILE);
  const handle = safeHandle(input.runRoot, path);
  if (input.durable.handle !== handle || isAbsolute(input.durable.handle) || resolve(input.runRoot, input.durable.handle) !== path) throw new Error("sc01_export_handle_mismatch");
  const verified = verifyM1V2EvidenceExport({ path, expected: identity });
  if (!SHA256.test(input.durable.sha256) || verified.sha256 !== input.durable.sha256) throw new Error("sc01_export_manifest_hash_mismatch");
  return { ...verified, path, handle, identity, arithmetic: durableM1V2Arithmetic(verified.evidence) };
}

export function exportedM1V2Metrics(evidence: M1V2EvidenceExport): OperationalMetricEvent[] {
  return evidence.attempts.filter((attempt) => attempt.ownership === "target_step").flatMap((attempt) => {
    const envelope = { ...attempt.envelope }; const ts = integer(envelope.observedAtMs); delete envelope.observedAtMs;
    if (attempt.effectiveServiceTier !== "default") envelope.eligibility = "rejected";
    return [metricRow("m1_v2_request_envelope", ts, envelope),
      ...attempt.segments.map((segment) => { const row = { ...segment }; delete row.order; delete row.byteLength; return metricRow("m1_v2_request_segment", ts, row); }),
      (() => { const row = { ...attempt.usage }; delete row.availabilityReason; return metricRow("m1_v2_response_usage", ts, row); })()];
  });
}

export function durableM1V2Arithmetic(evidence: M1V2EvidenceExport): {
  agentAttempts: M1V2AttemptSummary[]; otherShare: number | null; reducibleShare: number | null; semanticRounds: number;
  auxiliaryPhysicalAttempts: number; titlePhysicalAttempts: number; providerToolPhysicalAttempts: number;
  unarmedPhysicalOverhead: { auxiliary: { attempts: number; providerSendBytes: number }; title: { attempts: number; providerSendBytes: number }; toolProvider: { attempts: number; providerSendBytes: number } };
} {
  const agentAttempts = evidence.attempts.filter((row) => row.ownership === "target_step").map((attempt) => {
    const segments: Partial<Record<M1RequestSegmentKind, number>> = {};
    for (const segment of attempt.segments) {
      const kind = segment.kind as M1RequestSegmentKind;
      segments[kind] = (segments[kind] ?? 0) + Number(segment.providerSendBytes);
    }
    const segmentSendBytes = Object.values(segments).reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
    const eligibility = attempt.effectiveServiceTier === "default" ? String(attempt.envelope.eligibility) : "rejected";
    return { exactByteSum: segmentSendBytes === attempt.serializedRequestBytes, providerSendBytes: attempt.serializedRequestBytes, segmentSendBytes,
      retryOrdinal: Number(attempt.envelope.retryOrdinal), eligibility, providerId: String(attempt.envelope.providerId), modelRef: String(attempt.envelope.modelRef),
      sourceRevision: String(attempt.envelope.sourceRevision), cacheBoundaryRevision: attempt.envelope.cacheBoundaryRevision as string | null,
      responseUsageStatus: attempt.usage.status as "unavailable" | "usage_bearing", promptTokens: attempt.usage.promptTokens as number | null,
      cacheReadTokens: attempt.usage.cacheReadTokens as number | null, cacheWriteTokens: attempt.usage.cacheWriteTokens as number | null,
      outputTokens: attempt.usage.outputTokens as number | null, reasoningTokens: attempt.usage.reasoningTokens as number | null,
      totalTokens: attempt.usage.totalTokens as number | null, otherShare: attempt.serializedRequestBytes > 0 ? (segments.other_typed_context ?? 0) / attempt.serializedRequestBytes : 0, segments };
  });
  const total = agentAttempts.reduce((sum, row) => sum + row.providerSendBytes, 0);
  const other = agentAttempts.reduce((sum, row) => sum + (row.segments.other_typed_context ?? 0), 0);
  const reducible = agentAttempts.reduce((sum, row) => sum + Object.entries(row.segments).filter(([kind]) => POTENTIALLY_REDUCIBLE_M1_SEGMENTS.has(kind as M1RequestSegmentKind)).reduce((subtotal, [, bytes]) => subtotal + (bytes ?? 0), 0), 0);
  const overhead = (role: "auxiliary" | "title" | "tool_provider") => {
    const rows = evidence.overhead.filter((row) => row.role === role);
    return { attempts: rows.length, providerSendBytes: rows.reduce((sum, row) => sum + row.providerSendBytes, 0) };
  };
  const auxiliary = overhead("auxiliary"), title = overhead("title"), toolProvider = overhead("tool_provider");
  return { agentAttempts, otherShare: total > 0 ? other / total : null, reducibleShare: total > 0 ? reducible / total : null,
    semanticRounds: new Set(evidence.attempts.filter((row) => row.ownership === "target_step").map((row) => row.envelope.roundIndex)).size,
    auxiliaryPhysicalAttempts: auxiliary.attempts, titlePhysicalAttempts: title.attempts, providerToolPhysicalAttempts: toolProvider.attempts,
    unarmedPhysicalOverhead: { auxiliary, title, toolProvider } };
}

function metricRow(name: string, ts: number, dimensions: Record<string, string | number | boolean | null>): OperationalMetricEvent {
  return { schema: "butler.operational-metric.v1", ts, category: "context", name, status: "ok", dimensions, rawTextStored: false };
}

function buildExport(input: Parameters<typeof materializeM1V2EvidenceExport>[0]): M1V2EvidenceExport {
  assertMaterializationIdentity(input.identity);
  const memberships: Record<string, unknown>[] = input.observations.flatMap((observation) => {
    if (!publicId(observation.stepId) || !publicId(observation.sessionId) || !publicId(observation.turnId)) throw new Error("sc01_export_observation_identity_invalid");
    return recordArray(observation.providerRequestIdentities).map((membership) => {
      if (membership.sessionId !== observation.sessionId || membership.turnId !== observation.turnId) throw new Error("sc01_export_membership_owner_identity_mismatch");
      return { ...membership, stepId: observation.stepId };
    });
  });
  memberships.forEach((row) => assertExactKeys(row, MEMBERSHIP));
  input.providerRequests.forEach((row) => assertExactKeys(row, PROVIDER));
  if (new Set(memberships.map((row) => integer(row.ordinal))).size !== memberships.length) throw new Error("sc01_export_membership_ambiguous");
  if (new Set(input.providerRequests.map((row) => integer(row.ordinal))).size !== input.providerRequests.length) throw new Error("sc01_export_provider_ordinal_ambiguous");
  const membershipDigests = memberships.map((row) => requiredDigest(row.physicalAttemptDigest));
  const providerDigests = input.providerRequests.map((row) => requiredDigest(row.attemptDigest));
  if (new Set(membershipDigests).size !== membershipDigests.length || new Set(providerDigests).size !== providerDigests.length) {
    throw new Error("sc01_export_attempt_digest_ambiguous");
  }
  const membershipByOrdinal = new Map(memberships.map((row) => [integer(row.ordinal), row]));
  const agentMemberships = memberships.filter((row) => row.requestKind === "agent");
  const nonAgentDigests = new Set(input.providerRequests.filter((row) => row.requestKind !== "agent").map((row) => requiredDigest(row.attemptDigest)));
  for (const metric of input.metrics) {
    const metricDigest = typeof metric.dimensions?.attemptDigest === "string" ? metric.dimensions.attemptDigest : null;
    if (!metricDigest || !nonAgentDigests.has(metricDigest)) continue;
    if (metric.name === "m1_v2_request_envelope" && metric.dimensions?.armId === input.identity.armId) {
      throw new Error("sc01_export_arm_tagged_non_agent_rejected");
    }
    if (metric.name === "m1_v2_request_envelope" || metric.name === "m1_v2_request_segment" || metric.name === "m1_v2_response_usage") {
      throw new Error("sc01_export_non_agent_sc01_evidence_invalid");
    }
  }
  const envelopes = input.metrics.filter((row) => row.name === "m1_v2_request_envelope" && row.dimensions?.armId === input.identity.armId);
  const attempts = envelopes.map((event) => {
    assertMetric(event, "envelope");
    const d = event.dimensions!; const attemptDigest = requiredDigest(d.attemptDigest);
    const candidates = input.providerRequests.filter((row) => row.attemptDigest === attemptDigest && row.requestKind === "agent" && membershipByOrdinal.has(integer(row.ordinal)));
    if (candidates.length !== 1) throw new Error("sc01_export_physical_attempt_join_failed");
    const request = candidates[0]!; const membership = membershipByOrdinal.get(integer(request.ordinal))!;
    const physical = projectPhysicalRequest(request, membership, input.identity.stepId);
    const requestedModel = normalizeRequestedModel(request.requestedModel, input.identity.expectedModelRef);
    if (request.requestedServiceTier !== null || request.requestedServiceTierMode !== "auto_by_omission" ||
        requestedModel !== input.identity.expectedModelRef || request.requestedReasoning !== "medium" || request.authorizationScheme !== "bearer") {
      throw new Error("sc01_export_provider_request_identity_mismatch");
    }
    const effectiveTier = physical.effectiveServiceTier;
    const terminalStatus = physical.terminalStatus;
    const providerReportedModel = request.providerReportedModel === null ? null : normalizeRequestedModel(request.providerReportedModel, input.identity.expectedModelRef);
    if (request.providerReportedModel !== null && providerReportedModel !== input.identity.expectedModelRef || terminalStatus === "completed" && providerReportedModel !== input.identity.expectedModelRef) {
      throw new Error("sc01_export_provider_response_model_mismatch");
    }
    if (physical.role !== "agent" || physical.attemptDigest !== attemptDigest || physical.ownership === "unarmed_physical_overhead") throw new Error("sc01_export_attempt_ownership_mismatch");
    const bytes = physical.providerSendBytes; const envelopeBytes = positiveInteger(d.providerSendBytes);
    if (bytes !== envelopeBytes || d.sourceRevision !== input.identity.sourceRevision ||
        !physicalRequestEnvelopeMatches(request, { physicalAttemptDigest: attemptDigest, providerSendBytes: envelopeBytes, observedAtMs: event.ts })) {
      throw new Error("sc01_export_provider_envelope_identity_mismatch");
    }
    const segments = input.metrics.filter((row) => row.name === "m1_v2_request_segment" && row.dimensions?.attemptDigest === attemptDigest)
      .map((row, index) => projectSegment(row, index));
    if (segments.reduce((sum, row) => sum + Number(row.providerSendBytes), 0) !== bytes) throw new Error("sc01_export_segment_sum_mismatch");
    const usageRows = input.metrics.filter((row) => row.name === "m1_v2_response_usage" && row.dimensions?.attemptDigest === attemptDigest);
    if (usageRows.length > 1) throw new Error("sc01_export_usage_cardinality_invalid");
    return {
      ordinal: physical.ordinal, role: "agent" as const, ownership: physical.ownership,
      stepId: physical.stepId!, sessionId: physical.sessionId!, turnId: physical.turnId!, attemptDigest,
      requestStartedAtMs: physical.requestStartedAtMs, terminatedAtMs: physical.terminatedAtMs,
      durationMs: physical.durationMs, terminalStatus,
      providerStatus: physical.providerStatus, routeId: physical.routeId,
      requestedModel, providerReportedModel, requestedReasoning: "medium" as const, authorizationScheme: "bearer" as const,
      requestedServiceTierMode: "auto_by_omission" as const, effectiveServiceTier: effectiveTier,
      effectiveServiceTierAvailability: physical.effectiveServiceTierAvailability,
      effectiveServiceTierReason: physical.effectiveServiceTierReason,
      serializerContract: physical.serializerContract, serializedRequestBytes: bytes,
      serializedRequestDigest: physical.serializedRequestDigest, serializedRequestDigestAlgorithm: physical.serializedRequestDigestAlgorithm, envelope: projectEnvelope(event), segments,
      usage: usageRows.length === 1 ? projectUsage(usageRows[0]!) : absentUsage(attemptDigest),
    };
  });
  if (!attempts.some((attempt) => attempt.ownership === "target_step") || attempts.length !== envelopes.length || attempts.length !== agentMemberships.length ||
      attempts.some((attempt) => !agentMemberships.some((membership) => membership.ordinal === attempt.ordinal && membership.physicalAttemptDigest === attempt.attemptDigest)) ||
      input.providerRequests.filter((row) => row.requestKind === "agent").length !== attempts.length ||
      input.providerRequests.some((row) => row.requestKind === "agent" && (!DIGEST.test(String(row.attemptDigest)) ||
        !attempts.some((attempt) => attempt.ordinal === row.ordinal && attempt.attemptDigest === row.attemptDigest)))) {
    throw new Error("sc01_export_agent_membership_incomplete");
  }
  const overhead = input.providerRequests.filter((row) => row.requestKind !== "agent").map((row) => {
    const role = row.requestKind;
    if (role !== "auxiliary" && role !== "title" && role !== "tool_provider") throw new Error("sc01_export_role_invalid");
    const attemptDigest = requiredDigest(row.attemptDigest);
    const ordinal = integer(row.ordinal); const membership = membershipByOrdinal.get(ordinal);
    const physical = projectPhysicalRequest(row, membership, input.identity.stepId);
    if (physical.role !== role || physical.attemptDigest !== attemptDigest) throw new Error("sc01_export_non_agent_ownership_ambiguous");
    return { ...physical, role: role as "auxiliary" | "title" | "tool_provider", armed: false as const, armId: null };
  });
  const nonAgentMemberships = memberships.filter((row) => row.requestKind !== "agent");
  if (nonAgentMemberships.some((membership) => !overhead.some((row) => row.ordinal === membership.ordinal && row.role === membership.requestKind))) {
    throw new Error("sc01_export_non_agent_membership_incomplete");
  }
  if (attempts.length + overhead.length !== input.providerRequests.length ||
      memberships.some((membership) => ![...attempts, ...overhead].some((row) =>
        row.ordinal === membership.ordinal && row.role === membership.requestKind && row.attemptDigest === membership.physicalAttemptDigest))) {
    throw new Error("sc01_export_physical_request_projection_incomplete");
  }
  const membershipSha256 = digest([...attempts, ...overhead].map((row) => ({ ordinal: row.ordinal, role: row.role, ownership: row.ownership,
    stepId: row.stepId, sessionId: row.sessionId, turnId: row.turnId, physicalAttemptDigest: row.attemptDigest })));
  const identity = { ...input.identity, membershipSha256 };
  const base = { schema: SCHEMA, identity, attempts, overhead,
    counts: { attempts: attempts.length, segments: attempts.reduce((sum, row) => sum + row.segments.length, 0),
      canonicalUsageRows: attempts.filter((row) => row.usage.availabilityReason !== "provider_usage_row_absent").length, projectedUsage: attempts.length, overhead: overhead.length },
    retention: { owner: "agent-benchmark-run" as const, cleanup: "with-run-evidence" as const }, contentSha256: "" };
  const result = { ...base, contentSha256: digest(base) };
  assertExportRows(result);
  assertNoUnsafeMaterial(result);
  return result;
}

type PhysicalRequestOwnership = "target_step" | "other_step" | "unarmed_physical_overhead";
type PhysicalRequestProjection = {
  ordinal: number; role: PhysicalRequestRole; ownership: PhysicalRequestOwnership;
  stepId: string | null; sessionId: string | null; turnId: string | null; attemptDigest: string;
  providerSendBytes: number; requestStartedAtMs: number; terminatedAtMs: number; durationMs: number;
  terminalStatus: string; providerStatus: number | null; routeId: "openai-codex-responses" | "openai-responses";
  requestedModel: string | null; providerReportedModel: string | null; requestedReasoning: string | null; authorizationScheme: string | null;
  requestedServiceTierMode: "auto_by_omission"; effectiveServiceTier: string | null;
  effectiveServiceTierAvailability: "reported" | "unavailable"; effectiveServiceTierReason: "provider_response_reported" | "provider_response_omitted";
  serializerContract: "butler.openai-codex-final-json.v1" | "butler.openai-responses-final-json.v1";
  serializedRequestDigest: string; serializedRequestDigestAlgorithm: "hmac-sha256-observer-private-v1";
};

function projectPhysicalRequest(
  request: Record<string, unknown>,
  membership: Record<string, unknown> | undefined,
  targetStepId: string,
): PhysicalRequestProjection {
  const role = request.requestKind;
  if (!isPhysicalRequestRole(role)) throw new Error("sc01_export_role_invalid");
  const ordinal = integer(request.ordinal);
  const attemptDigest = requiredDigest(request.attemptDigest);
  if (membership && (!physicalRequestIdentityMatches(request, { ordinal, requestKind: role, physicalAttemptDigest: attemptDigest }) ||
      !publicId(membership.stepId) || !publicId(membership.sessionId) || !publicId(membership.turnId))) {
    throw new Error("sc01_export_physical_request_ownership_mismatch");
  }
  const requestStartedAtMs = integer(request.requestStartedAtMs);
  const terminatedAtMs = integer(request.terminatedAtMs);
  if (terminatedAtMs < requestStartedAtMs) throw new Error("sc01_export_physical_request_timing_invalid");
  const terminal = terminalStatus(request.termination);
  const completedAtMs = request.completedAtMs === null ? null : integer(request.completedAtMs);
  if ((terminal === "completed") !== (completedAtMs === terminatedAtMs)) throw new Error("sc01_export_physical_request_timing_invalid");
  const effectiveServiceTier = nullablePublicRefValue(request.providerReportedServiceTier);
  const effectiveServiceTierAvailabilityValue = effectiveTierAvailability(request.effectiveServiceTierAvailability);
  const effectiveServiceTierReasonValue = effectiveTierReason(request.effectiveServiceTierReason);
  if ((effectiveServiceTierAvailabilityValue === "reported") !== (effectiveServiceTier !== null) ||
      (effectiveServiceTierReasonValue === "provider_response_reported") !== (effectiveServiceTier !== null)) {
    throw new Error("sc01_export_effective_service_tier_invalid");
  }
  if (request.requestedServiceTier !== null || request.requestedServiceTierMode !== "auto_by_omission") {
    throw new Error("sc01_export_provider_request_identity_mismatch");
  }
  return {
    ordinal, role,
    ownership: !membership ? "unarmed_physical_overhead" : membership.stepId === targetStepId ? "target_step" : "other_step",
    stepId: membership ? String(membership.stepId) : null,
    sessionId: membership ? String(membership.sessionId) : null,
    turnId: membership ? String(membership.turnId) : null,
    attemptDigest,
    providerSendBytes: positiveInteger(request.serializedRequestBytes), requestStartedAtMs, terminatedAtMs,
    durationMs: terminatedAtMs - requestStartedAtMs, terminalStatus: terminal,
    providerStatus: nullableHttpStatusValue(request.status), routeId: route(request.routeId),
    requestedModel: nullablePublicRefValue(request.requestedModel), providerReportedModel: nullablePublicRefValue(request.providerReportedModel),
    requestedReasoning: nullablePublicRefValue(request.requestedReasoning), authorizationScheme: nullablePublicRefValue(request.authorizationScheme),
    requestedServiceTierMode: "auto_by_omission", effectiveServiceTier,
    effectiveServiceTierAvailability: effectiveServiceTierAvailabilityValue, effectiveServiceTierReason: effectiveServiceTierReasonValue,
    serializerContract: serializer(request.serializerContract, request.routeId), serializedRequestDigest: requiredSha(request.serializedRequestDigest),
    serializedRequestDigestAlgorithm: digestAlgorithm(request.serializedRequestDigestAlgorithm),
  };
}

const ENVELOPE = ["schemaVersion", "attemptDigest", "turnDigest", "phaseDigest", "roundIndex", "retryOrdinal", "providerId", "modelRef", "armId", "sourceRevision", "cacheBoundaryRevision", "providerSendBytes", "estimatedInputTokens", "eligibility"];
const SEGMENT = ["schemaVersion", "attemptDigest", "segmentId", "kind", "stability", "providerSendBytes", "estimatedInputTokens", "keyedContentDigest"];
const USAGE = ["schemaVersion", "attemptDigest", "status", "promptTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"];
const PROVIDER = ["ordinal", "attemptDigest", "requestKind", "requestedModel", "requestedReasoning", "requestedServiceTier", "requestedServiceTierMode", "authorizationScheme", "routeId", "requestStartedAtMs", "serializedRequestBytes", "serializedRequestDigest", "serializedRequestDigestAlgorithm", "serializerContract", "firstContentBearingDeltaAtMs", "completedAtMs", "terminatedAtMs", "termination", "status", "hasTextContent", "hasToolArgumentContent", "hasReasoningContent", "streamedTextChars", "finalTextChars", "providerReportedModel", "providerReportedServiceTier", "effectiveServiceTierAvailability", "effectiveServiceTierReason"];
const MEMBERSHIP = ["ordinal", "sessionId", "turnId", "requestKind", "physicalAttemptDigest", "stepId"];
const ATTEMPT = ["ordinal", "role", "ownership", "stepId", "sessionId", "turnId", "attemptDigest", "requestStartedAtMs", "terminatedAtMs", "durationMs", "terminalStatus", "providerStatus", "routeId", "requestedModel", "providerReportedModel", "requestedReasoning", "authorizationScheme", "requestedServiceTierMode", "effectiveServiceTier", "effectiveServiceTierAvailability", "effectiveServiceTierReason", "serializerContract", "serializedRequestBytes", "serializedRequestDigest", "serializedRequestDigestAlgorithm", "envelope", "segments", "usage"];
const OVERHEAD = ["ordinal", "role", "ownership", "stepId", "sessionId", "turnId", "attemptDigest", "armed", "armId", "providerSendBytes", "requestStartedAtMs", "terminatedAtMs", "durationMs", "terminalStatus", "providerStatus", "routeId", "requestedModel", "providerReportedModel", "requestedReasoning", "authorizationScheme", "requestedServiceTierMode", "effectiveServiceTier", "effectiveServiceTierAvailability", "effectiveServiceTierReason", "serializerContract", "serializedRequestDigest", "serializedRequestDigestAlgorithm"];
function projectEnvelope(row: OperationalMetricEvent) { assertExactKeys(row.dimensions!, ENVELOPE); return { ...row.dimensions!, observedAtMs: row.ts }; }
function projectSegment(row: OperationalMetricEvent, order: number) { assertMetric(row, "segment"); assertExactKeys(row.dimensions!, SEGMENT); const d = row.dimensions!;
  const kind = bounded(d.kind); if (!OBSERVED_M1_REQUEST_SEGMENT_KINDS.some((value) => value === kind)) throw new Error("sc01_export_segment_kind_invalid");
  return { ...d, order, byteLength: positiveInteger(d.providerSendBytes), providerSendBytes: positiveInteger(d.providerSendBytes) }; }
function projectUsage(row: OperationalMetricEvent) { assertMetric(row, "usage"); assertExactKeys(row.dimensions!, USAGE); const d = row.dimensions!;
  if (d.status !== "usage_bearing" && d.status !== "unavailable") throw new Error("sc01_export_usage_status_invalid"); return { ...d, availabilityReason: d.status === "unavailable" ? "provider_usage_unavailable" : "provider_usage_reported" }; }
function absentUsage(attemptDigest: string) { return { schemaVersion: "butler.m1-response-usage.v2", attemptDigest, status: "unavailable", promptTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null, availabilityReason: "provider_usage_row_absent" }; }
function assertMetric(row: OperationalMetricEvent, kind: string) { if (row.schema !== "butler.operational-metric.v1" || row.category !== "context" || row.status !== "ok" || row.rawTextStored !== false || !row.dimensions) throw new Error(`sc01_export_${kind}_invalid`); }
function assertIdentity(value: M1V2EvidenceExportIdentity) { assertExactKeys(value, ["planIdentity", "sourceRevision", "fixtureHash", "armKey", "armId", "repetition", "block", "stepId", "version", "pairId", "armOrder", "sessionId", "turnId", "expectedProviderId", "expectedModelRef", "expectedRouteId", "expectedCacheBoundaryRevision", "membershipSha256"]);
  if (!SHA256.test(value.planIdentity) || !/^[a-f0-9]{40}$/u.test(value.sourceRevision) || !SHA256.test(value.fixtureHash) || !PUBLIC_ID.test(value.armKey) || !M1_V2_ARM_IDS.includes(value.armId) || !PUBLIC_ID.test(value.stepId) || !PUBLIC_ID.test(value.sessionId) || !PUBLIC_ID.test(value.turnId) ||
      !Number.isSafeInteger(value.repetition) || value.repetition <= 0 || (value.block !== null && (!Number.isSafeInteger(value.block) || value.block < 0)) ||
      (value.version !== null && value.version !== "before" && value.version !== "after") || (value.pairId !== null && !PUBLIC_ID.test(value.pairId)) || !Number.isSafeInteger(value.armOrder) || value.armOrder < 0 ||
      !publicRef(value.expectedModelRef) || !nullablePublicRef(value.expectedCacheBoundaryRevision) || !SHA256.test(value.membershipSha256) || providerForRoute(value.expectedRouteId) !== value.expectedProviderId) throw new Error("sc01_export_identity_invalid"); }
function assertMaterializationIdentity(value: M1V2EvidenceMaterializationIdentity): void {
  assertIdentity({ ...value, membershipSha256: "0".repeat(64) });
  if (value.membershipSha256 !== null) throw new Error("sc01_export_materialization_identity_invalid");
}
function assertExportRows(value: M1V2EvidenceExport): void {
  const rows = [...value.attempts, ...value.overhead];
  const ordinals = rows.map((row) => row.ordinal);
  const digests = rows.map((row) => row.attemptDigest);
  if (new Set(ordinals).size !== ordinals.length) throw new Error("sc01_export_ordinal_ambiguous");
  if (new Set(digests).size !== digests.length) throw new Error("sc01_export_attempt_digest_ambiguous");
  const membershipSha256 = digest(rows.map((row) => ({ ordinal: row.ordinal, role: row.role, ownership: row.ownership,
    stepId: row.stepId, sessionId: row.sessionId, turnId: row.turnId, physicalAttemptDigest: row.attemptDigest })));
  if (value.identity.membershipSha256 !== membershipSha256) throw new Error("sc01_export_membership_identity_mismatch");
  value.attempts.forEach((attempt) => assertAttempt(attempt, value.identity));
  value.overhead.forEach((overhead) => assertOverhead(overhead, value.identity));
  assertRetryOrdinals(value.attempts);
}
function assertAttempt(attempt: M1V2EvidenceExport["attempts"][number], identity: M1V2EvidenceExportIdentity): void {
  assertExactKeys(attempt, ATTEMPT); assertExactKeys(attempt.envelope, [...ENVELOPE, "observedAtMs"]);
  assertExactKeys(attempt.usage, [...USAGE, "availabilityReason"]); attempt.segments.forEach((row) => assertExactKeys(row, [...SEGMENT, "order", "byteLength"]));
  assertPhysicalRequestRow(attempt, identity);
  if (
      attempt.requestedModel !== identity.expectedModelRef || (attempt.providerReportedModel !== null && attempt.providerReportedModel !== identity.expectedModelRef) ||
      (attempt.terminalStatus === "completed" && attempt.providerReportedModel !== identity.expectedModelRef) || attempt.requestedReasoning !== "medium" || attempt.authorizationScheme !== "bearer" ||
      !SHA256.test(attempt.serializedRequestDigest) || attempt.serializedRequestDigestAlgorithm !== "hmac-sha256-observer-private-v1") throw new Error("sc01_export_attempt_value_invalid");
  route(attempt.routeId); serializer(attempt.serializerContract, attempt.routeId);
  const envelope = attempt.envelope;
  if (envelope.schemaVersion !== "butler.m1-request-envelope.v2" || envelope.attemptDigest !== attempt.attemptDigest ||
      !DIGEST.test(String(envelope.turnDigest)) || !DIGEST.test(String(envelope.phaseDigest)) || !nonnegativeIntegerValue(envelope.roundIndex) ||
      !nonnegativeIntegerValue(envelope.retryOrdinal) || envelope.providerId !== identity.expectedProviderId || envelope.modelRef !== identity.expectedModelRef ||
      envelope.armId !== identity.armId || envelope.sourceRevision !== identity.sourceRevision || !nullablePublicRef(envelope.cacheBoundaryRevision) ||
      envelope.cacheBoundaryRevision !== identity.expectedCacheBoundaryRevision || attempt.routeId !== identity.expectedRouteId ||
      envelope.providerSendBytes !== attempt.serializedRequestBytes || !nullableNonnegativeInteger(envelope.estimatedInputTokens) ||
      typeof envelope.eligibility !== "string" || !ELIGIBILITY.has(envelope.eligibility) || !nonnegativeIntegerValue(envelope.observedAtMs)) throw new Error("sc01_export_envelope_value_invalid");
  if (Math.abs(Number(envelope.observedAtMs) - attempt.terminatedAtMs) > 5_000) throw new Error("sc01_export_envelope_timing_mismatch");
  const segmentIds = new Set<string>();
  attempt.segments.forEach((segment, order) => {
    if (segment.schemaVersion !== "butler.m1-request-segment.v2" || segment.attemptDigest !== attempt.attemptDigest || !publicId(segment.segmentId) ||
        segmentIds.has(String(segment.segmentId)) || !OBSERVED_M1_REQUEST_SEGMENT_KINDS.includes(segment.kind as never) ||
        (segment.stability !== "stable" && segment.stability !== "dynamic") || !nonnegativeIntegerValue(segment.providerSendBytes) ||
        segment.byteLength !== segment.providerSendBytes || segment.order !== order || !nullableNonnegativeInteger(segment.estimatedInputTokens) ||
        typeof segment.keyedContentDigest !== "string" || !DIGEST.test(segment.keyedContentDigest)) throw new Error("sc01_export_segment_value_invalid");
    segmentIds.add(String(segment.segmentId));
  });
  if (attempt.segments.reduce((sum, row) => sum + Number(row.providerSendBytes), 0) !== attempt.serializedRequestBytes) throw new Error("sc01_export_byte_invariant_failed");
  const usage = attempt.usage;
  if (usage.schemaVersion !== "butler.m1-response-usage.v2" || usage.attemptDigest !== attempt.attemptDigest ||
      (usage.status !== "usage_bearing" && usage.status !== "unavailable") || !["provider_usage_unavailable", "provider_usage_reported", "provider_usage_row_absent"].includes(String(usage.availabilityReason)) ||
      (usage.status === "usage_bearing" && usage.availabilityReason !== "provider_usage_reported") ||
      !["promptTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"].every((key) => nullableNonnegativeInteger(usage[key])) ||
      (usage.status === "unavailable" && !["promptTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens"].every((key) => usage[key] === null))) {
    throw new Error("sc01_export_usage_value_invalid");
  }
}
function assertOverhead(row: M1V2EvidenceExport["overhead"][number], identity: M1V2EvidenceExportIdentity): void {
  assertExactKeys(row, OVERHEAD);
  assertPhysicalRequestRow(row, identity);
  if (row.armed !== false || row.armId !== null ||
      !SHA256.test(row.serializedRequestDigest) || row.serializedRequestDigestAlgorithm !== "hmac-sha256-observer-private-v1") throw new Error("sc01_export_overhead_value_invalid");
  route(row.routeId); serializer(row.serializerContract, row.routeId);
}

type DurablePhysicalRequest = M1V2EvidenceExport["attempts"][number] | M1V2EvidenceExport["overhead"][number];
function assertPhysicalRequestRow(row: DurablePhysicalRequest, identity?: M1V2EvidenceExportIdentity): void {
  const agent = isAgentSc01Role(row.role);
  const bytes = "serializedRequestBytes" in row ? row.serializedRequestBytes : row.providerSendBytes;
  const owned = row.ownership === "target_step" || row.ownership === "other_step";
  const exactTargetIdentity = identity !== undefined && row.stepId === identity.stepId &&
    row.sessionId === identity.sessionId && row.turnId === identity.turnId;
  if (!positiveIntegerValue(row.ordinal) || !DIGEST.test(row.attemptDigest) ||
      (agent ? !owned : !owned && row.ownership !== "unarmed_physical_overhead") ||
      (owned ? !publicId(row.stepId) || !publicId(row.sessionId) || !publicId(row.turnId) : row.stepId !== null || row.sessionId !== null || row.turnId !== null) ||
      (identity && ((row.ownership === "target_step") !== exactTargetIdentity || row.ownership === "other_step" && exactTargetIdentity)) ||
      !positiveIntegerValue(bytes) || !nonnegativeIntegerValue(row.requestStartedAtMs) || !nonnegativeIntegerValue(row.terminatedAtMs) ||
      row.terminatedAtMs < row.requestStartedAtMs || row.durationMs !== row.terminatedAtMs - row.requestStartedAtMs ||
      !TERMINAL_STATUS.has(row.terminalStatus) || !nullableHttpStatus(row.providerStatus) ||
      !terminalStatusMatchesProviderStatus(row.terminalStatus, row.providerStatus) ||
      !nullablePublicRef(row.requestedModel) || !nullablePublicRef(row.providerReportedModel) || !nullablePublicRef(row.requestedReasoning) ||
      !nullablePublicRef(row.authorizationScheme) || row.requestedServiceTierMode !== "auto_by_omission" || !nullablePublicRef(row.effectiveServiceTier) ||
      (row.effectiveServiceTierAvailability !== "reported" && row.effectiveServiceTierAvailability !== "unavailable") ||
      (row.effectiveServiceTierReason !== "provider_response_reported" && row.effectiveServiceTierReason !== "provider_response_omitted") ||
      (row.effectiveServiceTierAvailability === "reported") !== (row.effectiveServiceTier !== null) ||
      (row.effectiveServiceTierReason === "provider_response_reported") !== (row.effectiveServiceTier !== null)) {
    throw new Error("sc01_export_physical_request_value_invalid");
  }
  route(row.routeId); serializer(row.serializerContract, row.routeId);
}

function assertRetryOrdinals(attempts: M1V2EvidenceExport["attempts"]): void {
  const groups = new Map<string, M1V2EvidenceExport["attempts"]>();
  for (const attempt of attempts) {
    const key = [attempt.ownership, attempt.stepId, attempt.sessionId, attempt.turnId, String(attempt.envelope.roundIndex)].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const retryOrdinals = group.map((attempt) => Number(attempt.envelope.retryOrdinal)).sort((left, right) => left - right);
    if (retryOrdinals.some((ordinal, index) => ordinal !== index)) throw new Error("sc01_export_retry_ordinal_invalid");
    if (group.some((attempt) => Number(attempt.envelope.retryOrdinal) > 0 &&
      attempt.envelope.eligibility !== "retry_contaminated" && attempt.envelope.eligibility !== "rejected")) {
      throw new Error("sc01_export_retry_eligibility_invalid");
    }
  }
}
function safeHandle(root: string, path: string) { const rel = relative(resolve(root), resolve(path)); if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("sc01_export_path_invalid"); return rel.replaceAll("\\", "/"); }
function assertSafeEvidenceRoot(runRoot: string, evidenceRoot: string): void { if (hasSymlinkComponent(evidenceRoot)) throw new Error("sc01_export_symlink_rejected");
  const runReal = realpathSync(runRoot); const evidenceReal = realpathSync(evidenceRoot); const rel = relative(runReal, evidenceReal);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("sc01_export_path_invalid"); }
function hasSymlinkComponent(path: string): boolean { const resolved = resolve(path); const parsed = parse(resolved); let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) { current = resolve(current, segment); if (lstatSync(current).isSymbolicLink() && current !== "/tmp" && current !== "/var") return true; } return false; }
function route(value: unknown): "openai-codex-responses" | "openai-responses" { if (value === "openai-codex-responses" || value === "openai-responses") return value; throw new Error("sc01_export_route_invalid"); }
function providerForRoute(value: unknown): "openai-codex" | "openai" | null { return value === "openai-codex-responses" ? "openai-codex" : value === "openai-responses" ? "openai" : null; }
function serializer(value: unknown, routeId: unknown): "butler.openai-codex-final-json.v1" | "butler.openai-responses-final-json.v1" { const expected = routeId === "openai-codex-responses" ? "butler.openai-codex-final-json.v1" : routeId === "openai-responses" ? "butler.openai-responses-final-json.v1" : null;
  if (!expected || value !== expected) throw new Error("sc01_export_serializer_invalid"); return expected; }
function digestAlgorithm(value: unknown): "hmac-sha256-observer-private-v1" { if (value !== "hmac-sha256-observer-private-v1") throw new Error("sc01_export_digest_algorithm_invalid"); return value; }
function assertExactKeys(value: object, allowed: readonly string[]) { const keys = Object.keys(value); if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error("sc01_export_allowlist_rejected"); }
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
function publicId(value: unknown): value is string { return typeof value === "string" && PUBLIC_ID.test(value); }
function publicRef(value: unknown): value is string { return typeof value === "string" && PUBLIC_REF.test(value) && !value.includes("..") && !value.startsWith("/") && !/^(?:sk|sess|key|token|secret|bearer)[-_]/iu.test(value); }
function nullablePublicRef(value: unknown): boolean { return value === null || publicRef(value); }
function nullablePublicRefValue(value: unknown): string | null { if (value === null) return null; if (!publicRef(value)) throw new Error("sc01_export_identifier_invalid"); return value; }
function effectiveTierAvailability(value: unknown): "reported" | "unavailable" { if (value === "reported" || value === "unavailable") return value; throw new Error("sc01_export_effective_service_tier_invalid"); }
function effectiveTierReason(value: unknown): "provider_response_reported" | "provider_response_omitted" { if (value === "provider_response_reported" || value === "provider_response_omitted") return value; throw new Error("sc01_export_effective_service_tier_invalid"); }
function normalizeRequestedModel(value: unknown, expected: string): string | null {
  if (typeof value !== "string" || !publicRef(value)) return null;
  if (value === expected) return expected;
  const slash = expected.indexOf("/");
  return slash >= 0 && value === expected.slice(slash + 1) ? expected : null;
}
function nonnegativeIntegerValue(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positiveIntegerValue(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nullableNonnegativeInteger(value: unknown): boolean { return value === null || nonnegativeIntegerValue(value); }
function nullableHttpStatus(value: unknown): boolean { return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599; }
function nullableHttpStatusValue(value: unknown): number | null { if (!nullableHttpStatus(value)) throw new Error("sc01_export_provider_status_invalid"); return value as number | null; }
function assertNoUnsafeMaterial(value: unknown, key = ""): void {
  if (/(?:prompt|message|transcript|query|url|uri|args?|arguments?|result|content|raw|secret|password|credential|api[_-]?key|token|reasoning)/iu.test(key) && !/(?:Tokens|reasoningTokens|requestedReasoning|contentSha256|keyedContentDigest)$/u.test(key)) {
    throw new Error(`sc01_export_unsafe_key_rejected:${key}`);
  }
  if (typeof value === "string" && ((value.startsWith("/") || /^[A-Z]:\\/u.test(value)) || /(?:bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|authorization\s*[:=]|hidden reasoning)/iu.test(value))) {
    throw new Error("sc01_export_unsafe_value_rejected");
  }
  if (Array.isArray(value)) value.forEach((item) => assertNoUnsafeMaterial(item, key));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => assertNoUnsafeMaterial(child, childKey));
}
function recordArray(value: unknown) { return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : []; }
function integer(value: unknown) { if (!Number.isSafeInteger(value)) throw new Error("sc01_export_integer_invalid"); return value as number; }
function positiveInteger(value: unknown) { const result = integer(value); if (result <= 0) throw new Error("sc01_export_positive_integer_invalid"); return result; }
function bounded(value: unknown) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u.test(value)) throw new Error("sc01_export_identifier_invalid"); return value; }
function requiredDigest(value: unknown) { const result = physicalAttemptDigest(value); if (result === null) throw new Error("sc01_export_attempt_digest_invalid"); return result; }
function terminalStatus(value: unknown) { const result = bounded(value); if (!TERMINAL_STATUS.has(result)) throw new Error("sc01_export_terminal_status_invalid"); return result; }
function requiredSha(value: unknown) { const result = bounded(value); if (!SHA256.test(result)) throw new Error("sc01_export_sha_invalid"); return result; }
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
