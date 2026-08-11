import type { TurnContinuationBudgetLimits } from "./contracts.ts";

/**
 * The v1 Turn state persists this absolute policy, not a T3 compact-replay
 * setting. Changing it changes v1 state admission; use a new schema version
 * instead of inheriting a future tool or replay limit.
 */
const TURN_CONTINUATION_BUDGET_V1_DURABLE_REFS_PER_TOOL_ROUND = 8 as const;

export function validateLimits(value: unknown): TurnContinuationBudgetLimits {
  const record = exactRecord(value, [
    "maxModelRequests", "maxToolRounds", "maxPromptTokens", "maxOutputTokens",
    "maxElapsedMs", "maxIdleMs",
  ], "Turn continuation limits");
  return {
    maxModelRequests: finitePositiveInteger(record.maxModelRequests, "maxModelRequests"),
    maxToolRounds: finitePositiveInteger(record.maxToolRounds, "maxToolRounds"),
    maxPromptTokens: finitePositiveInteger(record.maxPromptTokens, "maxPromptTokens"),
    maxOutputTokens: finitePositiveInteger(record.maxOutputTokens, "maxOutputTokens"),
    maxElapsedMs: finitePositiveInteger(record.maxElapsedMs, "maxElapsedMs"),
    maxIdleMs: finitePositiveInteger(record.maxIdleMs, "maxIdleMs"),
  };
}

export function parseRefs(
  value: unknown,
  limits: TurnContinuationBudgetLimits,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Turn continuation durable refs must be an array");
  }
  if (value.length > continuationResultRefLimit(limits)) {
    throw new Error("Turn continuation durable refs exceed the derived bound");
  }
  return value.map((ref) => {
    if (typeof ref !== "string" || ref.length === 0 || ref.length > 200 ||
      !/^[A-Za-z0-9._:-]+$/.test(ref)) {
      throw new Error("Turn continuation durable result ref is invalid");
    }
    return ref;
  });
}

export function continuationResultRefLimit(
  limits: TurnContinuationBudgetLimits,
): number {
  const parsed = validateLimits(limits);
  const result = parsed.maxToolRounds *
    TURN_CONTINUATION_BUDGET_V1_DURABLE_REFS_PER_TOOL_ROUND;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error("Turn continuation durable result ref bound is unsafe");
  }
  return result;
}

export function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exact fields`);
  }
  return record;
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`Turn continuation ${field} is invalid`);
  }
  return value;
}

export function finiteNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Turn continuation ${field} must be a finite non-negative integer`);
  }
  return value;
}

export function nullableFiniteNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  return value === null ? null : finiteNonNegativeInteger(value, field);
}

export function finitePositiveInteger(value: unknown, field: string): number {
  const parsed = finiteNonNegativeInteger(value, field);
  if (parsed === 0) throw new Error(`Turn continuation ${field} must be positive`);
  return parsed;
}
