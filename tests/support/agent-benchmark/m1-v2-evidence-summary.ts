import type {
  M1V2PhysicalOverheadSummary,
  M1V2WorkEvidence,
} from "./m1-v2-types.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { ProviderRequestTurnIdentity } from
  "../../e2e/btcc-r3-electron/contracts.ts";

const TERMINAL_JOIN_TOLERANCE_MS = 5_000;

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
    attemptDigest: stringValue(identity.attemptDigest),
  }));
  const ownershipByOrdinal = new Map<number, ProviderRequestTurnIdentity>();
  let invalidRequestIdentityCount = 0;
  for (const identity of targetRequests) {
    if (identity.requestKind !== "agent") continue;
    if (ownershipByOrdinal.has(identity.ordinal) ||
      identity.sessionId !== targetSessionId || identity.turnId !== targetTurnId) {
      invalidRequestIdentityCount += 1;
      continue;
    }
    ownershipByOrdinal.set(identity.ordinal, identity);
  }
  const availableRequests = requests.map((request) => {
    const ordinal = numberValue(request.ordinal);
    const identity = ordinal === null ? undefined : ownershipByOrdinal.get(ordinal);
    const requestKind = request.requestKind;
    const requestDigest = stringValue(request.attemptDigest);
    const validKind = requestKind === "agent" || requestKind === "auxiliary" ||
      requestKind === "title" || requestKind === "tool_provider";
    const typedNonAgent = validKind && requestKind !== "agent";
    const identityValid = typedNonAgent || Boolean(identity) &&
      identity?.requestKind === "agent" &&
      identity.attemptDigest === requestDigest && requestDigest !== null;
    if (!identityValid || terminalTimestamp(request) === null ||
      numberValue(request.serializedRequestBytes) === null) {
      invalidRequestIdentityCount += 1;
    }
    return { request, identity, identityValid, used: false };
  });
  const observedOrdinals = new Set(availableRequests.flatMap(({ request }) => {
    const ordinal = numberValue(request.ordinal);
    return ordinal === null ? [] : [ordinal];
  }));
  invalidRequestIdentityCount += [...ownershipByOrdinal.keys()]
    .filter((ordinal) => !observedOrdinals.has(ordinal)).length;
  const joined: Array<{
    digest: string;
    request: Record<string, unknown> | null;
    armed: boolean;
    excludedNonAgent: boolean;
    requestKind: ProviderRequestTurnIdentity["requestKind"] | null;
  }> = [];
  for (const envelope of envelopes) {
    const digest = stringValue(envelope.dimensions?.attemptDigest);
    const bytes = numberValue(envelope.dimensions?.providerSendBytes);
    if (!digest || bytes === null) continue;
    const candidates = availableRequests
      .filter(({ request, identityValid, used }) => !used && identityValid &&
        stringValue(request.attemptDigest) === digest &&
        numberValue(request.ordinal) !== null &&
        numberValue(request.serializedRequestBytes) === bytes &&
        terminalTimestamp(request) !== null &&
        Math.abs(envelope.ts - terminalTimestamp(request)!) <= TERMINAL_JOIN_TOLERANCE_MS)
      .sort((left, right) => {
        const timeDelta = Math.abs(envelope.ts - terminalTimestamp(left.request)!) -
          Math.abs(envelope.ts - terminalTimestamp(right.request)!);
        return timeDelta ||
          (numberValue(left.request.ordinal) ?? Number.MAX_SAFE_INTEGER) -
            (numberValue(right.request.ordinal) ?? Number.MAX_SAFE_INTEGER);
      });
    const match = candidates[0];
    if (!match) {
      joined.push({
        digest,
        request: null,
        armed: false,
        excludedNonAgent: false,
        requestKind: null,
      });
      continue;
    }
    match.used = true;
    joined.push({
      digest,
      request: match.request,
      armed: match.request.requestKind === "agent" &&
        envelope.dimensions?.armId === armId,
      excludedNonAgent: match.request.requestKind !== "agent" &&
        envelope.dimensions?.armId === null,
      requestKind: match.request.requestKind as
        ProviderRequestTurnIdentity["requestKind"],
    });
  }
  const excluded = availableRequests.flatMap(({ request, identityValid }) =>
    identityValid && request.requestKind !== "agent" ? [request] : []);
  const targetAgentRequests = availableRequests.flatMap(
    ({ request, identity, identityValid }) =>
      identityValid && identity?.requestKind === "agent" ? [request] : [],
  );
  return {
    auxiliary: physicalOverhead(excluded, "auxiliary"),
    title: physicalOverhead(excluded, "title"),
    toolProvider: physicalOverhead(excluded, "tool_provider"),
    unmatchedEnvelopeDigests: joined.flatMap((item) =>
      item.request && (item.armed || item.excludedNonAgent)
        ? []
        : [item.digest]),
    unmatchedRequestOrdinals: availableRequests.flatMap(({ request, used }) => {
      const ordinal = numberValue(request.ordinal);
      return used || ordinal === null || request.requestKind !== "agent" ? [] : [ordinal];
    }),
    invalidRequestIdentityCount,
    targetAgentRequests,
    duplicateEnvelopeDigests: duplicateValues(envelopes.flatMap((envelope) => {
      const digest = stringValue(envelope.dimensions?.attemptDigest);
      return digest ? [digest] : [];
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
