import type {
  M1V2PhysicalOverheadSummary,
  M1V2WorkEvidence,
} from "./m1-v2-types.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { ProviderRequestTurnIdentity } from
  "../../e2e/btcc-r3-electron/contracts.ts";
import { isAgentSc01Role, isPhysicalRequestRole, physicalAttemptDigest, physicalRequestEnvelopeMatches, physicalRequestIdentityMatches } from "./physical-request-identity.ts";

export function summarizePhysicalRequests(
  requests: Record<string, unknown>[],
  envelopes: OperationalMetricEvent[],
  armId: string,
  target: Record<string, unknown>,
): {
  auxiliary: M1V2PhysicalOverheadSummary;
  title: M1V2PhysicalOverheadSummary;
  toolProvider: M1V2PhysicalOverheadSummary;
  unmatchedEnvelopeDigests: string[];
  unmatchedRequestOrdinals: number[];
  invalidRequestIdentityCount: number;
  duplicateEnvelopeDigests: string[];
  targetAgentRequests: Record<string, unknown>[];
} {
  const targetSessionId = stringValue(target.sessionId) ?? "";
  const targetTurnId = stringValue(target.turnId) ?? "";
  const targetRequests = recordArray(target.providerRequestIdentities).map((identity) => ({
    ordinal: numberValue(identity.ordinal) ?? -1,
    sessionId: stringValue(identity.sessionId) ?? "",
    turnId: stringValue(identity.turnId) ?? "",
    requestKind: stringValue(identity.requestKind) as
      ProviderRequestTurnIdentity["requestKind"],
    physicalAttemptDigest: stringValue(identity.physicalAttemptDigest) ?? "",
  }));
  const ownershipByOrdinal = new Map<number, ProviderRequestTurnIdentity>();
  const ownershipByDigest = new Map<string, ProviderRequestTurnIdentity>();
  const invalidAgentOrdinals: number[] = [];
  let invalidRequestIdentityCount = 0;
  for (const identity of targetRequests) {
    const validKind = isPhysicalRequestRole(identity.requestKind);
    const validPhysicalDigest = physicalAttemptDigest(identity.physicalAttemptDigest) !== null;
    const conflictingDigest = ownershipByDigest.has(identity.physicalAttemptDigest);
    if (!Number.isInteger(identity.ordinal) || identity.ordinal < 1 ||
      !validKind || !validPhysicalDigest || ownershipByOrdinal.has(identity.ordinal) ||
      conflictingDigest || identity.sessionId !== targetSessionId ||
      identity.turnId !== targetTurnId) {
      invalidRequestIdentityCount += 1;
      if (identity.requestKind === "agent" && Number.isInteger(identity.ordinal) &&
        identity.ordinal >= 1) invalidAgentOrdinals.push(identity.ordinal);
      continue;
    }
    ownershipByOrdinal.set(identity.ordinal, identity);
    ownershipByDigest.set(identity.physicalAttemptDigest, identity);
  }
  const requestsByOrdinal = new Map<number, Record<string, unknown>[]>();
  for (const request of requests) {
    const ordinal = numberValue(request.ordinal);
    if (ordinal === null) continue;
    const matching = requestsByOrdinal.get(ordinal) ?? [];
    matching.push(request);
    requestsByOrdinal.set(ordinal, matching);
  }
  const targetCandidates: Array<{
    request: Record<string, unknown>;
    identity: ProviderRequestTurnIdentity;
    used: boolean;
  }> = [];
  const missingAgentOrdinals: number[] = [];
  for (const [ordinal, identity] of ownershipByOrdinal) {
    const matching = requestsByOrdinal.get(ordinal) ?? [];
    if (matching.length !== 1) {
      invalidRequestIdentityCount += 1;
      if (identity.requestKind === "agent") missingAgentOrdinals.push(ordinal);
      continue;
    }
    const request = matching[0]!;
    const exactIdentity = physicalRequestIdentityMatches(request, identity);
    const completeObservation = terminalTimestamp(request) !== null &&
      numberValue(request.serializedRequestBytes) !== null;
    if (!exactIdentity || !completeObservation) {
      invalidRequestIdentityCount += 1;
      if (identity.requestKind === "agent") missingAgentOrdinals.push(ordinal);
      continue;
    }
    targetCandidates.push({ request, identity, used: false });
  }
  const joined: Array<{
    digest: string;
    request: Record<string, unknown> | null;
    armed: boolean;
    requestKind: ProviderRequestTurnIdentity["requestKind"] | null;
  }> = [];
  const nonAgentRequestDigests = new Set(requests.flatMap((request) =>
    isPhysicalRequestRole(request.requestKind) && !isAgentSc01Role(request.requestKind)
      ? [stringValue(request.attemptDigest)] : []).filter((digest): digest is string => digest !== null));
  for (const envelope of envelopes) {
    const digest = stringValue(envelope.dimensions?.attemptDigest);
    const bytes = numberValue(envelope.dimensions?.providerSendBytes);
    if (!digest || bytes === null) continue;
    if (nonAgentRequestDigests.has(digest)) {
      joined.push({ digest, request: null, armed: false, requestKind: null });
      continue;
    }
    const candidates = targetCandidates
      .filter(({ request, used }) => !used && physicalRequestEnvelopeMatches(request, {
        physicalAttemptDigest: digest, providerSendBytes: bytes, observedAtMs: envelope.ts,
      }))
      .sort((left, right) => {
        const timeDelta = Math.abs(envelope.ts - terminalTimestamp(left.request)!) -
          Math.abs(envelope.ts - terminalTimestamp(right.request)!);
        return timeDelta ||
          (numberValue(left.request.ordinal) ?? Number.MAX_SAFE_INTEGER) -
            (numberValue(right.request.ordinal) ?? Number.MAX_SAFE_INTEGER);
      });
    const match = candidates[0];
    if (!match) {
      if (envelope.dimensions?.armId !== armId) continue;
      joined.push({
        digest,
        request: null,
        armed: false,
        requestKind: null,
      });
      continue;
    }
    match.used = true;
    joined.push({
      digest,
      request: match.request,
      armed: match.identity.requestKind === "agent" &&
        envelope.dimensions?.armId === armId,
      requestKind: match.identity.requestKind,
    });
  }
  const targetNonAgentOrdinals = new Set(targetCandidates.flatMap(({ identity }) =>
    identity.requestKind === "agent" ? [] : [identity.ordinal]));
  const excluded = requests.filter((request) => {
    const ordinal = numberValue(request.ordinal);
    if (!isPhysicalRequestRole(request.requestKind) || isAgentSc01Role(request.requestKind) ||
      terminalTimestamp(request) === null ||
      numberValue(request.serializedRequestBytes) === null) return false;
    return ordinal === null || targetNonAgentOrdinals.has(ordinal) ||
      !ownershipByOrdinal.has(ordinal);
  });
  const targetAgentRequests = targetCandidates.flatMap(({ request, identity }) =>
    identity.requestKind === "agent" ? [request] : []);
  const relevantEnvelopeDigests = new Set([
    ...targetCandidates.flatMap(({ identity }) =>
      [identity.physicalAttemptDigest]),
    ...envelopes.flatMap((envelope) =>
      envelope.dimensions?.armId === armId
        ? [stringValue(envelope.dimensions?.attemptDigest)]
        : []),
  ].filter((digest): digest is string => digest !== null));
  return {
    auxiliary: physicalOverhead(excluded, "auxiliary"),
    title: physicalOverhead(excluded, "title"),
    toolProvider: physicalOverhead(excluded, "tool_provider"),
    unmatchedEnvelopeDigests: joined.flatMap((item) =>
      item.request && item.armed
        ? []
        : [item.digest]),
    unmatchedRequestOrdinals: [
      ...new Set([...invalidAgentOrdinals, ...missingAgentOrdinals]),
      ...targetCandidates.flatMap(({ identity, used }) =>
        used || identity.requestKind !== "agent" ? [] : [identity.ordinal]),
    ],
    invalidRequestIdentityCount,
    targetAgentRequests,
    duplicateEnvelopeDigests: duplicateValues(envelopes.flatMap((envelope) => {
      const digest = stringValue(envelope.dimensions?.attemptDigest);
      return digest && relevantEnvelopeDigests.has(digest) ? [digest] : [];
    })),
  };
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

function terminalTimestamp(request: Record<string, unknown>): number | null {
  return numberValue(request.terminatedAtMs) ?? numberValue(request.completedAtMs);
}

export function firstUsefulMs(
  providerRequests: Record<string, unknown>[],
  target: Record<string, unknown> | undefined,
  submittedAtMs: number | null,
): number | null {
  if (submittedAtMs === null) return null;
  const provider = providerRequests.flatMap((request) => {
    const started = numberValue(request.requestStartedAtMs);
    const delta = numberValue(request.firstContentBearingDeltaAtMs);
    return started === null || delta === null ? [] : [started + delta - submittedAtMs];
  });
  const rendered = numberValue(recordValue(target?.timing)?.firstRenderedActivityAtMs);
  const candidates = [
    ...provider,
    ...(rendered === null ? [] : [rendered - submittedAtMs]),
  ].filter((value) => value >= 0);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function summarizeWorkEvidence(
  target: Record<string, unknown> | undefined,
  terminalState: string | null,
  firstUseful: number | null,
  input: {
    db?: {
      duplicateAppliedEffects: number | null;
      unresolvedCorrections: number | null;
      lostRequiredAnchors: number | null;
    } | null;
    evidence: Record<string, unknown>;
    expectedModel: string;
  },
): M1V2WorkEvidence {
  const work = recordValue(target?.work);
  const isolation = recordValue(input.evidence.isolation);
  const run = recordValue(input.evidence.run);
  const bindingWorkspace = stringValue(isolation?.bindingWorkspace);
  const workspaceRoot = stringValue(run?.workspaceRoot);
  const providerModels = Array.isArray(target?.providerAgentModels)
    ? target.providerAgentModels.filter((value): value is string => typeof value === "string")
    : [];
  const providerReportedModel = stringValue(target?.providerReportedModel);
  const expectedProviderModel = input.expectedModel.includes("/")
    ? input.expectedModel.slice(input.expectedModel.indexOf("/") + 1)
    : input.expectedModel;
  return {
    observed: Boolean(work),
    status: stringValue(work?.status),
    planRevision: numberValue(work?.planRevision),
    checkpointStage: stringValue(work?.checkpointStage),
    checkpointStages: Array.isArray(work?.checkpointStages)
      ? work.checkpointStages.length
      : 0,
    planReviewVerdict: stringValue(work?.planReviewVerdict),
    resultReviewVerdict: stringValue(work?.resultReviewVerdict),
    completionValidationVerdict: stringValue(work?.completionValidationVerdict),
    resultToolNames: Array.isArray(work?.resultToolNames) ? work.resultToolNames.length : 0,
    projectLedgerWorkRecords: numberValue(work?.projectLedgerWorkRecords) ?? 0,
    projectLedgerCompletedWorkRecords:
      numberValue(work?.projectLedgerCompletedWorkRecords) ?? 0,
    projectLedgerCloseoutObserved: work?.projectLedgerCloseoutObserved === true,
    duplicateEvidenceCount: input.db?.duplicateAppliedEffects ?? null,
    lostCorrectionEvidenceCount: input.db?.unresolvedCorrections ?? null,
    lostRequiredAnchorCount: input.db?.lostRequiredAnchors ?? null,
    workspaceAuthorityPassed: bindingWorkspace && workspaceRoot
      ? bindingWorkspace === workspaceRoot &&
        isolation?.workspaceInsideRunRoot === true &&
        isolation?.sourceDataIsRunData === false
      : null,
    providerRoutingPassed: providerReportedModel && providerModels.length > 0
      ? normalizeModel(providerReportedModel) === expectedProviderModel &&
        providerModels.every((model) => normalizeModel(model) === expectedProviderModel)
      : null,
    stallObserved: target
      ? terminalState !== "delivered" || firstUseful === null
      : null,
  };
}

function normalizeModel(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("/") ? trimmed.slice(trimmed.indexOf("/") + 1) : trimmed;
}

function physicalOverhead(
  requests: Record<string, unknown>[],
  kind: "auxiliary" | "title" | "tool_provider",
): M1V2PhysicalOverheadSummary {
  const matching = requests.filter((request) => request.requestKind === kind);
  return {
    attempts: matching.length,
    providerSendBytes: matching.reduce((total, request) =>
      total + (numberValue(request.serializedRequestBytes) ?? 0), 0),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
