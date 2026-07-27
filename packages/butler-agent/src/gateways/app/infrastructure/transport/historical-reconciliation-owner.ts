const HISTORICAL_RECONCILIATION_SETTLE_MS = 250;

export class AppTransportHistoricalReconciliationOwner {
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private cycleActive = false;
  private reconciliationRequested = false;
  private recoveryAvailable = false;

  constructor(
    private readonly input: {
      reconcileNextPage: () => boolean;
      recordFailure: (error: unknown) => void;
    },
    private readonly settleMs = HISTORICAL_RECONCILIATION_SETTLE_MS,
  ) {}

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.closed) return;
    this.reconciliationRequested = true;
    this.recoveryAvailable = true;
    this.scheduleNextPage();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.cycleActive = false;
    this.reconciliationRequested = false;
    this.recoveryAvailable = false;
  }

  private scheduleNextPage(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => this.drainPage(), this.settleMs);
  }

  private drainPage(): void {
    this.scheduled = null;
    if (this.closed) return;
    if (!this.cycleActive) {
      if (!this.reconciliationRequested) return;
      this.reconciliationRequested = false;
      this.cycleActive = true;
    }
    try {
      if (this.input.reconcileNextPage()) {
        this.recoveryAvailable = true;
        this.scheduleNextPage();
        return;
      }
      this.cycleActive = false;
      if (this.reconciliationRequested) this.scheduleNextPage();
      else this.recoveryAvailable = false;
    } catch (error) {
      this.cycleActive = false;
      this.input.recordFailure(error);
      if (!this.reconciliationRequested && this.recoveryAvailable) {
        this.recoveryAvailable = false;
        this.reconciliationRequested = true;
      }
      if (this.reconciliationRequested) this.scheduleNextPage();
    }
  }
}
