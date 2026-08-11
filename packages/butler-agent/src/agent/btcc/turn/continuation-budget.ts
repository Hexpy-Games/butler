import type {
  TurnContinuationBudgetLimits,
  TurnContinuationBudgetState,
  TurnContinuationBudgetTerminalReason,
} from "./contracts.ts";
import {
  continuationResultRefLimit,
  exactRecord,
  finiteNonNegativeInteger,
  nullableFiniteNonNegativeInteger,
  parseRefs,
  requiredText,
  validateLimits,
} from "./continuation-budget-validation.ts";

export { modelRoundRequestDigest } from "../ports/model-round.ts";
export { continuationResultRefLimit } from "./continuation-budget-validation.ts";

export const TURN_CONTINUATION_BUDGET_SCHEMA_VERSION =
  "butler.turn-continuation-budget.v1" as const;

export type { TurnContinuationBudgetLimits };

export type TurnContinuationBudgetEvent =
  | { kind: "model_dispatch" }
  | { kind: "tool_round" }
  | { kind: "token_usage"; promptTokens: number | null; outputTokens: number | null }
  | { kind: "durable_result_refs"; refs: readonly string[] }
  | { kind: "no_progress" }
  | { kind: "storage_failure" };

export type TurnContinuationTerminalReceipt = {
  code: "turn_continuation_budget_exhausted";
  schemaVersion: typeof TURN_CONTINUATION_BUDGET_SCHEMA_VERSION;
  turnId: string;
  status: "exhausted";
  reason: TurnContinuationBudgetTerminalReason;
  exhaustedAtMs: number;
};

/** A fail-closed durability/configuration error without fabricated limits. */
export class TurnContinuationBudgetStorageError extends Error {
  readonly code = "turn_continuation_budget_storage_failure" as const;

  constructor(readonly turnId: string, cause?: unknown) {
    super("Turn continuation budget could not be admitted or persisted", {
      cause,
    });
    this.name = "TurnContinuationBudgetStorageError";
  }
}

export class TurnContinuationBudgetConfigurationError extends Error {
  readonly code = "turn_continuation_budget_configuration_failure" as const;

  constructor(readonly turnId: string, cause?: unknown) {
    super("Turn continuation budget requires explicit finite limits", { cause });
    this.name = "TurnContinuationBudgetConfigurationError";
  }
}

export class TurnContinuationBudgetExhaustedError extends Error {
  readonly code = "turn_continuation_budget_exhausted";
  readonly receipt: TurnContinuationTerminalReceipt;
  readonly state: TurnContinuationBudgetState;

  constructor(state: TurnContinuationBudgetState) {
    const reason = state.terminal.reason;
    const exhaustedAtMs = state.terminal.exhaustedAtMs;
    if (state.terminal.status !== "exhausted" || !reason || exhaustedAtMs === null) {
      throw new Error("Turn continuation terminal receipt requires exhausted state");
    }
    super(`Turn continuation budget exhausted: ${reason}`);
    this.name = "TurnContinuationBudgetExhaustedError";
    this.state = state;
    this.receipt = {
      code: this.code,
      schemaVersion: TURN_CONTINUATION_BUDGET_SCHEMA_VERSION,
      turnId: state.turnId,
      status: "exhausted",
      reason,
      exhaustedAtMs,
    };
  }
}

export function isTurnContinuationBudgetExhaustedError(
  value: unknown,
): value is TurnContinuationBudgetExhaustedError {
  if (value instanceof TurnContinuationBudgetExhaustedError) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TurnContinuationBudgetExhaustedError>;
  return candidate.code === "turn_continuation_budget_exhausted" &&
    candidate.receipt?.code === "turn_continuation_budget_exhausted" &&
    candidate.state?.terminal.status === "exhausted";
}

export function createTurnContinuationBudgetState(input: {
  turnId: string;
  limits: TurnContinuationBudgetLimits;
  nowMs: number;
}): TurnContinuationBudgetState {
  const limits = validateLimits(input.limits);
  continuationResultRefLimit(limits);
  const value: TurnContinuationBudgetState = {
    schemaVersion: TURN_CONTINUATION_BUDGET_SCHEMA_VERSION,
    turnId: requiredText(input.turnId, "turnId"),
    consumedModelRequests: 0,
    consumedToolRounds: 0,
    consumedPromptTokens: 0,
    consumedOutputTokens: 0,
    startedAtMs: finiteNonNegativeInteger(input.nowMs, "startedAtMs"),
    lastProgressAtMs: finiteNonNegativeInteger(input.nowMs, "lastProgressAtMs"),
    seenDurableResultRefs: [],
    limits,
    terminal: { status: "active", reason: null, exhaustedAtMs: null },
  };
  return value;
}

