import { sanitizePublicText } from "./public-text.ts";

export const TURN_ACKNOWLEDGED_EVENT_KIND = "turn.acknowledged";
export const TURN_DECISION_EVENT_KIND = "turn.decision";
export const TURN_COMPLETION_EVIDENCE_EVENT_KIND = "turn.completion_evidence";
export const TURN_OUTCOME_EVENT_KIND = "turn.outcome";
export const RUNTIME_FAULT_EVENT_KIND = "runtime.fault";
export const RECOVERY_RECORDED_EVENT_KIND = "recovery.recorded";
export const DIAGNOSTIC_INVARIANT_VIOLATION_EVENT_KIND = "diagnostic.invariant_violation";

export const TURN_STATE_CONTRACT_EVENT_KINDS = [
  TURN_ACKNOWLEDGED_EVENT_KIND,
  TURN_DECISION_EVENT_KIND,
  TURN_COMPLETION_EVIDENCE_EVENT_KIND,
  TURN_OUTCOME_EVENT_KIND,
  RUNTIME_FAULT_EVENT_KIND,
  RECOVERY_RECORDED_EVENT_KIND,
  DIAGNOSTIC_INVARIANT_VIOLATION_EVENT_KIND,
] as const;

export type TurnStateContractEventKind = typeof TURN_STATE_CONTRACT_EVENT_KINDS[number];

export const AUTHORED_DECISION_SOURCES = [
  "assistant-authored",
] as const;

export const DIAGNOSTIC_DECISION_SOURCES = [
  "runtime-derived",
  "review-repaired",
] as const;

export type AuthoredDecisionSource = typeof AUTHORED_DECISION_SOURCES[number];
export type DiagnosticDecisionSource = typeof DIAGNOSTIC_DECISION_SOURCES[number];
export type PublicDecisionSource = AuthoredDecisionSource;

export const COMPLETION_EVIDENCE_KINDS = [
  "source_verified",
  "command_executed",
  "test_passed",
  "test_failed",
  "artifact_exists",
  "pr_verified",
  "release_verified",
  "route_verified",
  "user_decision_required",
  "cancelled",
  "runtime_failed",
] as const;

export type CompletionEvidenceKind = typeof COMPLETION_EVIDENCE_KINDS[number];

export const TURN_OUTCOMES = [
  "completed",
  "failed",
  "runtime_fault",
  "cancelled",
  "waiting_user",
  "recoverable",
] as const;

export type TurnOutcome = typeof TURN_OUTCOMES[number];

export const RECOVERY_KINDS = [
  "runtime_process_crash",
  "provider_stream_corruption",
  "storage_invariant_violation",
  "api_protocol_invariant_violation",
  "queue_claim_invariant_violation",
  "compaction_invariant_violation",
] as const;

export type RecoveryKind = typeof RECOVERY_KINDS[number];

const AUTHORED_DECISION_SOURCE_SET = new Set<string>(AUTHORED_DECISION_SOURCES);
const COMPLETION_EVIDENCE_KIND_SET = new Set<string>(COMPLETION_EVIDENCE_KINDS);
const TURN_OUTCOME_SET = new Set<string>(TURN_OUTCOMES);
const RECOVERY_KIND_SET = new Set<string>(RECOVERY_KINDS);

export interface TurnAcknowledgedPayloadInput {
  safeLabel?: unknown;
  transport?: unknown;
}

export interface TurnDecisionPayloadInput {
  decisionId: unknown;
  summary: unknown;
  rationale?: unknown;
  nextStep?: unknown;
  source: unknown;
  evidenceRefs?: unknown;
}

export interface CompletionEvidencePayloadInput {
  evidenceKind: unknown;
  status: unknown;
  summary: unknown;
  refs?: unknown;
}

export interface TurnOutcomePayloadInput {
  outcome: unknown;
  completionEvidenceRefs?: unknown;
  completionEvidenceStatus?: unknown;
  recoveryToken?: unknown;
  publicSummary: unknown;
}

export interface RuntimeFaultPayloadInput {
  faultId?: unknown;
  sessionId?: unknown;
  turnId?: unknown;
  kind: unknown;
  retryable: unknown;
  publicSummary: unknown;
  operatorSummary: unknown;
  safeErrorCode?: unknown;
  safeCause?: unknown;
  createdAt?: unknown;
}

export interface RecoveryRecordedPayloadInput {
  recoveryToken: unknown;
  reason: unknown;
  workStreamId?: unknown;
  todoListId?: unknown;
  supportedControls?: unknown;
}

