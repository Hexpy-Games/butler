import { isRuntimeCancellationFailure } from "./runtime-cancellation.ts";
import { isOperationalFailure, operationalSafeErrorCode } from "./operational-failure.ts";
import {
  INTERNAL_RECOVERY_REQUIRED_CODE,
  isInternalRecoveryFailure as isSharedInternalRecoveryFailure,
  internalRecoveryStateForFailure,
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
  | "failed_system";

export type RuntimeDeliveryTerminalState =
  | "delivered"
  | "delivered_with_limitations"
  | "failed_system"
  | "cancelled";

export type RuntimeDeliveryVisibility =
  | "assistant_output"
  | "recovery_progress"
  | "user_action_required"
  | "failure_notice"
  | "cancelled_notice";

export type RuntimeDeliveryIssueKind =
  | "none"
  | "internal_recovery"
  | "limitation"
  | "user_action_blocker"
  | "system_failure"
  | "cancelled";

export interface RuntimeDeliveryFailureInput {
  code?: string;
  name?: string;
  message?: string;
  statusCode?: number;
  retryable?: boolean;
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
  state: Extract<RuntimeDeliveryState, "recovering_internal" | "needs_tool_surface" | "needs_evidence" | "needs_argument_repair">;
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
  if (isInternalRecoveryFailure(failure)) {
    return classification({
      deliveryState: recoveryStateForInternalFailure(failure),
      terminal: false,
      issueKind: "internal_recovery",
      visibility: "recovery_progress",
      limitationCodes: [safeCode(failure.code ?? INTERNAL_RECOVERY_REQUIRED_CODE)],
    });
  }
  if (isOperationalFailure(failure)) {
    return systemFailureDeliveryState(failure);
  }
  if (isUserActionBlocker(failure)) {
    return waitingUserDeliveryState({
      safeErrorCode: safeCode(failure.code ?? "user_action_required"),
      limitations: [safeLimitationText(failure.message, "User action is required before Butler can continue.")],
    });
  }
  return systemFailureDeliveryState(failure);
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
    };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      name: input.name,
      message: input.message,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
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

function recoveryStateForInternalFailure(
  failure: RuntimeDeliveryFailureInput,
): Extract<RuntimeDeliveryState, "recovering_internal" | "needs_tool_surface" | "needs_evidence" | "needs_argument_repair"> {
  return internalRecoveryStateForFailure(failure);
}

function isUserActionBlocker(failure: RuntimeDeliveryFailureInput): boolean {
  const message = failure.message ?? "";
  return (
    failure.code === "permission_denied" ||
    failure.code === "confirmation_required" ||
    failure.code === "credential_required" ||
    /permission denied|confirmation required|credential required|captcha|login required|payment required/iu
      .test(message)
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
