import { isRuntimeCancellationFailure } from "./runtime-cancellation.ts";
import {
  isExactOrStatusOperationalFailure,
  isOperationalFailure,
  operationalSafeErrorCode,
} from "./operational-failure.ts";
import {
  INTERNAL_RECOVERY_REQUIRED_CODE,
  isInternalRecoveryFailure as isSharedInternalRecoveryFailure,
  isToolCallRepairFailure as isSharedToolCallRepairFailure,
  internalRecoveryStateForFailure,
  toolCallRepairStateForFailure,
} from "../../runtime/internal-recovery-failure.ts";

export type RuntimeDeliveryState =
  | "running"
  | "recovering_internal"
  | "needs_tool_surface"
  | "needs_evidence"
  | "needs_argument_repair"
  | "waiting_user"
  | "system_error"
  | "cancelled"
  | "delivered"
  | "delivered_with_limitations"
  | "failed_system"
  | "runtime_fault";

export type RuntimeDeliveryTerminalState =
  | "delivered"
  | "delivered_with_limitations"
  | "failed_system"
  | "cancelled";

export type RuntimeDeliveryVisibility =
  | "assistant_output"
  | "recovery_progress"
  | "continuation_progress"
  | "tool_retry_progress"
  | "user_action_required"
  | "failure_notice"
  | "cancelled_notice";

export type RuntimeDeliveryIssueKind =
  | "none"
  | "internal_recovery"
  | "tool_call_repair"
  | "completion_continuation"
  | "runtime_continuation"
  | "limitation"
  | "user_action_blocker"
  | "system_failure"
  | "runtime_fault"
  | "cancelled";

export interface RuntimeDeliveryFailureInput {
  code?: string;
  name?: string;
  message?: string;
  statusCode?: number;
  retryable?: boolean;
  historicalRecoveryState?: boolean;
}

export interface RuntimeDeliveryClassification {
  delivery_state: RuntimeDeliveryState;
  terminal: boolean;
  issue_kind: RuntimeDeliveryIssueKind;
  visibility: RuntimeDeliveryVisibility;
  failure_notice: boolean;
  safe_error_code?: string;
  limitation_codes: string[];
  limitations: string[];
}

export function deliveredDeliveryState(): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "delivered",
    terminal: true,
    issueKind: "none",
    visibility: "assistant_output",
  });
}

export function deliveredWithLimitationsState(input: {
  limitationCodes?: string[];
  limitations?: string[];
}): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "delivered_with_limitations",
    terminal: true,
    issueKind: "limitation",
    visibility: "assistant_output",
    limitationCodes: input.limitationCodes,
    limitations: input.limitations,
  });
}

export function recoveringInternalDeliveryState(input: {
  state: Extract<RuntimeDeliveryState, "recovering_internal" | "needs_evidence">;
  limitationCodes?: string[];
  limitations?: string[];
}): RuntimeDeliveryClassification {
  return classification({
    deliveryState: input.state,
    terminal: false,
    issueKind: "internal_recovery",
    visibility: "recovery_progress",
    limitationCodes: input.limitationCodes,
    limitations: input.limitations,
  });
}

export function waitingUserDeliveryState(input: {
  safeErrorCode?: string;
  limitations?: string[];
} = {}): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "waiting_user",
    terminal: false,
    issueKind: "user_action_blocker",
    visibility: "user_action_required",
    safeErrorCode: input.safeErrorCode ?? "user_action_required",
    limitations: input.limitations,
  });
}

export function classifyRuntimeFailureDelivery(input: RuntimeDeliveryFailureInput | unknown): RuntimeDeliveryClassification {
  const failure = normalizeFailureInput(input);
  if (isCancelFailure(failure)) {
    return classification({
      deliveryState: "cancelled",
      terminal: true,
      issueKind: "cancelled",
      visibility: "cancelled_notice",
      safeErrorCode: "turn_cancelled",
    });
  }
  if (isToolCallRepairFailure(failure)) {
    return historicalRepairDeliveryState(failure);
  }
  if (isInternalRecoveryFailure(failure)) {
    return historicalInternalRecoveryDeliveryState(failure);
  }
  if (isRuntimeFaultFailureInput(failure)) {
    return runtimeFaultDeliveryState(failure);
  }
  if (isExactOrStatusOperationalFailure(failure)) {
    return systemFailureDeliveryState(failure);
  }
  if (isUserActionBlocker(failure)) {
    return waitingUserDeliveryState({
      safeErrorCode: safeCode(failure.code ?? "user_action_required"),
      limitations: [safeLimitationText(failure.message, "User action is required before Butler can continue.")],
    });
  }
  if (isLiveToolObservationGap(failure)) {
    return liveKernelContinuationState();
  }
  if (isLiveKernelContinuationGap(failure)) {
    return liveKernelContinuationState();
  }
  if (isOperationalFailure(failure)) {
    return systemFailureDeliveryState(failure);
  }
  return systemFailureDeliveryState(failure);
}

function liveKernelContinuationState(): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "running",
    terminal: false,
    issueKind: "none",
    visibility: "continuation_progress",
  });
}

function historicalRepairDeliveryState(
  failure: RuntimeDeliveryFailureInput,
): RuntimeDeliveryClassification {
  return classification({
    deliveryState: toolCallRepairStateForFailure(failure),
    terminal: false,
    issueKind: "tool_call_repair",
    visibility: "tool_retry_progress",
    limitationCodes: [safeCode(failure.code ?? "tool_call_repair")],
  });
}

function historicalInternalRecoveryDeliveryState(
  failure: RuntimeDeliveryFailureInput,
): RuntimeDeliveryClassification {
  const state = recoveryStateForInternalFailure(failure);
  return classification({
    deliveryState: state,
    terminal: false,
    issueKind: state === "needs_evidence"
      ? "completion_continuation"
      : "runtime_continuation",
    visibility: "continuation_progress",
    limitationCodes: [safeCode(failure.code ?? INTERNAL_RECOVERY_REQUIRED_CODE)],
  });
}

