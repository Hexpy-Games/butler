import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const PROJECTION_SETTLE_MS = 25;

export class AppTransportProjectionOwner {
  private readonly watchers: FSWatcher[] = [];
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private cycleActive = false;
  private syncRequested = false;
  private recoveryAvailable = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly input: {
      butlerData: string;
      syncNextBatch: () => boolean;
      reopenCompletedLiveLanes: () => void;
      terminalSettlementWakeOwner: { request(): void; close(): void };
      recordFailure: (error: unknown) => void;
      maintenanceOwner?: { start(): void; close(): void };
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
      if (!file || String(file).endsWith(".jsonl")) this.requestSync();
      },
    ));
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
          if (!file || String(file).endsWith(".json")) this.requestSync();
        },
      ));
    }
    this.requestSync();
    this.input.maintenanceOwner?.start();
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.cycleActive = false;
    this.syncRequested = false;
    this.recoveryAvailable = false;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    this.input.terminalSettlementWakeOwner.close();
    this.input.maintenanceOwner?.close();
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
    this.recoveryAvailable = true;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      if (this.closed) return;
      if (!this.cycleActive) {
        if (!this.syncRequested) return;
        this.syncRequested = false;
        this.cycleActive = true;
      }
      try {
        if (this.input.syncNextBatch()) {
          this.scheduleDrain();
          return;
        }
        this.cycleActive = false;
        this.input.terminalSettlementWakeOwner.request();
        if (this.syncRequested) this.scheduleDrain();
        else {
          this.recoveryAvailable = false;
          this.resolveIdleWaiters();
        }
      } catch (error) {
        this.cycleActive = false;
        this.input.recordFailure(error);
        if (!this.syncRequested && this.recoveryAvailable) {
          this.recoveryAvailable = false;
          this.syncRequested = true;
        }
        if (this.syncRequested) this.scheduleDrain();
        else this.resolveIdleWaiters();
      }
    }, PROJECTION_SETTLE_MS);
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
