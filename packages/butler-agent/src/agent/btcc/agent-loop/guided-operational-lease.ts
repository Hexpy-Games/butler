export const DEFAULT_GUIDED_TURN_LEASE_MS = 280_000;
export const DEFAULT_GUIDED_FINAL_REPORT_MS = 15_000;
export const DEFAULT_GUIDED_ABSOLUTE_TURN_LEASE_MS = 840_000;

export type GuidedOperationalDeadline = {
  deadline(): number;
  now(): number;
  subscribe(listener: () => void): () => void;
};

export class GuidedOperationalLease {
  readonly finalReportMs: number;
  readonly absoluteDeadline: number;
  private readonly noProgressMs: number;
  private readonly fixedDeadline: number;
  private readonly clock: () => number;
  private readonly listeners = new Set<() => void>();
  private lastProgressAt: number;
  private managed: boolean;

  constructor(input: {
    startedAt: number;
    leaseMs?: number;
    finalReportMs?: number;
    absoluteLeaseMs?: number;
    managedInitially?: boolean;
    now?: () => number;
  }) {
    this.noProgressMs = positiveMs(
      input.leaseMs,
      DEFAULT_GUIDED_TURN_LEASE_MS,
    );
    this.finalReportMs = Math.min(
      positiveMs(input.finalReportMs, DEFAULT_GUIDED_FINAL_REPORT_MS),
      Math.max(1, this.noProgressMs - 1),
    );
    const defaultAbsoluteMs = input.leaseMs === undefined
      ? DEFAULT_GUIDED_ABSOLUTE_TURN_LEASE_MS
      : this.noProgressMs * 3;
    const absoluteMs = Math.max(
      this.noProgressMs,
      positiveMs(input.absoluteLeaseMs, defaultAbsoluteMs),
    );
    this.fixedDeadline = input.startedAt + this.noProgressMs;
    this.absoluteDeadline = input.startedAt + absoluteMs;
    this.lastProgressAt = input.startedAt;
    this.managed = input.managedInitially === true;
    this.clock = input.now ?? Date.now;
  }

  recordDurableProgress(): void {
    this.managed = true;
    this.lastProgressAt = Math.max(this.lastProgressAt, this.clock());
    for (const listener of this.listeners) listener();
  }

  leaseDeadline(): number {
    if (!this.managed) return this.fixedDeadline;
    return Math.min(
      this.lastProgressAt + this.noProgressMs,
      this.absoluteDeadline,
    );
  }

  mainDeadline(): number {
    return this.leaseDeadline() - this.finalReportMs;
  }

  mainWindow(): GuidedOperationalDeadline {
    return {
      deadline: () => this.mainDeadline(),
      now: this.clock,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };
  }
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}