export interface DiagnosticInvariantViolationPayloadInput {
  invariant: unknown;
  severity?: unknown;
  summary: unknown;
  refs?: unknown;
}

export function isAuthoredDecisionSource(source: unknown): source is AuthoredDecisionSource {
  return typeof source === "string" && AUTHORED_DECISION_SOURCE_SET.has(source);
}

export function createTurnAcknowledgedPayload(
  input: TurnAcknowledgedPayloadInput = {},
): Record<string, unknown> {
  return {
    safeLabel: sanitizePublicText(
      input.safeLabel,
      "Request received. Preparing the work.",
    ),
    transport: sanitizePublicText(input.transport, "app"),
  };
}

export function createTurnDecisionPayload(input: TurnDecisionPayloadInput): Record<string, unknown> {
  if (!isAuthoredDecisionSource(input.source)) {
    throw new Error("public turn decision source must be authored");
  }
  const decisionId = requiredSafeText(input.decisionId, "turn decision id is required");
  const summary = requiredSafeText(input.summary, "turn decision summary is required");
  const rationale = optionalSafeText(input.rationale);
  const nextStep = optionalSafeText(input.nextStep);
  const evidenceRefs = safeStringArray(input.evidenceRefs);
  return {
    decisionId,
    summary,
    ...(rationale ? { rationale } : {}),
    ...(nextStep ? { nextStep } : {}),
    source: input.source,
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  };
}

export function createCompletionEvidencePayload(
  input: CompletionEvidencePayloadInput,
): Record<string, unknown> {
  const evidenceKind = requiredSafeText(input.evidenceKind, "completion evidence kind is required");
  if (!COMPLETION_EVIDENCE_KIND_SET.has(evidenceKind)) {
    throw new Error(`unknown completion evidence kind: ${evidenceKind}`);
  }
  const status = requiredSafeText(input.status, "completion evidence status is required");
  const summary = requiredSafeText(input.summary, "completion evidence summary is required");
  return {
    evidenceKind,
    status,
    summary,
    refs: safeStringArray(input.refs),
  };
}

export function createTurnOutcomePayload(input: TurnOutcomePayloadInput): Record<string, unknown> {
  const outcome = requiredSafeText(input.outcome, "turn outcome is required");
  if (!TURN_OUTCOME_SET.has(outcome)) {
    throw new Error(`unknown turn outcome: ${outcome}`);
  }
  const completionEvidenceRefs = safeStringArray(input.completionEvidenceRefs);
  const completionEvidenceStatus = optionalSafeText(input.completionEvidenceStatus);
  if (completionEvidenceStatus && completionEvidenceStatus !== "not_required") {
    throw new Error("turn outcome completion evidence status must be not_required");
  }
  const recoveryToken = optionalSafeText(input.recoveryToken);
  if (
    outcome === "completed" &&
    completionEvidenceRefs.length === 0 &&
    completionEvidenceStatus !== "not_required"
  ) {
    throw new Error("completed turn outcome requires completion evidence refs or not_required evidence status");
  }
  if ((outcome === "recoverable" || outcome === "waiting_user") && !recoveryToken) {
    throw new Error(`${outcome} turn outcome requires a recovery token`);
  }
  return {
    outcome,
    completionEvidenceRefs,
    ...(completionEvidenceStatus ? { completionEvidenceStatus } : {}),
    ...(recoveryToken ? { recoveryToken } : {}),
    publicSummary: requiredSafeText(input.publicSummary, "turn outcome public summary is required"),
  };
}

export function createRuntimeFaultPayload(input: RuntimeFaultPayloadInput): Record<string, unknown> {
  const faultId = requiredSafeText(input.faultId, "runtime fault id is required");
  const sessionId = optionalSafeText(input.sessionId);
  const turnId = requiredSafeText(input.turnId, "runtime fault turn id is required");
  const kind = requiredSafeText(input.kind, "runtime fault kind is required");
  if (!RECOVERY_KIND_SET.has(kind)) {
    throw new Error(`unknown runtime fault recovery kind: ${kind}`);
  }
  if (typeof input.retryable !== "boolean") {
    throw new Error("runtime fault retryable must be an explicit boolean");
  }
  const publicSummary = requiredSafeText(input.publicSummary, "runtime fault public summary is required");
  const operatorSummary = requiredSafeText(input.operatorSummary, "runtime fault operator summary is required");
  const safeErrorCode = optionalSafeText(input.safeErrorCode);
  const safeCause = optionalSafeText(input.safeCause);
  const createdAt = requiredSafeText(input.createdAt, "runtime fault createdAt is required");
  return {
    faultId,
    ...(sessionId ? { sessionId } : {}),
    turnId,
    kind,
    retryable: input.retryable,
    publicSummary,
    operatorSummary,
    ...(safeErrorCode ? { safeErrorCode } : {}),
    ...(safeCause ? { safeCause } : {}),
    createdAt,
  };
}

