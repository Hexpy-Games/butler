const BTCC_RETENTION_SETTLE_MS = 250;

export class BtccTerminalPhaseRetentionQueue {
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private recoveryAttemptAvailable = false;

  constructor(
    private readonly input: {
      compactBatch: () => boolean;
      recordFailure: (error: unknown) => void;
    },
  ) {}

  schedule(): void {
    if (this.closed) return;
    this.recoveryAttemptAvailable = true;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => this.drain(), BTCC_RETENTION_SETTLE_MS);
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
  }

  private drain(): void {
    this.scheduled = null;
    if (this.closed) return;
    try {
      if (this.input.compactBatch()) {
        this.recoveryAttemptAvailable = true;
        this.scheduleDrain();
      }
    } catch (error) {
      this.input.recordFailure(error);
      if (this.recoveryAttemptAvailable) {
        this.recoveryAttemptAvailable = false;
        this.scheduleDrain();
      }
    }
  }
}