export function parseTurnContinuationBudgetState(
  value: unknown,
  expectedTurnId?: string,
): TurnContinuationBudgetState {
  const record = exactRecord(value, [
    "schemaVersion", "turnId", "consumedModelRequests", "consumedToolRounds",
    "consumedPromptTokens", "consumedOutputTokens", "startedAtMs",
    "lastProgressAtMs", "seenDurableResultRefs", "limits", "terminal",
  ], "Turn continuation budget");
  if (record.schemaVersion !== TURN_CONTINUATION_BUDGET_SCHEMA_VERSION) {
    throw new Error("Turn continuation budget schemaVersion is invalid");
  }
  const turnId = requiredText(record.turnId, "turnId");
  if (expectedTurnId !== undefined && turnId !== expectedTurnId) {
    throw new Error("Turn continuation budget turnId does not match Turn");
  }
  const limits = validateLimits(record.limits);
  const terminalRecord = exactRecord(
    record.terminal,
    ["status", "reason", "exhaustedAtMs"],
    "Turn continuation terminal",
  );
  const status = terminalRecord.status;
  if (status !== "active" && status !== "exhausted") {
    throw new Error("Turn continuation terminal status is invalid");
  }
  const reason = terminalRecord.reason;
  if (reason !== null && !TERMINAL_REASONS.has(
    reason as TurnContinuationBudgetTerminalReason,
  )) {
    throw new Error("Turn continuation terminal reason is invalid");
  }
  const exhaustedAtMs = terminalRecord.exhaustedAtMs === null
    ? null
    : finiteNonNegativeInteger(terminalRecord.exhaustedAtMs, "exhaustedAtMs");
  const validTerminalNulls = status === "active"
    ? reason === null && exhaustedAtMs === null
    : reason !== null && exhaustedAtMs !== null;
  if (!validTerminalNulls) {
    throw new Error("Turn continuation terminal null contract is invalid");
  }
  const counters = {
    consumedModelRequests: finiteNonNegativeInteger(
      record.consumedModelRequests,
      "consumedModelRequests",
    ),
    consumedToolRounds: finiteNonNegativeInteger(
      record.consumedToolRounds,
      "consumedToolRounds",
    ),
    consumedPromptTokens: finiteNonNegativeInteger(
      record.consumedPromptTokens,
      "consumedPromptTokens",
    ),
    consumedOutputTokens: finiteNonNegativeInteger(
      record.consumedOutputTokens,
      "consumedOutputTokens",
    ),
  };
  if (status === "active" && (
      counters.consumedModelRequests > limits.maxModelRequests ||
      counters.consumedToolRounds > limits.maxToolRounds ||
      counters.consumedPromptTokens > limits.maxPromptTokens ||
      counters.consumedOutputTokens > limits.maxOutputTokens)) {
    throw new Error("Turn continuation counters exceed their admitted limits");
  }
  const refs = parseRefs(record.seenDurableResultRefs, limits);
  const startedAtMs = finiteNonNegativeInteger(record.startedAtMs, "startedAtMs");
  const lastProgressAtMs = finiteNonNegativeInteger(
    record.lastProgressAtMs,
    "lastProgressAtMs",
  );
  if (lastProgressAtMs < startedAtMs) {
    throw new Error("Turn continuation lastProgressAtMs precedes startedAtMs");
  }
  return {
    schemaVersion: TURN_CONTINUATION_BUDGET_SCHEMA_VERSION,
    turnId,
    ...counters,
    startedAtMs,
    lastProgressAtMs,
    seenDurableResultRefs: refs,
    limits,
    terminal: {
      status,
      reason: reason as TurnContinuationBudgetTerminalReason | null,
      exhaustedAtMs,
    },
  };
}

