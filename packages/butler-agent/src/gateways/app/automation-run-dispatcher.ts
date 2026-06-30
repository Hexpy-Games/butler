import type { Database } from "bun:sqlite";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type {
  AutomationRunSummary,
  MessageRecord,
  MessageSendResult,
  SessionSummary,
} from "./protocol.ts";
import { AppStoreOperationError } from "./app-store-errors.ts";
import {
  type AutomationRow,
  type QueuedAutomationRunRow,
} from "./automation-records.ts";
import {
  AutomationRunRecorder,
  type AutomationRunDispatchResult,
} from "./automation-run-recorder.ts";

export interface AutomationRunDispatcherContext {
  ensureSession(sessionId: string): SessionSummary;
  sessionHasActiveTurn(sessionId: string): boolean;
  sendMessage(
    input: {
      chat_id: string;
      text: string;
      client_message_id: string;
    },
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
  ): Promise<MessageSendResult>;
  createQueuedPromptMessage(sessionId: string): MessageRecord;
  markQueuedPromptDispatched(messageId: string): MessageRecord;
  markQueuedPromptFailed(
    messageId: string,
    safeErrorCode: string,
  ): MessageRecord;
  appendEvent(type: string, payload: Record<string, unknown>): void;
}

export class AutomationRunDispatcher {
  private readonly recorder: AutomationRunRecorder;

  constructor(
    private readonly db: Database,
    private readonly context: AutomationRunDispatcherContext,
  ) {
    this.recorder = new AutomationRunRecorder(db);
  }

  async executeAutomationRow(
    row: AutomationRow,
    trigger: "scheduled" | "run_now",
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    now = new Date(),
  ): Promise<AutomationRunSummary> {
    const runId = `automation-run-${crypto.randomUUID()}`;
    const startedAt = now.toISOString();
    this.db
      .query(
        `
      INSERT INTO app_automation_runs (
        id, automation_id, target_session_id, state, trigger, started_at,
        completed_at, safe_error_code, queued_message_id, turn_id
      )
      VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL)
    `,
      )
      .run(runId, row.id, row.target_session_id, trigger, startedAt);

    const result = await this.dispatchFreshRun(
      row,
      runId,
      trigger,
      responder,
      options,
    );
    const completedAt = new Date().toISOString();
    const run = this.recorder.completeFreshRun(
      row,
      runId,
      result,
      completedAt,
    );
    this.publishRunEvent(row.id, row.target_session_id, run, trigger);
    return run;
  }

  async drainQueuedAutomationRuns(
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunSummary[]> {
    const rows = this.db
      .query<QueuedAutomationRunRow, []>(
        `
      SELECT
        r.id AS run_id,
        r.automation_id,
        r.target_session_id,
        r.trigger,
        r.queued_message_id,
        a.title,
        a.prompt_body,
        a.target_kind,
        a.interval_seconds,
        a.state,
        a.next_run_at,
        a.last_run_at,
        a.last_run_state,
        a.last_safe_error_code,
        a.run_count,
        a.consecutive_failure_count,
        a.created_at,
        a.updated_at
      FROM app_automation_runs r
      JOIN app_automations a ON a.id = r.automation_id
      WHERE r.state = 'queued' AND a.state != 'deleted'
      ORDER BY r.rowid ASC
      LIMIT 20
    `,
      )
      .all();
    const runs: AutomationRunSummary[] = [];
    for (const row of rows) {
      if (this.context.sessionHasActiveTurn(row.target_session_id)) continue;
      runs.push(await this.executeQueuedRun(row, responder, options));
    }
    return runs;
  }

  private async dispatchFreshRun(
    row: AutomationRow,
    runId: string,
    _trigger: "scheduled" | "run_now",
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunDispatchResult> {
    try {
      this.context.ensureSession(row.target_session_id);
      if (this.context.sessionHasActiveTurn(row.target_session_id)) {
        const queued = this.context.createQueuedPromptMessage(
          row.target_session_id,
        );
        return {
          state: "queued",
          safeErrorCode: null,
          queuedMessageId: queued.id,
          turnId: null,
        };
      }
      const result = await this.context.sendMessage(
        {
          chat_id: row.target_session_id,
          text: row.prompt_body,
          client_message_id: `automation-${row.id}-${runId}`,
        },
        responder,
        options,
      );
      return this.successfulDispatch(result);
    } catch (error) {
      return this.failedDispatch(error);
    }
  }

  private async executeQueuedRun(
    row: QueuedAutomationRunRow,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunSummary> {
    const result = await this.dispatchPreviouslyQueuedRun(
      row,
      responder,
      options,
    );
    const completedAt = new Date().toISOString();
    const run = this.recorder.completeQueuedRun(row, result, completedAt);
    this.publishRunEvent(row.automation_id, row.target_session_id, run, row.trigger);
    return run;
  }

  private async dispatchPreviouslyQueuedRun(
    row: QueuedAutomationRunRow,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunDispatchResult> {
    try {
      this.context.ensureSession(row.target_session_id);
      const result = await this.context.sendMessage(
        {
          chat_id: row.target_session_id,
          text: row.prompt_body,
          client_message_id: `automation-${row.automation_id}-${row.run_id}`,
        },
        responder,
        options,
      );
      if (row.queued_message_id) {
        this.context.markQueuedPromptDispatched(row.queued_message_id);
      }
      return this.successfulDispatch(result);
    } catch (error) {
      const result = this.failedDispatch(error);
      const state =
        error instanceof AppStoreOperationError &&
        error.code === "session_not_found"
          ? "skipped_target_unavailable"
          : result.state;
      const safeErrorCode = result.safeErrorCode ?? "automation_dispatch_failed";
      if (row.queued_message_id) {
        this.context.markQueuedPromptFailed(row.queued_message_id, safeErrorCode);
      }
      return { ...result, state, safeErrorCode };
    }
  }

  private successfulDispatch(
    result: MessageSendResult,
  ): AutomationRunDispatchResult {
    if (!result.turn) {
      throw new AppStoreOperationError(
        500,
        "automation_dispatch_failed",
        "Automation dispatch did not start a turn.",
      );
    }
    return {
      state: "succeeded",
      safeErrorCode: null,
      queuedMessageId: null,
      turnId: result.turn.id,
    };
  }

  private failedDispatch(error: unknown): AutomationRunDispatchResult {
    return {
      state: "failed",
      safeErrorCode:
        error instanceof AppStoreOperationError
          ? error.code
          : "automation_dispatch_failed",
      queuedMessageId: null,
      turnId: null,
    };
  }

  private publishRunEvent(
    automationId: string,
    targetSessionId: string,
    run: AutomationRunSummary,
    trigger: "scheduled" | "run_now",
  ): void {
    this.context.appendEvent("automation.run", {
      automation_id: automationId,
      target_session_id: targetSessionId,
      state: run.state,
      trigger,
      safe_error_code: run.safe_error_code,
    });
  }
}
