import { createHash } from "node:crypto";

export const TURN_CONTINUATION_BUDGET_SCHEMA =
  "butler.turn-continuation-budget.v2" as const;
export const TURN_CONTINUATION_EXHAUSTED_CODE =
  "turn_continuation_budget_exhausted" as const;

export type TurnContinuationBudgetLimits = {
  maxModelRequests: number;
  maxToolRounds: number;
  maxModelFacingBytes: number;
  maxCumulativeModelFacingBytes: number;
  maxOutputBytes: number;
  maxElapsedMs: number;
  maxIdleMs: number;
};

export type TurnContinuationBudgetTerminalReason =
  | "max_model_requests"
  | "max_tool_rounds"
  | "model_facing_bytes"
  | "max_cumulative_model_facing_bytes"
  | "max_output_bytes"
  | "max_elapsed_ms"
  | "max_idle_ms"
  | "admission_changed";

export type TurnContinuationAdmission = {
  roundId: string;
  requestDigest: string;
  modelFacingBytes: number;
};

export type TurnContinuationBudgetState = {
  schemaVersion: typeof TURN_CONTINUATION_BUDGET_SCHEMA;
  turnId: string;
  limits: TurnContinuationBudgetLimits;
  admittedRequests: readonly TurnContinuationAdmission[];
  completedOutputRounds: readonly string[];
  completedToolRounds: readonly string[];
  consumedOutputBytes: number;
  consumedModelFacingBytes: number;
  startedAtMs: number;
  lastProgressAtMs: number;
  terminal: null | {
    code: typeof TURN_CONTINUATION_EXHAUSTED_CODE;
    reason: TurnContinuationBudgetTerminalReason;
    exhaustedAtMs: number;
  };
};

export type TurnContinuationBudgetEvent =
  | { kind: "admit_request"; roundId: string; requestDigest: string; modelFacingBytes: number }
  | { kind: "record_output"; roundId: string; outputBytes: number }
  | { kind: "record_tool_round"; roundId: string };

const HARD_CEILINGS: TurnContinuationBudgetLimits = {
  maxModelRequests: 200,
  maxToolRounds: 200,
  maxModelFacingBytes: 4 * 1024 * 1024,
  maxCumulativeModelFacingBytes: 64 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxElapsedMs: 24 * 60 * 60 * 1_000,
  maxIdleMs: 60 * 60 * 1_000,
};

const DEFAULT_LIMITS: TurnContinuationBudgetLimits = {
  maxModelRequests: 60,
  maxToolRounds: 60,
  maxModelFacingBytes: 192 * 1024,
  maxCumulativeModelFacingBytes: 8 * 1024 * 1024,
  maxOutputBytes: 512 * 1024,
  maxElapsedMs: 2 * 60 * 60 * 1_000,
  maxIdleMs: 20 * 60 * 1_000,
};

const ENV_KEYS: Record<keyof TurnContinuationBudgetLimits, string> = {
  maxModelRequests: "BUTLER_M1_V2_CONTINUATION_MAX_MODEL_REQUESTS",
  maxToolRounds: "BUTLER_M1_V2_CONTINUATION_MAX_TOOL_ROUNDS",
  maxModelFacingBytes: "BUTLER_M1_V2_CONTINUATION_MAX_MODEL_FACING_BYTES",
  maxCumulativeModelFacingBytes:
    "BUTLER_M1_V2_CONTINUATION_MAX_CUMULATIVE_MODEL_FACING_BYTES",
  maxOutputBytes: "BUTLER_M1_V2_CONTINUATION_MAX_OUTPUT_BYTES",
  maxElapsedMs: "BUTLER_M1_V2_CONTINUATION_MAX_ELAPSED_MS",
  maxIdleMs: "BUTLER_M1_V2_CONTINUATION_MAX_IDLE_MS",
};

export function selectTurnContinuationBudget(
  env: Record<string, string | undefined> = process.env,
): TurnContinuationBudgetLimits | null {
  const flag = (env.BUTLER_M1_V2_BOUNDED_STATELESS_CONTEXT ?? "")
    .trim().toLowerCase();
  if (!["1", "true", "on", "yes"].includes(flag)) return null;
  const limits = { ...DEFAULT_LIMITS };
  for (const [field, key] of Object.entries(ENV_KEYS) as Array<
    [keyof TurnContinuationBudgetLimits, string]
  >) {
    const configured = env[key];
    if (configured === undefined || configured.trim() === "") continue;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`invalid_turn_continuation_limit:${key}`);
    }
    limits[field] = parsed;
  }
  return validateTurnContinuationLimits(limits);
}

