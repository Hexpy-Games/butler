export const INTERNAL_RECOVERY_REQUIRED_CODE = "internal_recovery_required";

export type InternalRecoveryState =
  | "recovering_internal"
  | "needs_evidence";

export type ToolCallRepairState =
  | "needs_tool_surface"
  | "needs_argument_repair";

export interface InternalRecoveryFailureInput {
  code?: string;
  name?: string;
  message?: string;
  historicalRecoveryState?: boolean;
}

export function isGoalCompletionIncompleteFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "GoalCompletionIncompleteError") return true;
  const failure = normalizeInternalRecoveryInput(error);
  return failure.code === "goal_completion_incomplete";
}

export function isInternalRecoveryFailure(input: InternalRecoveryFailureInput | unknown): boolean {
  const failure = normalizeInternalRecoveryInput(input);
  if (!failure.historicalRecoveryState) return false;
  return (
    failure.code === INTERNAL_RECOVERY_REQUIRED_CODE ||
    failure.code === "goal_completion_incomplete" ||
    failure.code === "internal_uncertainty" ||
    failure.code === "prompt_usage_model_call_budget_exhausted" ||
    failure.code === "missing_evidence" ||
    failure.code === "candidate_only_evidence" ||
    failure.code === "completion_gap" ||
    failure.code === "completion_review_incomplete" ||
    failure.name === "PromptUsageModelCallBudgetExhaustedError" ||
    failure.name === "GoalCompletionIncompleteError"
  );
}

export function isToolCallRepairFailure(input: InternalRecoveryFailureInput | unknown): boolean {
  const failure = normalizeInternalRecoveryInput(input);
  if (!failure.historicalRecoveryState) return false;
  return (
    failure.code === "unknown_tool" ||
    failure.code === "disabled_tool" ||
    failure.code === "missing_tool_surface" ||
    failure.code === "invalid_tool_arguments" ||
    failure.code === "tool_arguments_validation_failed"
  );
}

export function internalRecoveryStateForFailure(
  input: InternalRecoveryFailureInput | unknown,
): InternalRecoveryState {
  const failure = normalizeInternalRecoveryInput(input);
  if (
    failure.code === "goal_completion_incomplete" ||
    failure.code === "missing_evidence" ||
    failure.code === "candidate_only_evidence" ||
    failure.code === "completion_gap" ||
    failure.code === "completion_review_incomplete" ||
    failure.name === "GoalCompletionIncompleteError"
  ) {
    return "needs_evidence";
  }
  return "recovering_internal";
}

export function toolCallRepairStateForFailure(
  input: InternalRecoveryFailureInput | unknown,
): ToolCallRepairState {
  const failure = normalizeInternalRecoveryInput(input);
  if (
    failure.code === "unknown_tool" ||
    failure.code === "disabled_tool" ||
    failure.code === "missing_tool_surface"
  ) {
    return "needs_tool_surface";
  }
  return "needs_argument_repair";
}

export function safeInternalRecoveryMessage(
  message: string,
  fallback = "Butler could not verify that the requested goal was completed.",
): string {
  if (isCompletionObligationProtocolMessage(message)) return fallback;
  if (/prompt usage model-call budget exhausted/iu.test(message)) {
    return fallback;
  }
  return safeRecoveryText(message) ?? fallback;
}

export function isCompletionObligationProtocolMessage(message: string): boolean {
  return /(?:unsatisfied|missing|unresolved) public completion obligation/iu.test(message);
}

function normalizeInternalRecoveryInput(input: InternalRecoveryFailureInput | unknown): InternalRecoveryFailureInput {
  if (input instanceof Error) {
    const record = input as Error & {
      code?: unknown;
      historicalRecoveryState?: unknown;
    };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      name: input.name,
      message: input.message,
      historicalRecoveryState: record.historicalRecoveryState === true,
    };
  }
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
      historicalRecoveryState: record.historicalRecoveryState === true,
    };
  }
  return {
    message: typeof input === "string" ? input : "",
  };
}

function safeRecoveryText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  const normalized = text
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || containsPrivatePath(normalized) || /raw prompt text/iu.test(normalized)) {
    return undefined;
  }
  return normalized.slice(0, 500);
}

function containsPrivatePath(value: string): boolean {
  return (
    /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/[^/\s]+|~\/|\$HOME\/|[A-Za-z]:\\Users\\[^\\\s]+)/u
      .test(value)
  );
}
