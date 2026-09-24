/**
 * Size is guaranteed by code. Models do not count bytes or tokens, so every
 * limit here is enforced deterministically rather than requested in a prompt.
 */
export const CONTEXT_CAPACITY_EXCEEDED_CODE = "context_capacity_exceeded";

/** Worst-case UTF-8 bytes per output token (CJK and symbols run near 3-4). */
const CONSERVATIVE_BYTES_PER_TOKEN = 4;

/** Mandatory content alone cannot fit: the user must shrink input or change model. */
export class ContextCapacityExceededError extends Error {
  readonly code = CONTEXT_CAPACITY_EXCEEDED_CODE;
  constructor(readonly oversizedInput: string) {
    super(`The ${oversizedInput} does not fit the selected model's context window.`);
    this.name = "ContextCapacityExceededError";
  }
}

export function isContextLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  const failureCode = Reflect.get(error, "failureCode");
  return code === "provider_context_limit_exceeded" ||
    failureCode === "provider_context_limit_exceeded";
}

/**
 * Hard output cap for a summary call, derived only from the summary budget
 * (a larger reasoning floor would not fit it); local models get the same cap.
 */
export function summaryMaxOutputTokens(
  maxOutputBytes: number,
  capacity: { maxOutputTokens?: number } | undefined,
): number {
  const budgetTokens = Math.max(1, Math.floor(maxOutputBytes / CONSERVATIVE_BYTES_PER_TOKEN));
  return Math.max(1, Math.min(capacity?.maxOutputTokens ?? Infinity, budgetTokens));
}
