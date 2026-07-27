import type { TerminalSettlementWakeBatch } from
  "./terminal-settlement-wake-store.ts";

const SETTLEMENT_WAKE_SETTLE_MS = 25;

export class TerminalSettlementWakeOwner {
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private requested = false;
  private recoveryAvailable = false;

  constructor(
    private readonly input: {
      consumeNextBatch: () => TerminalSettlementWakeBatch;
      recordFailure: (error: unknown) => void;
    },
    private readonly settleMs = SETTLEMENT_WAKE_SETTLE_MS,
  ) {}

  request(): void {
    if (this.closed) return;
    this.requested = true;
    this.recoveryAvailable = true;
    this.scheduleNextBatch();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.requested = false;
    this.recoveryAvailable = false;
  }

  private scheduleNextBatch(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => this.drainBatch(), this.settleMs);
  }

  private drainBatch(): void {
    this.scheduled = null;
    if (this.closed || !this.requested) return;
    this.requested = false;
    try {
      const result = this.input.consumeNextBatch();
      if (result.pending) {
        this.requested = true;
        this.recoveryAvailable = true;
      } else {
        this.recoveryAvailable = false;
      }
    } catch (error) {
      this.input.recordFailure(error);
      if (this.recoveryAvailable) {
        this.recoveryAvailable = false;
        this.requested = true;
      }
    }
    if (this.requested) this.scheduleNextBatch();
  }
}
