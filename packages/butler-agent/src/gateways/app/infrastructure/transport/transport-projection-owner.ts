import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const PROJECTION_SETTLE_MS = 25;
const MAX_PROJECTION_RETRY_DELAY_MS = 1_000;

export class AppTransportProjectionOwner {
  private readonly watchers: FSWatcher[] = [];
  private readonly changedTranscripts = new Set<string>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private cycleActive = false;
  private syncRequested = false;
  private terminalSyncRequested = false;
  private retryAttempt = 0;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly input: {
      butlerData: string;
      syncNextBatch: () => boolean;
      syncChangedTranscript?: (fileName: string) => boolean;
      openTurnTranscriptFiles?: () => string[];
      syncTerminalQueue?: () => boolean;
      reopenCompletedLiveLanes: () => void;
      recordFailure: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.watchers.length > 0 || this.closed) return;
    const transcriptRoot = join(this.input.butlerData, "transcripts");
    mkdirSync(transcriptRoot, { recursive: true });
    this.watchers.push(watch(
      transcriptRoot,
      { persistent: false },
      (_event, file) => {
        if (file && String(file).endsWith(".jsonl")) {
          this.requestTranscriptSync(String(file));
        }
      },
    ));
    for (const fileName of this.input.openTurnTranscriptFiles?.() ?? []) {
      this.changedTranscripts.add(fileName);
    }
    for (const state of ["processed", "failed"] as const) {
      const terminalRoot = join(
        this.input.butlerData,
        "runtime",
        "inbound-events",
        state,
      );
      mkdirSync(terminalRoot, { recursive: true });
      this.watchers.push(watch(
        terminalRoot,
        { persistent: false },
        (_event, file) => {
          if (!file || String(file).endsWith(".json")) {
            this.requestTerminalSync();
          }
        },
      ));
    }
    this.requestTerminalSync();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.cycleActive = false;
    this.syncRequested = false;
    this.terminalSyncRequested = false;
    this.changedTranscripts.clear();
    this.retryAttempt = 0;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    this.resolveIdleWaiters();
  }

  syncAndWait(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    this.requestSync();
    return idle;
  }

  private requestSync(): void {
    if (this.closed) return;
    this.input.reopenCompletedLiveLanes();
    this.syncRequested = true;
    this.scheduleDrain();
  }

  private requestTranscriptSync(fileName: string): void {
    if (this.closed) return;
    this.changedTranscripts.add(fileName);
    this.scheduleDrain();
  }

  private requestTerminalSync(): void {
    if (this.closed) return;
    this.terminalSyncRequested = true;
    this.scheduleDrain();
  }

  private scheduleDrain(delayMs = PROJECTION_SETTLE_MS): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (this.closed) return;
      if (!this.cycleActive) {
        if (!this.hasPendingWork()) return;
        this.cycleActive = true;
      }
      const changedTranscript = this.changedTranscripts.values().next()
        .value as string | undefined;
      if (changedTranscript) this.changedTranscripts.delete(changedTranscript);
      const terminalSync = !changedTranscript && this.terminalSyncRequested;
      if (terminalSync) this.terminalSyncRequested = false;
      else if (!changedTranscript) this.syncRequested = false;
      try {
        const pending = changedTranscript
          ? this.input.syncChangedTranscript?.(changedTranscript) === true
          : terminalSync
            ? this.input.syncTerminalQueue?.() === true
            : this.input.syncNextBatch();
        if (pending && changedTranscript) {
          this.changedTranscripts.add(changedTranscript);
        } else if (pending && terminalSync) {
          this.terminalSyncRequested = true;
        } else if (pending) {
          this.syncRequested = true;
        }
        if (this.hasPendingWork()) {
          this.scheduleDrain();
          return;
        }
        this.cycleActive = false;
        this.retryAttempt = 0;
        this.resolveIdleWaiters();
      } catch (error) {
        this.cycleActive = false;
        this.input.recordFailure(error);
        // Projection lanes are durable work. Preserve the lane after every
        // failure (including repeated RangeError/SQLite failures) and retry
        // with a bounded backoff instead of silently dropping it or spinning.
        if (changedTranscript) this.changedTranscripts.add(changedTranscript);
        else if (terminalSync) this.terminalSyncRequested = true;
        else this.syncRequested = true;
        this.retryAttempt = Math.min(this.retryAttempt + 1, 16);
        this.scheduleDrain(this.projectionRetryDelayMs());
      }
    }, delayMs);
  }

  private projectionRetryDelayMs(): number {
    return Math.min(
      MAX_PROJECTION_RETRY_DELAY_MS,
      PROJECTION_SETTLE_MS * 2 ** Math.max(0, this.retryAttempt - 1),
    );
  }

  private hasPendingWork(): boolean {
    return this.syncRequested || this.terminalSyncRequested ||
      this.changedTranscripts.size > 0;
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
