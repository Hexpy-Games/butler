const RECEIPT_MIGRATION_SETTLE_MS = 250;

export class AppTransportReceiptMigrationOwner {
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private recoveryAvailable = true;

  constructor(
    private readonly input: {
      migrateNextBatch: () => boolean;
      recordFailure: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.closed || this.scheduled) return;
    this.scheduleNextBatch();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.recoveryAvailable = false;
  }

  private scheduleNextBatch(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (this.closed) return;
      try {
        const pending = this.input.migrateNextBatch();
        this.recoveryAvailable = pending;
        if (pending) this.scheduleNextBatch();
      } catch (error) {
        this.input.recordFailure(error);
        if (!this.recoveryAvailable) return;
        this.recoveryAvailable = false;
        this.scheduleNextBatch();
      }
    }, RECEIPT_MIGRATION_SETTLE_MS);
  }
}