export function transitionTurnContinuationBudget(
  current: TurnContinuationBudgetState,
  event: TurnContinuationBudgetEvent,
  nowMs: number,
): TurnContinuationBudgetState {
  const state = parseTurnContinuationBudgetState(current, current.turnId);
  const now = finiteNonNegativeInteger(nowMs, "nowMs");
  if (state.terminal.status === "exhausted") {
    throw new TurnContinuationBudgetExhaustedError(state);
  }
  const elapsedReason = now - state.startedAtMs >= state.limits.maxElapsedMs
    ? "max_elapsed_ms"
    : now - state.lastProgressAtMs >= state.limits.maxIdleMs
      ? "max_idle_ms"
      : null;
  if (elapsedReason) throw exhausted(state, elapsedReason, now);
  if (event.kind === "no_progress" || event.kind === "storage_failure") {
    throw exhausted(state, event.kind, now);
  }
  if (event.kind === "model_dispatch") {
    if (state.consumedModelRequests >= state.limits.maxModelRequests) {
      throw exhausted(state, "max_model_requests", now);
    }
    return {
      ...state,
      consumedModelRequests: state.consumedModelRequests + 1,
      lastProgressAtMs: now,
    };
  }
  if (event.kind === "tool_round") {
    if (state.consumedToolRounds >= state.limits.maxToolRounds) {
      throw exhausted(state, "max_tool_rounds", now);
    }
    return {
      ...state,
      consumedToolRounds: state.consumedToolRounds + 1,
      lastProgressAtMs: now,
    };
  }
  if (event.kind === "token_usage") {
    const promptTokens = nullableFiniteNonNegativeInteger(
      event.promptTokens,
      "promptTokens",
    );
    const outputTokens = nullableFiniteNonNegativeInteger(
      event.outputTokens,
      "outputTokens",
    );
    if (promptTokens === null && outputTokens === null) return state;
    const next = {
      ...state,
      consumedPromptTokens: addSafeNonNegativeIntegers(
        state.consumedPromptTokens,
        promptTokens ?? 0,
      ),
      consumedOutputTokens: addSafeNonNegativeIntegers(
        state.consumedOutputTokens,
        outputTokens ?? 0,
      ),
      lastProgressAtMs: now,
    };
    if (next.consumedPromptTokens >= state.limits.maxPromptTokens) {
      throw exhausted(next, "max_prompt_tokens", now);
    }
    if (next.consumedOutputTokens >= state.limits.maxOutputTokens) {
      throw exhausted(next, "max_output_tokens", now);
    }
    return next;
  }
  const additions = parseRefs(event.refs, state.limits);
  const refs = [...state.seenDurableResultRefs];
  for (const ref of additions) if (!refs.includes(ref)) refs.push(ref);
  if (refs.length > continuationResultRefLimit(state.limits)) {
    throw exhausted(state, "no_progress", now);
  }
  return refs.length === state.seenDurableResultRefs.length
    ? state
    : { ...state, seenDurableResultRefs: refs, lastProgressAtMs: now };
}

export function terminalReceiptFromState(
  state: TurnContinuationBudgetState,
): TurnContinuationTerminalReceipt {
  return new TurnContinuationBudgetExhaustedError(state).receipt;
}

function exhausted(
  state: TurnContinuationBudgetState,
  reason: TurnContinuationBudgetTerminalReason,
  nowMs: number,
): TurnContinuationBudgetExhaustedError {
  return new TurnContinuationBudgetExhaustedError({
    ...state,
    terminal: { status: "exhausted", reason, exhaustedAtMs: nowMs },
  });
}

/**
 * Saturate an unrepresentable exact sum at a safe upper bound. The saturated
 * counter is intentionally not an exact token count; the terminal reason is
 * the durable exhaustion fact and keeps the state parseable across restart.
 */
function addSafeNonNegativeIntegers(current: number, increment: number): number {
  if (increment > Number.MAX_SAFE_INTEGER - current) {
    return Number.MAX_SAFE_INTEGER;
  }
  return current + increment;
}

const TERMINAL_REASONS = new Set<TurnContinuationBudgetTerminalReason>([
  "max_model_requests", "max_tool_rounds", "max_prompt_tokens",
  "max_output_tokens", "max_elapsed_ms", "max_idle_ms", "no_progress",
  "storage_failure",
]);