export function validateTurnContinuationLimits(
  limits: TurnContinuationBudgetLimits,
): TurnContinuationBudgetLimits {
  for (const field of Object.keys(HARD_CEILINGS) as Array<keyof TurnContinuationBudgetLimits>) {
    const value = limits[field];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_CEILINGS[field]) {
      throw new Error(`unsafe_turn_continuation_limit:${field}`);
    }
  }
  return { ...limits };
}

export function createTurnContinuationBudgetState(input: {
  turnId: string;
  limits: TurnContinuationBudgetLimits;
  nowMs: number;
}): TurnContinuationBudgetState {
  return {
    schemaVersion: TURN_CONTINUATION_BUDGET_SCHEMA,
    turnId: requiredText(input.turnId),
    limits: validateTurnContinuationLimits(input.limits),
    admittedRequests: [],
    completedOutputRounds: [],
    completedToolRounds: [],
    consumedOutputBytes: 0,
    consumedModelFacingBytes: 0,
    startedAtMs: integer(input.nowMs),
    lastProgressAtMs: integer(input.nowMs),
    terminal: null,
  };
}

export function parseTurnContinuationBudgetState(
  value: unknown,
  turnId: string,
): TurnContinuationBudgetState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_continuation_budget");
  const state = value as TurnContinuationBudgetState;
  if (state.schemaVersion !== TURN_CONTINUATION_BUDGET_SCHEMA || state.turnId !== turnId) {
    throw new Error("invalid_continuation_budget_identity");
  }
  const limits = validateTurnContinuationLimits(state.limits);
  if (!Array.isArray(state.admittedRequests) || !Array.isArray(state.completedOutputRounds) ||
      !Array.isArray(state.completedToolRounds)) throw new Error("invalid_continuation_budget_rounds");
  if (state.admittedRequests.length > limits.maxModelRequests ||
      state.completedOutputRounds.length > limits.maxModelRequests ||
      state.completedToolRounds.length > limits.maxToolRounds) throw new Error("invalid_continuation_budget_bounds");
  const admittedRequests = state.admittedRequests.map((item) => ({
    roundId: requiredText(item.roundId),
    requestDigest: requiredDigest(item.requestDigest),
    modelFacingBytes: integer(item.modelFacingBytes),
  }));
  assertUnique(admittedRequests.map((item) => item.roundId));
  const completedOutputRounds = state.completedOutputRounds.map(requiredText);
  const completedToolRounds = state.completedToolRounds.map(requiredText);
  assertUnique(completedOutputRounds);
  assertUnique(completedToolRounds);
  const consumedOutputBytes = integer(state.consumedOutputBytes);
  const consumedModelFacingBytes = integer(state.consumedModelFacingBytes);
  if (!state.terminal && consumedOutputBytes > limits.maxOutputBytes) {
    throw new Error("invalid_continuation_budget_output_bound");
  }
  if (!state.terminal &&
      consumedModelFacingBytes > limits.maxCumulativeModelFacingBytes) {
    throw new Error("invalid_continuation_budget_prompt_bound");
  }
  const terminal = parseTerminal(state.terminal);
  const parsed: TurnContinuationBudgetState = {
    ...state,
    limits,
    admittedRequests,
    completedOutputRounds,
    completedToolRounds,
    consumedOutputBytes,
    consumedModelFacingBytes,
    startedAtMs: integer(state.startedAtMs),
    lastProgressAtMs: integer(state.lastProgressAtMs),
    terminal,
  };
  if (parsed.lastProgressAtMs < parsed.startedAtMs) throw new Error("invalid_continuation_budget_time");
  return parsed;
}

