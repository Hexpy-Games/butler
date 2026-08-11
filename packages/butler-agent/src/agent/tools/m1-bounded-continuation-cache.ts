import type { TurnContinuationBudgetLimits } from
  "../btcc/turn/continuation-budget.ts";

export const M1_BOUNDED_CONTINUATION_CACHE_FLAG =
  "BUTLER_M1_BOUNDED_CONTINUATION_CACHE" as const;
export const M1_BOUNDED_CONTINUATION_CACHE_FLAG_REVISION = "m1-t4-v1" as const;

const LIMIT_ENV = {
  maxModelRequests: "BUTLER_M1_CONTINUATION_MAX_MODEL_REQUESTS",
  maxToolRounds: "BUTLER_M1_CONTINUATION_MAX_TOOL_ROUNDS",
  maxPromptTokens: "BUTLER_M1_CONTINUATION_MAX_PROMPT_TOKENS",
  maxOutputTokens: "BUTLER_M1_CONTINUATION_MAX_OUTPUT_TOKENS",
  maxElapsedMs: "BUTLER_M1_CONTINUATION_MAX_ELAPSED_MS",
  maxIdleMs: "BUTLER_M1_CONTINUATION_MAX_IDLE_MS",
} as const;

export function isM1BoundedContinuationCacheEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const value = env[M1_BOUNDED_CONTINUATION_CACHE_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export type M1BoundedContinuationSelection =
  | { enabled: false }
  | { enabled: true; limits: TurnContinuationBudgetLimits };

/**
 * Selects T4 policy for one new Turn admission. Limits are deliberately absent
 * from the off selection: rollback must not validate or depend on T4 config.
 * The admitted state, rather than later environment reads, controls the Turn.
 */
export function selectM1BoundedContinuationCache(
  env: Record<string, string | undefined>,
): M1BoundedContinuationSelection {
  if (!isM1BoundedContinuationCacheEnabled(env)) return { enabled: false };
  return { enabled: true, limits: resolveTurnContinuationBudgetLimits(env) };
}

export function resolveTurnContinuationBudgetLimits(
  env: Record<string, string | undefined>,
): TurnContinuationBudgetLimits {
  const limits = Object.fromEntries(Object.entries(LIMIT_ENV).map(([field, key]) => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      throw new Error(`Missing explicit finite positive continuation limit: ${key}`);
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid finite positive continuation limit: ${key}`);
    }
    return [field, parsed];
  })) as TurnContinuationBudgetLimits;
  return limits;
}
