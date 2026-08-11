import type {
  M1V2PhysicalOverheadSummary,
  M1V2WorkEvidence,
} from "./contracts.ts";

export function summarizePhysicalRequests(
  requests: Record<string, unknown>[],
  armedAttempts: number,
): {
  auxiliary: M1V2PhysicalOverheadSummary;
  title: M1V2PhysicalOverheadSummary;
  toolProvider: M1V2PhysicalOverheadSummary;
} {
  let remainingArmed = armedAttempts;
  const unarmed = requests.filter((request) => {
    const kind = request.requestKind;
    if ((kind === "agent" || kind === "tool_provider") && remainingArmed > 0) {
      remainingArmed -= 1;
      return false;
    }
    return true;
  });
  return {
    auxiliary: physicalOverhead(unarmed, "auxiliary"),
    title: physicalOverhead(unarmed, "title"),
    toolProvider: physicalOverhead(unarmed, "tool_provider"),
  };
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
): M1V2WorkEvidence {
  const work = recordValue(target?.work);
  const expectations = recordValue(target?.expectations);
  const rawFailures = Array.isArray(expectations?.failures)
    ? expectations.failures
    : [];
  const duplicateEvidenceCount = target
    ? rawFailures.filter((failure) =>
      typeof failure === "string" && /duplicate/iu.test(failure)).length
    : null;
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
    duplicateEvidenceCount,
    lostCorrectionEvidenceCount: null,
    stallObserved: target
      ? terminalState !== "delivered" || firstUseful === null
      : null,
  };
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