export function transitionTurnContinuationBudget(
  current: TurnContinuationBudgetState,
  event: TurnContinuationBudgetEvent,
  nowMs: number,
): TurnContinuationBudgetState {
  const state = parseTurnContinuationBudgetState(current, current.turnId);
  const now = integer(nowMs);
  if (state.terminal) throw new TurnContinuationBudgetExhaustedError(state);
  if (now - state.startedAtMs >= state.limits.maxElapsedMs) return exhaust(state, "max_elapsed_ms", now);
  if (now - state.lastProgressAtMs >= state.limits.maxIdleMs) return exhaust(state, "max_idle_ms", now);
  if (event.kind === "admit_request") {
    const existing = state.admittedRequests.find((item) => item.roundId === event.roundId);
    if (existing) {
      if (existing.requestDigest !== event.requestDigest || existing.modelFacingBytes !== event.modelFacingBytes) {
        return exhaust(state, "admission_changed", now);
      }
      return state;
    }
    if (event.modelFacingBytes > state.limits.maxModelFacingBytes) return exhaust(state, "model_facing_bytes", now);
    if (state.admittedRequests.length >= state.limits.maxModelRequests) return exhaust(state, "max_model_requests", now);
    const consumedModelFacingBytes = safeAdd(
      state.consumedModelFacingBytes,
      integer(event.modelFacingBytes),
    );
    if (consumedModelFacingBytes > state.limits.maxCumulativeModelFacingBytes) {
      return exhaust(
        { ...state, consumedModelFacingBytes },
        "max_cumulative_model_facing_bytes",
        now,
      );
    }
    return { ...state, consumedModelFacingBytes, admittedRequests: [...state.admittedRequests, {
      roundId: requiredText(event.roundId),
      requestDigest: requiredDigest(event.requestDigest),
      modelFacingBytes: integer(event.modelFacingBytes),
    }], lastProgressAtMs: now };
  }
  if (event.kind === "record_tool_round") {
    if (state.completedToolRounds.includes(event.roundId)) return state;
    if (state.completedToolRounds.length >= state.limits.maxToolRounds) return exhaust(state, "max_tool_rounds", now);
    return { ...state, completedToolRounds: [...state.completedToolRounds, requiredText(event.roundId)], lastProgressAtMs: now };
  }
  if (state.completedOutputRounds.includes(event.roundId)) return state;
  const outputBytes = integer(event.outputBytes);
  const consumedOutputBytes = safeAdd(state.consumedOutputBytes, outputBytes);
  if (consumedOutputBytes > state.limits.maxOutputBytes) {
    return exhaust({ ...state, consumedOutputBytes }, "max_output_bytes", now);
  }
  return { ...state, consumedOutputBytes, completedOutputRounds: [
    ...state.completedOutputRounds, requiredText(event.roundId),
  ], lastProgressAtMs: now };
}

export class TurnContinuationBudgetExhaustedError extends Error {
  readonly code = TURN_CONTINUATION_EXHAUSTED_CODE;
  constructor(readonly state: TurnContinuationBudgetState) {
    super(`Turn continuation budget exhausted: ${state.terminal?.reason ?? "unknown"}`);
    this.name = "TurnContinuationBudgetExhaustedError";
  }
}

export function continuationRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exhaust(state: TurnContinuationBudgetState, reason: TurnContinuationBudgetTerminalReason, now: number): never {
  throw new TurnContinuationBudgetExhaustedError({
    ...state,
    terminal: { code: TURN_CONTINUATION_EXHAUSTED_CODE, reason, exhaustedAtMs: now },
  });
}

function safeAdd(left: number, right: number): number {
  return right > Number.MAX_SAFE_INTEGER - left ? Number.MAX_SAFE_INTEGER : left + right;
}

function integer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_continuation_budget_integer");
  return value;
}

function requiredText(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new Error("invalid_continuation_budget_text");
  return value;
}

function requiredDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_continuation_budget_digest");
  return value;
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("invalid_continuation_budget_duplicate_round");
  }
}

function parseTerminal(
  value: TurnContinuationBudgetState["terminal"],
): TurnContinuationBudgetState["terminal"] {
  if (value === null) return null;
  if (value.code !== TURN_CONTINUATION_EXHAUSTED_CODE ||
      !TERMINAL_REASONS.has(value.reason)) {
    throw new Error("invalid_continuation_budget_terminal");
  }
  return { ...value, exhaustedAtMs: integer(value.exhaustedAtMs) };
}

const TERMINAL_REASONS = new Set<TurnContinuationBudgetTerminalReason>([
  "max_model_requests", "max_tool_rounds", "model_facing_bytes",
  "max_cumulative_model_facing_bytes",
  "max_output_bytes", "max_elapsed_ms", "max_idle_ms", "admission_changed",
]);