export function createRecoveryRecordedPayload(
  input: RecoveryRecordedPayloadInput,
): Record<string, unknown> {
  const supportedControls = safeStringArray(input.supportedControls);
  const workStreamId = optionalSafeText(input.workStreamId);
  const todoListId = optionalSafeText(input.todoListId);
  return {
    recoveryToken: requiredSafeText(input.recoveryToken, "recovery token is required"),
    reason: requiredSafeText(input.reason, "recovery reason is required"),
    ...(workStreamId ? { workStreamId } : {}),
    ...(todoListId ? { todoListId } : {}),
    ...(supportedControls.length > 0 ? { supportedControls } : {}),
  };
}

export function createDiagnosticInvariantViolationPayload(
  input: DiagnosticInvariantViolationPayloadInput,
): Record<string, unknown> {
  const severity = optionalSafeText(input.severity) ?? "warning";
  if (severity !== "warning" && severity !== "error") {
    throw new Error("diagnostic invariant severity must be warning or error");
  }
  return {
    invariant: requiredSafeText(input.invariant, "diagnostic invariant is required"),
    severity,
    summary: requiredSafeText(input.summary, "diagnostic summary is required"),
    refs: safeStringArray(input.refs),
  };
}

export function normalizeTurnStateContractPayload(
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (kind === TURN_ACKNOWLEDGED_EVENT_KIND) {
    return createTurnAcknowledgedPayload(payload);
  }
  if (kind === TURN_DECISION_EVENT_KIND) {
    return createTurnDecisionPayload({
      decisionId: payload.decisionId,
      summary: payload.summary ?? payload.decisionSummary,
      rationale: payload.rationale ?? payload.decisionRationale,
      nextStep: payload.nextStep ?? payload.decisionNextStep,
      source: payload.source ?? payload.decisionSource,
      evidenceRefs: payload.evidenceRefs ?? payload.decisionEvidenceRefs,
    });
  }
  if (kind === TURN_COMPLETION_EVIDENCE_EVENT_KIND) {
    return createCompletionEvidencePayload({
      evidenceKind: payload.evidenceKind,
      status: payload.status,
      summary: payload.summary,
      refs: payload.refs,
    });
  }
  if (kind === TURN_OUTCOME_EVENT_KIND) {
    return createTurnOutcomePayload({
      outcome: payload.outcome,
      completionEvidenceRefs: payload.completionEvidenceRefs,
      completionEvidenceStatus: payload.completionEvidenceStatus,
      recoveryToken: payload.recoveryToken,
      publicSummary: payload.publicSummary,
    });
  }
  if (kind === RUNTIME_FAULT_EVENT_KIND) {
    return createRuntimeFaultPayload({
      faultId: payload.faultId,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      kind: payload.kind,
      retryable: payload.retryable,
      publicSummary: payload.publicSummary,
      operatorSummary: payload.operatorSummary,
      safeErrorCode: payload.safeErrorCode,
      safeCause: payload.safeCause,
      createdAt: payload.createdAt,
    });
  }
  if (kind === RECOVERY_RECORDED_EVENT_KIND) {
    return createRecoveryRecordedPayload({
      recoveryToken: payload.recoveryToken,
      reason: payload.reason,
      workStreamId: payload.workStreamId,
      todoListId: payload.todoListId,
      supportedControls: payload.supportedControls,
    });
  }
  if (kind === DIAGNOSTIC_INVARIANT_VIOLATION_EVENT_KIND) {
    return createDiagnosticInvariantViolationPayload({
      invariant: payload.invariant,
      severity: payload.severity,
      summary: payload.summary,
      refs: payload.refs,
    });
  }
  return null;
}

function requiredSafeText(value: unknown, message: string): string {
  const text = optionalSafeText(value);
  if (!text) throw new Error(message);
  return text;
}

function optionalSafeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = sanitizePublicText(value, "");
  return text || null;
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => optionalSafeText(item))
    .filter((item): item is string => Boolean(item));
}
