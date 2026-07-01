import type { Database } from "bun:sqlite";
import type {
  AutomationRunState,
  AutomationRunSummary,
} from "../../interface/protocol/app-protocol.ts";
import { automationRunFromRow } from "./automation-read-model.ts";
import {
  type AutomationRow,
  type QueuedAutomationRunRow,
  listAutomationRunRows,
} from "./automation-records.ts";

export interface AutomationRunDispatchResult {
  state: AutomationRunState;
  safeErrorCode: string | null;
  queuedMessageId: string | null;
  turnId: string | null;
}

export class AutomationRunRecorder {
  constructor(private readonly db: Database) {}

  completeFreshRun(
    row: AutomationRow,
    runId: string,
    result: AutomationRunDispatchResult,
    completedAt: string,
  ): AutomationRunSummary {
    this.completeRun(runId, result, completedAt);
    const nextRunAt =
      row.state === "enabled" && row.interval_seconds > 0
        ? new Date(
            Date.parse(completedAt) + row.interval_seconds * 1000,
          ).toISOString()
        : null;
    this.db
      .query(
        `
      UPDATE app_automations
      SET next_run_at = ?, last_run_at = ?, last_run_state = ?, last_safe_error_code = ?,
        run_count = run_count + 1,
        consecutive_failure_count = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        row.state === "enabled" ? nextRunAt : row.next_run_at,
        completedAt,
        result.state,
        result.safeErrorCode,
        result.state === "failed" ? row.consecutive_failure_count + 1 : 0,
        completedAt,
        row.id,
      );
    return this.runById(row.id, runId);
  }

  completeQueuedRun(
    row: QueuedAutomationRunRow,
    result: AutomationRunDispatchResult,
    completedAt: string,
  ): AutomationRunSummary {
    this.completeRun(row.run_id, result, completedAt, {
      preserveQueuedMessageId: true,
    });
    this.db
      .query(
        `
      UPDATE app_automations
      SET last_run_at = ?, last_run_state = ?, last_safe_error_code = ?,
        consecutive_failure_count = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        completedAt,
        result.state,
        result.safeErrorCode,
        result.state === "failed" ? row.consecutive_failure_count + 1 : 0,
        completedAt,
        row.automation_id,
      );
    return this.runById(row.automation_id, row.run_id);
  }

  private completeRun(
    runId: string,
    result: AutomationRunDispatchResult,
    completedAt: string,
    options: { preserveQueuedMessageId?: boolean } = {},
  ): void {
    if (options.preserveQueuedMessageId) {
      this.db
        .query(
          `
      UPDATE app_automation_runs
      SET state = ?, completed_at = ?, safe_error_code = ?, turn_id = ?
      WHERE id = ?
    `,
        )
        .run(
          result.state,
          completedAt,
          result.safeErrorCode,
          result.turnId,
          runId,
        );
      return;
    }
    this.db
      .query(
        `
      UPDATE app_automation_runs
      SET state = ?, completed_at = ?, safe_error_code = ?, queued_message_id = ?, turn_id = ?
      WHERE id = ?
    `,
      )
      .run(
        result.state,
        completedAt,
        result.safeErrorCode,
        result.queuedMessageId,
        result.turnId,
        runId,
      );
  }

  private runById(automationId: string, runId: string): AutomationRunSummary {
    const run = listAutomationRunRows(this.db, automationId)
      .map(automationRunFromRow)
      .find((item) => item.id === runId);
    if (!run) throw new Error(`Automation run was not recorded: ${runId}`);
    return run;
  }
}
