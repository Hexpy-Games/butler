// Structured JSONL event logger for the consolidation-cycle orchestrator.
// Per-day log file under <logsDir>/consolidation-cycle-<YYYY-MM-DD>.jsonl.
// Daily summaries append to <consolidationDir>/run-summary.jsonl.
import { createRequire } from "node:module";
import { join } from "path";

const fs: typeof import("fs") = createRequire(import.meta.url)("fs");

export interface ConsolidationCycleEvent {
  phase: string;
  status: "ok" | "warn" | "error" | "aborted_budget";
  duration_ms: number;
  metrics?: Record<string, unknown>;
  error?: { name: string; message: string; stack_tail: string };
  severity?: string;
  [k: string]: unknown;
}

function isoDate(d: Date): string {
  // YYYY-MM-DD in UTC — aligns with the daily log rotation semantics.
  return d.toISOString().slice(0, 10);
}

export class EventLogger {
  constructor(
    private readonly logsDir: string,
    private readonly dateOverride?: Date,
    private readonly summaryPathOverride?: string,
  ) {}

  private dailyPath(): string {
    const d = this.dateOverride ?? new Date();
    return join(this.logsDir, `consolidation-cycle-${isoDate(d)}.jsonl`);
  }

  private summaryPath(): string {
    return this.summaryPathOverride ?? join(this.logsDir, "..", "run-summary.jsonl");
  }

  private writeLine(path: string, payload: ConsolidationCycleEvent): void {
    fs.mkdirSync(join(path, ".."), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n";
    fs.appendFileSync(path, line);
  }

  emit(event: ConsolidationCycleEvent): void {
    this.writeLine(this.dailyPath(), event);
  }

  appendSummary(event: ConsolidationCycleEvent): void {
    this.writeLine(this.summaryPath(), event);
  }
}
