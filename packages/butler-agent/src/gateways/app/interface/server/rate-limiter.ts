import type { MessageRateLimitOptions } from "./server-types.ts";

const DEFAULT_MESSAGE_RATE_LIMIT = {
  max: 60,
  windowMs: 60_000,
} as const;

export class FixedWindowRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(options: MessageRateLimitOptions = {}) {
    const max = Number(options.max ?? DEFAULT_MESSAGE_RATE_LIMIT.max);
    const windowMs = Number(
      options.windowMs ?? DEFAULT_MESSAGE_RATE_LIMIT.windowMs,
    );
    this.max =
      Number.isFinite(max) && max > 0 ? max : DEFAULT_MESSAGE_RATE_LIMIT.max;
    this.windowMs =
      Number.isFinite(windowMs) && windowMs > 0
        ? windowMs
        : DEFAULT_MESSAGE_RATE_LIMIT.windowMs;
  }

  consume(key: string): boolean {
    const now = Date.now();
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
