import type { TerminalCompactionResult } from
  "./terminal-turn-retention.ts";

const SEMANTIC_SETTLE_MS = 25;
const MAINTENANCE_SETTLE_MS = 250;
const SEMANTIC_BATCH_SIZE = 4;
const MAINTENANCE_BATCH_SIZE = 1;
const RETENTION_SWEEP_PAGE_SIZE = 32;

export type TerminalTurnRetentionPage = {
  turns: Array<{ turnId: string; rowId: number }>;
  nextCursor: number;
  hasMore: boolean;
};

export class TerminalTurnRetentionQueue {
  private readonly semanticPending = new Set<string>();
  private readonly maintenancePending = new Set<string>();
  private readonly maintenancePreemptions = new Set<string>();
  private readonly compactionRecoveries = new Set<string>();
  private readonly cursorWaits = new Map<string, number>();
  private semanticTimer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  private nextCursorWake = Number.POSITIVE_INFINITY;
  private latestEventCursor = 0;
  private closed = false;
  private sweepCursor: number | null = null;
  private sweepRecoveryAvailable = false;

  constructor(
    private readonly input: {
      terminalTurnPage: (
        afterRowId: number,
        limit: number,
      ) => TerminalTurnRetentionPage;
      compactTurn: (turnId: string) => TerminalCompactionResult;
      recordFailure: (error: unknown) => void;
    },
    private readonly timing = {
      semanticSettleMs: SEMANTIC_SETTLE_MS,
      maintenanceSettleMs: MAINTENANCE_SETTLE_MS,
    },
  ) {}

  schedule(turnId: string): void {
    if (this.closed) return;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.compactionRecoveries.delete(turnId);
    this.cursorWaits.delete(turnId);
    this.maintenancePending.delete(turnId);
    this.maintenancePreemptions.add(turnId);
    this.semanticPending.add(turnId);
    this.refreshNextCursorWake();
    this.scheduleSemanticDrain();
  }

  advanceEventCursor(eventCursor: number): void {
    if (this.closed) return;
    this.latestEventCursor = Math.max(this.latestEventCursor, eventCursor);
    if (this.latestEventCursor < this.nextCursorWake) return;
    this.wakeCursorBatch();
    if (this.maintenancePending.size > 0) this.scheduleMaintenanceDrain();
  }

  sweep(): void {
    if (this.closed) return;
    this.sweepCursor ??= 0;
    this.sweepRecoveryAvailable = true;
    this.scheduleMaintenanceDrain();
  }

  close(): void {
    this.closed = true;
    this.semanticPending.clear();
    this.maintenancePending.clear();
    this.maintenancePreemptions.clear();
    this.compactionRecoveries.clear();
    this.cursorWaits.clear();
    if (this.semanticTimer) clearTimeout(this.semanticTimer);
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.semanticTimer = null;
    this.maintenanceTimer = null;
  }

  private scheduleSemanticDrain(): void {
    if (this.closed || this.semanticTimer) return;
    this.semanticTimer = setTimeout(
      () => this.drainSemantic(),
      this.timing.semanticSettleMs,
    );
  }

  private scheduleMaintenanceDrain(): void {
    if (this.closed || this.maintenanceTimer) return;
    this.maintenanceTimer = setTimeout(
      () => this.drainMaintenance(),
      this.timing.maintenanceSettleMs,
    );
  }

  private drainSemantic(): void {
    this.semanticTimer = null;
    if (this.closed) return;
    this.compactBatch(
      this.semanticPending,
      this.maintenancePending,
      SEMANTIC_BATCH_SIZE,
    );
    if (this.semanticPending.size > 0) this.scheduleSemanticDrain();
    if (
      this.maintenancePending.size > 0 || this.sweepCursor !== null ||
      this.nextCursorWake <= this.latestEventCursor
    ) {
      this.scheduleMaintenanceDrain();
    }
  }

  private drainMaintenance(): void {
    this.maintenanceTimer = null;
    if (this.closed) return;
    if (this.maintenancePending.size === 0) this.loadSweepPage();
    this.wakeCursorBatch();
    this.compactBatch(
      this.maintenancePending,
      this.maintenancePending,
      MAINTENANCE_BATCH_SIZE,
    );
    if (
      this.maintenancePending.size > 0 || this.sweepCursor !== null ||
      this.nextCursorWake <= this.latestEventCursor
    ) {
      this.scheduleMaintenanceDrain();
    }
  }

  private loadSweepPage(): void {
    if (this.sweepCursor === null) return;
    try {
      const page = this.input.terminalTurnPage(
        this.sweepCursor,
        RETENTION_SWEEP_PAGE_SIZE,
      );
      for (const turn of page.turns) {
        if (
          this.maintenancePreemptions.has(turn.turnId) ||
          this.cursorWaits.has(turn.turnId)
        ) continue;
        this.maintenancePending.add(turn.turnId);
      }
      this.refreshNextCursorWake();
      this.sweepCursor = page.hasMore ? page.nextCursor : null;
      this.sweepRecoveryAvailable = true;
    } catch (error) {
      this.input.recordFailure(error);
      if (this.sweepRecoveryAvailable) {
        this.sweepRecoveryAvailable = false;
      } else {
        this.sweepCursor = null;
      }
    }
  }

  private compactBatch(
    source: Set<string>,
    repeat: Set<string>,
    limit: number,
  ): void {
    const batch = [...source].slice(0, limit);
    for (const turnId of batch) {
      source.delete(turnId);
      try {
        const result = this.input.compactTurn(turnId);
        this.compactionRecoveries.delete(turnId);
        if (result === "pending") {
          repeat.add(turnId);
        } else {
          this.maintenancePreemptions.delete(turnId);
        }
        if (typeof result === "object") {
          this.cursorWaits.set(turnId, result.eventCursor);
          this.nextCursorWake = Math.min(
            this.nextCursorWake,
            result.eventCursor,
          );
        }
      } catch (error) {
        this.maintenancePreemptions.delete(turnId);
        this.input.recordFailure(error);
        if (!this.compactionRecoveries.has(turnId)) {
          this.compactionRecoveries.add(turnId);
          repeat.add(turnId);
        } else {
          this.compactionRecoveries.delete(turnId);
        }
      }
    }
  }

  private refreshNextCursorWake(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const cursor of this.cursorWaits.values()) next = Math.min(next, cursor);
    this.nextCursorWake = next;
  }

  private wakeCursorBatch(): void {
    let activated = 0;
    for (const [turnId, wakeCursor] of this.cursorWaits) {
      if (wakeCursor > this.latestEventCursor) continue;
      this.cursorWaits.delete(turnId);
      if (!this.semanticPending.has(turnId)) this.maintenancePending.add(turnId);
      activated += 1;
      if (activated === MAINTENANCE_BATCH_SIZE) break;
    }
    this.refreshNextCursorWake();
  }
}
