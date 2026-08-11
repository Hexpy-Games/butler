import type {
  M1V2PhysicalOverheadSummary,
  M1V2WorkEvidence,
} from "./contracts.ts";
import type { OperationalMetricEvent } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

const TERMINAL_JOIN_TOLERANCE_MS = 5_000;

export function summarizePhysicalRequests(
  requests: Record<string, unknown>[],
  envelopes: OperationalMetricEvent[],
  armId: string,
): {
  auxiliary: M1V2PhysicalOverheadSummary;
  title: M1V2PhysicalOverheadSummary;
  toolProvider: M1V2PhysicalOverheadSummary;
  unmatchedEnvelopeDigests: string[];
  unmatchedRequestOrdinals: number[];
  invalidRequestIdentityCount: number;
  duplicateEnvelopeDigests: string[];
} {
  const availableRequests = requests.map((request) => ({ request, used: false }));
  const joined: Array<{
    digest: string;
    request: Record<string, unknown> | null;
    armed: boolean;
  }> = [];
  for (const envelope of envelopes) {
    const digest = stringValue(envelope.dimensions?.attemptDigest);
    const bytes = numberValue(envelope.dimensions?.providerSendBytes);
    if (!digest || bytes === null) continue;
    const candidates = availableRequests
      .filter(({ request, used }) => !used &&
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
      joined.push({ digest, request: null, armed: false });
      continue;
    }
    match.used = true;
    joined.push({
      digest,
      request: match.request,
      armed: envelope.dimensions?.armId === armId,
    });
  }
  const unarmed = joined.flatMap((item) =>
    item.request && !item.armed ? [item.request] : []);
  return {
    auxiliary: physicalOverhead(unarmed, "auxiliary"),
    title: physicalOverhead(unarmed, "title"),
    toolProvider: physicalOverhead(unarmed, "tool_provider"),
    unmatchedEnvelopeDigests: joined.flatMap((item) =>
      item.request ? [] : [item.digest]),
    unmatchedRequestOrdinals: availableRequests.flatMap(({ request, used }) => {
      const ordinal = numberValue(request.ordinal);
      return used || ordinal === null ? [] : [ordinal];
    }),
    invalidRequestIdentityCount: requests.filter((request) =>
      !stringValue(request.attemptDigest) || numberValue(request.ordinal) === null ||
      terminalTimestamp(request) === null ||
      numberValue(request.serializedRequestBytes) === null).length,
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

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
