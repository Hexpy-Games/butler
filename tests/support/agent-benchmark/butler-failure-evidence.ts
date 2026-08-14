import type { AdapterRunFailure } from "./contracts.ts";

const FAILURE_TUPLES = new Set([
  "bundled_agent_preparation:disk_space_exhausted:electron_harness",
  "bundled_agent_preparation:resource_inspection_failed:electron_harness",
  "electron_launch_preflight:port_conflict:electron_harness",
  "renderer_ready:electron_exited:electron_process",
  "renderer_ready:renderer_ready_timeout:electron_harness",
]);
const FAILURE_SIGNALS = new Set([
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
  "SIGILL", "SIGINT", "SIGIO", "SIGKILL", "SIGPIPE", "SIGPROF", "SIGPWR",
  "SIGQUIT", "SIGSEGV", "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP",
  "SIGTTIN", "SIGTTOU", "SIGURG", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH",
  "SIGXCPU", "SIGXFSZ",
]);
const PRIVATE_FAILURE_TEXT = /(?:file:\/\/|(?:^|[\s="'(])(?:\/|\.{1,2}\/)[^\s]+|[A-Za-z]:\\|prompt|body|transcript|(?:tool|raw)[_ -]?payload|authorization|credential|secret|api[_-]?key|Bearer\s|(?:sk|sess)-[A-Za-z0-9._-]{12,})/iu;
const PROVIDER_REQUEST_KEYS = [
  "attemptDigest", "authorizationScheme", "completedAtMs", "effectiveServiceTierAvailability",
  "effectiveServiceTierReason", "exactResultReadSchemaObserved", "finalTextChars",
  "firstContentBearingDeltaAtMs", "hasReasoningContent", "hasTextContent",
  "hasToolArgumentContent", "ordinal", "providerReportedModel", "providerReportedServiceTier",
  "requestKind", "requestedModel", "requestedReasoning", "requestedServiceTier",
  "requestedServiceTierMode", "requestStartedAtMs", "routeId", "serializedRequestBytes",
  "serializedRequestDigest", "serializedRequestDigestAlgorithm", "serializerContract", "status",
  "streamedTextChars", "terminatedAtMs", "termination",
].sort();
const OBSERVER_DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const OBSERVER_BODY_DIGEST = /^[a-f0-9]{64}$/u;

export function projectButlerAdapterFailure(
  evidence: Record<string, unknown>,
): AdapterRunFailure | null {
  const failure = asRecord(evidence.failure);
  const canonicalFailure = failure && isCanonicalFailureTuple(failure) &&
    (failure.exitCode === null || Number.isSafeInteger(failure.exitCode)) &&
    (failure.signal === null || isFailureSignal(failure.signal))
    ? failure
    : null;
  if (evidence.ok !== false && evidence.error === undefined && !canonicalFailure) return null;
  const dispatch = providerDispatchEvidence(evidence);
  return {
    schema: "butler.adapter-run-failure.v1",
    stage: canonicalFailure?.stage ?? null,
    cause: canonicalFailure?.cause ?? null,
    owner: canonicalFailure?.owner ?? null,
    exitCode: canonicalFailure ? canonicalFailure.exitCode as number | null : null,
    signal: canonicalFailure ? canonicalFailure.signal as NodeJS.Signals | null : null,
    sanitizedElectronLogTail: projectPublicFailureTail(evidence.sanitizedElectronLogTail),
    sanitizedExecutorLogTail: projectPublicFailureTail(evidence.sanitizedExecutorLogTail),
    providerDispatchState: dispatch.state,
    providerDispatchCount: dispatch.count,
  };
}

function providerDispatchEvidence(evidence: Record<string, unknown>): {
  state: AdapterRunFailure["providerDispatchState"];
  count: number | null;
} {
  if (!Array.isArray(evidence.providerRequests)) return { state: null, count: null };
  const requests = evidence.providerRequests.map(asRecord);
  if (requests.some((row, index) => !isProviderRequestObservation(row) || row.ordinal !== index + 1)) {
    return { state: null, count: null };
  }
  const typedRequests = requests as Record<string, unknown>[];
  if (typedRequests.some((row) => row.hasTextContent === true || row.hasToolArgumentContent === true ||
      row.hasReasoningContent === true || typeof row.firstContentBearingDeltaAtMs === "number")) {
    return { state: "provider_output_observed", count: evidence.providerRequests.length };
  }
  return {
    state: evidence.providerRequests.length > 0 ? "provider_dispatched" : "adapter_entered",
    count: evidence.providerRequests.length,
  };
}

function projectPublicFailureTail(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is string => typeof line === "string" && line.length > 0 &&
      line.length <= 512 && !PRIVATE_FAILURE_TEXT.test(line))
    .slice(-20);
}

function isCanonicalFailureTuple(value: Record<string, unknown>): value is Record<string, unknown> &
  Pick<AdapterRunFailure, "stage" | "cause" | "owner"> {
  return typeof value.stage === "string" && typeof value.cause === "string" &&
    typeof value.owner === "string" &&
    FAILURE_TUPLES.has(`${value.stage}:${value.cause}:${value.owner}`);
}

function isFailureSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && FAILURE_SIGNALS.has(value);
}

function isProviderRequestObservation(value: Record<string, unknown> | null): value is Record<string, unknown> {
  if (!value || Object.keys(value).sort().join("|") !== PROVIDER_REQUEST_KEYS.join("|")) return false;
  const digestValid = value.serializedRequestDigest === null && value.serializedRequestDigestAlgorithm === null ||
    typeof value.serializedRequestDigest === "string" && OBSERVER_BODY_DIGEST.test(value.serializedRequestDigest) &&
      value.serializedRequestDigestAlgorithm === "hmac-sha256-observer-private-v1";
  const tierValid = value.effectiveServiceTierAvailability === "reported"
    ? value.effectiveServiceTierReason === "provider_response_reported" && typeof value.providerReportedServiceTier === "string"
    : value.effectiveServiceTierAvailability === "unavailable" &&
      value.effectiveServiceTierReason === "provider_response_omitted" && value.providerReportedServiceTier === null;
  const requestedTierValid = value.requestedServiceTierMode === null && value.requestedServiceTier === null ||
    value.requestedServiceTierMode === "auto_by_omission" && value.requestedServiceTier === null ||
    value.requestedServiceTierMode === "explicit" && typeof value.requestedServiceTier === "string";
  return Number.isSafeInteger(value.ordinal) && Number(value.ordinal) > 0 &&
    (value.attemptDigest === null || typeof value.attemptDigest === "string" && OBSERVER_DIGEST.test(value.attemptDigest)) &&
    (value.requestKind === "agent" || value.requestKind === "auxiliary" ||
      value.requestKind === "tool_provider" || value.requestKind === "title") &&
    nullableString(value.requestedModel) && nullableString(value.requestedReasoning) &&
    nullableString(value.requestedServiceTier) && nullableString(value.authorizationScheme) &&
    nullableString(value.routeId) &&
    requestedTierValid &&
    typeof value.requestStartedAtMs === "number" && Number.isFinite(value.requestStartedAtMs) &&
    Number.isSafeInteger(value.serializedRequestBytes) && Number(value.serializedRequestBytes) >= 0 &&
    digestValid &&
    (value.serializerContract === null || value.serializerContract === "butler.openai-codex-final-json.v1" ||
      value.serializerContract === "butler.openai-responses-final-json.v1") &&
    typeof value.exactResultReadSchemaObserved === "boolean" &&
    typeof value.hasTextContent === "boolean" && typeof value.hasToolArgumentContent === "boolean" &&
    typeof value.hasReasoningContent === "boolean" &&
    nullableFiniteNumber(value.firstContentBearingDeltaAtMs) &&
    nullableFiniteNumber(value.completedAtMs) && nullableFiniteNumber(value.terminatedAtMs) &&
    (value.termination === null || value.termination === "cancelled" || value.termination === "completed" ||
      value.termination === "failed") &&
    (value.status === null || Number.isSafeInteger(value.status)) &&
    Number.isSafeInteger(value.streamedTextChars) && Number(value.streamedTextChars) >= 0 &&
    Number.isSafeInteger(value.finalTextChars) && Number(value.finalTextChars) >= 0 &&
    nullableString(value.providerReportedModel) && tierValid;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const nullableFiniteNumber = (value: unknown): boolean => value === null ||
  typeof value === "number" && Number.isFinite(value);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
