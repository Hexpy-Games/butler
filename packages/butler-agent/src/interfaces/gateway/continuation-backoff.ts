const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const RATE_LIMIT_MAX_DELAY_MS = 5 * 60_000;
const RETRYABLE_PROVIDER_BASE_DELAY_MS = 5_000;
const RETRYABLE_PROVIDER_MAX_DELAY_MS = 60_000;

export interface ContinuationBackoff {
  delayMs: number;
  notBefore: string;
}

export function continuationBackoffForFailure(input: {
  sourceErrorCode?: string;
  retryStreak: number;
  now?: Date;
}): ContinuationBackoff | null {
  const policy = backoffPolicy(input.sourceErrorCode);
  if (!policy) return null;
  const exponent = Math.max(0, Math.min(20, Math.floor(input.retryStreak) - 1));
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  const now = input.now ?? new Date();
  return {
    delayMs,
    notBefore: new Date(now.getTime() + delayMs).toISOString(),
  };
}

function backoffPolicy(code?: string): { baseDelayMs: number; maxDelayMs: number } | null {
  if (code === "provider_rate_limited") {
    return { baseDelayMs: RATE_LIMIT_BASE_DELAY_MS, maxDelayMs: RATE_LIMIT_MAX_DELAY_MS };
  }
  if (code?.startsWith("provider_")) {
    return { baseDelayMs: RETRYABLE_PROVIDER_BASE_DELAY_MS, maxDelayMs: RETRYABLE_PROVIDER_MAX_DELAY_MS };
  }
  return null;
}
