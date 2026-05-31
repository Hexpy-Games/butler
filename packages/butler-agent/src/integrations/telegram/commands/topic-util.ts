// Pure utilities for topic management: slug generation, callback-data byte
// guard, token bucket for auto-registration rate limiting. No fs, no network —
// keep testable.

const CALLBACK_MAX_BYTES = 64;
const SLUG_MAX_LEN = 32;

// Slugify topic / project name per B.6 D4 rules: lowercase, ASCII-only, non-
// alphanumeric → '-', trim dashes, max 32 chars. Empty fallback provided by
// caller (e.g. `t<tid>`). Conflict resolution (-N suffix) is caller's job.
export function slugify(input: string): string {
  const normalized = input
    .normalize("NFKD")
    // strip diacritics
    .replace(/[̀-ͯ]/g, "")
    // any char outside [A-Za-z0-9] becomes '-'. This drops non-Latin scripts
    // (Korean, Japanese, etc.) by design — fallback slug must be supplied.
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/^-+|-+$/g, "");
  return normalized;
}

// Pick a unique slug given existing slugs. Appends `-N` starting at 2.
export function uniqueSlug(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const cand = `${base}-${n}`.slice(0, SLUG_MAX_LEN);
    if (!taken.has(cand)) return cand;
  }
  throw new Error(`uniqueSlug: exhausted 10000 suffixes for ${base}`);
}

export function topicSlug(topicName: string | undefined, threadId: number | string): string {
  const base = topicName ? slugify(topicName) : "";
  if (base) return base;
  return `t${threadId}`;
}

// byte-length guard. Telegram rejects callback_data > 64 bytes. Call before
// sending any inline keyboard to fail loudly in tests rather than silently at
// runtime.
export function assertCallbackLen(data: string): void {
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > CALLBACK_MAX_BYTES) {
    throw new Error(`callback_data ${bytes} bytes exceeds 64-byte limit: ${data}`);
  }
}

// Token bucket used by auto-register gate. `burst` = max bucket size, filled at
// `rateLimitPerMinute / 60` tokens/sec. Returns true iff a token was consumed.
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly burst: number,
    private readonly ratePerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.lastRefillMs = now();
  }

  tryConsume(): boolean {
    const n = this.now();
    const elapsed = Math.max(0, n - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.lastRefillMs = n;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  get available(): number { return this.tokens; }
}