function runtimeFaultDeliveryState(
  failure: RuntimeDeliveryFailureInput,
): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "runtime_fault",
    terminal: true,
    issueKind: "runtime_fault",
    visibility: "failure_notice",
    safeErrorCode: safeCode(failure.code ?? "runtime_fault"),
  });
}

function systemFailureDeliveryState(failure: RuntimeDeliveryFailureInput): RuntimeDeliveryClassification {
  return classification({
    deliveryState: "failed_system",
    terminal: true,
    issueKind: "system_failure",
    visibility: "failure_notice",
    safeErrorCode: safeCode(operationalSafeErrorCode(failure)),
  });
}

export function isUserFacingFailureDelivery(state: RuntimeDeliveryClassification): boolean {
  return state.visibility === "failure_notice" || state.delivery_state === "failed_system";
}

function classification(input: {
  deliveryState: RuntimeDeliveryState;
  terminal: boolean;
  issueKind: RuntimeDeliveryIssueKind;
  visibility: RuntimeDeliveryVisibility;
  safeErrorCode?: string;
  limitationCodes?: string[];
  limitations?: string[];
}): RuntimeDeliveryClassification {
  const limitationCodes = (input.limitationCodes ?? []).map(safeCode).filter(Boolean).slice(0, 8);
  const limitations = (input.limitations ?? [])
    .map((value) => safeLimitationText(value, "A runtime limitation remained."))
    .filter(Boolean)
    .slice(0, 8);
  return {
    delivery_state: input.deliveryState,
    terminal: input.terminal,
    issue_kind: input.issueKind,
    visibility: input.visibility,
    failure_notice: input.visibility === "failure_notice",
    ...(input.safeErrorCode ? { safe_error_code: safeCode(input.safeErrorCode) } : {}),
    limitation_codes: limitationCodes,
    limitations,
  };
}

function normalizeFailureInput(input: RuntimeDeliveryFailureInput | unknown): RuntimeDeliveryFailureInput {
  if (input instanceof Error) {
    const record = input as Error & {
      code?: unknown;
      statusCode?: unknown;
      retryable?: unknown;
      historicalRecoveryState?: unknown;
    };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      name: input.name,
      message: input.message,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
      historicalRecoveryState: record.historicalRecoveryState === true,
    };
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
      historicalRecoveryState: record.historicalRecoveryState === true,
    };
  }
  return {
    message: typeof input === "string" ? input : "Unknown runtime failure",
  };
}

function isCancelFailure(failure: RuntimeDeliveryFailureInput): boolean {
  return isRuntimeCancellationFailure(failure);
}

function isInternalRecoveryFailure(failure: RuntimeDeliveryFailureInput): boolean {
  return isSharedInternalRecoveryFailure(failure);
}

function isToolCallRepairFailure(failure: RuntimeDeliveryFailureInput): boolean {
  return isSharedToolCallRepairFailure(failure);
}

export function isRuntimeFaultFailure(input: unknown): boolean {
  return isRuntimeFaultFailureInput(normalizeFailureInput(input));
}

function isRuntimeFaultFailureInput(failure: RuntimeDeliveryFailureInput): boolean {
  return failure.code === "runtime_fault" ||
    failure.code === "runtime_invariant_violation" ||
    failure.name === "RuntimeFaultError";
}

function isLiveKernelContinuationGap(failure: RuntimeDeliveryFailureInput): boolean {
  return (
    failure.code === INTERNAL_RECOVERY_REQUIRED_CODE ||
    failure.code === "goal_completion_incomplete" ||
    failure.code === "internal_uncertainty" ||
    failure.code === "completion_gap" ||
    failure.code === "completion_review_incomplete" ||
    failure.code === "prompt_usage_model_call_budget_exhausted" ||
    failure.code === "missing_evidence" ||
    failure.code === "candidate_only_evidence" ||
    failure.name === "GoalCompletionIncompleteError" ||
    failure.name === "PromptUsageModelCallBudgetExhaustedError"
  );
}

function isLiveToolObservationGap(failure: RuntimeDeliveryFailureInput): boolean {
  return (
    failure.code === "unknown_tool" ||
    failure.code === "disabled_tool" ||
    failure.code === "missing_tool_surface" ||
    failure.code === "invalid_tool_arguments" ||
    failure.code === "tool_arguments_validation_failed"
  );
}

function recoveryStateForInternalFailure(
  failure: RuntimeDeliveryFailureInput,
): Extract<RuntimeDeliveryState, "recovering_internal" | "needs_evidence"> {
  return internalRecoveryStateForFailure(failure);
}

function isUserActionBlocker(failure: RuntimeDeliveryFailureInput): boolean {
  return (
    failure.code === "permission_denied" ||
    failure.code === "confirmation_required" ||
    failure.code === "credential_required" ||
    failure.code === "captcha_required" ||
    failure.code === "payment_required"
  );
}

function safeCode(value: string): string {
  return value
    .replace(/[^a-z0-9_.:-]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase()
    .slice(0, 80) || "runtime_failure";
}

export function safeLimitationText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/^(?:INCOMPLETE|미완료)\s*[:：]\s*/iu, "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return fallback;
  if (containsPrivatePath(normalized) || /raw prompt text/iu.test(normalized)) return fallback;
  return normalized.slice(0, 240);
}

function containsPrivatePath(value: string): boolean {
  return (
    /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/[^/\s]+|~\/|\$HOME\/|[A-Za-z]:\\Users\\[^\\\s]+)/u
      .test(value)
  );
}
