import type { Database } from "bun:sqlite";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "../sessions/message-responder-contract.ts";
import type {
  AutomationDetailView,
  AutomationListView,
  AutomationMutationResult,
  AutomationRunListView,
  AutomationRunResult,
  AutomationRunSummary,
  AutomationTargetSummary,
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from "../../interface/protocol/app-protocol.ts";
import {
  automationDetailFromRow,
  automationRunFromRow,
  automationSummaryFromRow,
  automationSummaryWithoutPrompt,
  normalizeAutomationInterval,
} from "./automation-read-model.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import {
  getAutomationRow,
  listAutomationRows,
  listDueAutomationRows,
  listAutomationRunRows,
  type AutomationRow,
} from "./automation-records.ts";
import {
  AutomationRunDispatcher,
  type AutomationRunDispatcherContext,
} from "./automation-run-dispatcher.ts";

export interface AppAutomationStoreOptions {
  db: Database;
  sessionLabel(sessionId: string): string;
  targetSession(sessionId: string): {
    id: string;
    kind: AutomationRow["target_kind"];
  };
  dispatchContext: AutomationRunDispatcherContext;
  appendEvent(type: string, payload: Record<string, unknown>): void;
}

export class AppAutomationStore {
  private readonly db: Database;
  private readonly sessionLabel: (sessionId: string) => string;
  private readonly targetSession: (sessionId: string) => {
    id: string;
    kind: AutomationRow["target_kind"];
  };
  private readonly appendEvent: (
    type: string,
    payload: Record<string, unknown>,
  ) => void;
  private readonly runs: AutomationRunDispatcher;

  constructor(options: AppAutomationStoreOptions) {
    this.db = options.db;
    this.sessionLabel = options.sessionLabel;
    this.targetSession = options.targetSession;
    this.appendEvent = options.appendEvent;
    this.runs = new AutomationRunDispatcher(this.db, options.dispatchContext);
  }

  list(options: { targetSessionId?: string } = {}): AutomationListView {
    const rows = listAutomationRows(this.db, options);
    return {
      automations: rows.map((row) =>
        automationSummaryFromRow(row, this.sessionLabel(row.target_session_id)),
      ),
    };
  }

  get(automationId: string): AutomationDetailView {
    const row = this.requireActiveAutomation(automationId);
    return {
      automation: automationDetailFromRow(
        row,
        this.sessionLabel(row.target_session_id),
      ),
    };
  }

  create(input: CreateAutomationRequest): AutomationMutationResult {
    const title = input.title.trim();
    const prompt = input.prompt_body.trim();
    if (!title) {
      throw new AppStoreOperationError(
        400,
        "automation_title_required",
        "Automation title is required.",
      );
    }
    if (!prompt) {
      throw new AppStoreOperationError(
        400,
        "automation_prompt_required",
        "Automation prompt is required.",
      );
    }
    const targetSession = this.targetSession(input.target_session_id.trim());
    const intervalSeconds = normalizeAutomationInterval(input.interval_seconds);
    const now = new Date();
    const id = `automation-${crypto.randomUUID()}`;
    this.db
      .query(
        `
      INSERT INTO app_automations (
        id, title, prompt_body, target_kind, target_session_id, interval_seconds, state,
        next_run_at, last_run_at, last_run_state, last_safe_error_code,
        run_count, consecutive_failure_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, NULL, 'never_run', NULL, 0, 0, ?, ?)
    `,
      )
      .run(
        id,
        title,
        prompt,
        targetSession.kind,
        targetSession.id,
        intervalSeconds,
        new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    const automation = this.get(id).automation;
    this.publishMutation("automation.created", automation);
    return { automation };
  }

  update(
    automationId: string,
    input: UpdateAutomationRequest,
  ): AutomationMutationResult {
    const row = this.requireActiveAutomation(automationId);
    const targetSession = this.targetSession(
      input.target_session_id?.trim() || row.target_session_id,
    );
    const intervalSeconds =
      input.interval_seconds === undefined
        ? row.interval_seconds
        : normalizeAutomationInterval(input.interval_seconds);
    const state = input.state ?? row.state;
    const now = new Date();
    this.db
      .query(
        `
      UPDATE app_automations
      SET title = ?, prompt_body = ?, target_kind = ?, target_session_id = ?,
        interval_seconds = ?, state = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        input.title?.trim() || row.title,
        input.prompt_body?.trim() || row.prompt_body,
        targetSession.kind,
        targetSession.id,
        intervalSeconds,
        state,
        state === "enabled"
          ? new Date(now.getTime() + intervalSeconds * 1000).toISOString()
          : row.next_run_at,
        now.toISOString(),
        automationId,
      );
    const automation = this.get(automationId).automation;
    this.publishMutation("automation.updated", automation);
    return { automation };
  }

  delete(automationId: string): AutomationMutationResult {
    const row = getAutomationRow(this.db, automationId);
    if (!row) throw this.notFound();
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE app_automations SET state = 'deleted', next_run_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, automationId);
    const automation = automationSummaryFromRow(
      { ...row, state: "deleted", next_run_at: null, updated_at: now },
      this.sessionLabel(row.target_session_id),
    );
    this.appendEvent("automation.deleted", { automation });
    return { automation };
  }

  async runNow(
    automationId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    trigger: "run_now" | "scheduled" = "run_now",
  ): Promise<AutomationRunResult> {
    const row = this.requireActiveAutomation(automationId);
    if (trigger === "scheduled" && row.state !== "enabled") {
      throw new AppStoreOperationError(
        409,
        "automation_not_enabled",
        "Automation is not enabled.",
      );
    }
    const run = await this.runs.executeAutomationRow(
      row,
      trigger,
      responder,
      options,
    );
    const updated = getAutomationRow(this.db, automationId)!;
    return {
      automation: automationSummaryFromRow(
        updated,
        this.sessionLabel(updated.target_session_id),
      ),
      run,
    };
  }

  async dispatchDue(
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    now = new Date(),
  ): Promise<{ runs: AutomationRunSummary[] }> {
    const runs = await this.runs.drainQueuedAutomationRuns(responder, options);
    const rows = listDueAutomationRows(this.db, now);
    for (const row of rows) {
      runs.push(
        await this.runs.executeAutomationRow(
          row,
          "scheduled",
          responder,
          options,
          now,
        ),
      );
    }
    return { runs };
  }

  listRuns(automationId: string): AutomationRunListView {
    return {
      runs: listAutomationRunRows(this.db, automationId).map(
        automationRunFromRow,
      ),
    };
  }

  listTargets(sessionId: string): AutomationTargetSummary[] {
    return this.list({ targetSessionId: sessionId }).automations.map(
      (automation) => ({
        automation_id: automation.id,
        title: automation.title,
        state: automation.state,
        interval_label: automation.interval_label,
        next_run_at: automation.next_run_at,
        last_run_state: automation.last_run_state,
        safe_error_code: automation.last_safe_error_code,
      }),
    );
  }

  private requireActiveAutomation(automationId: string): AutomationRow {
    const row = getAutomationRow(this.db, automationId);
    if (!row || row.state === "deleted") throw this.notFound();
    return row;
  }

  private publishMutation(
    type: "automation.created" | "automation.updated",
    automation: AutomationMutationResult["automation"],
  ): void {
    this.appendEvent(type, {
      automation: automationSummaryWithoutPrompt(automation),
    });
  }

  private notFound(): AppStoreOperationError {
    return new AppStoreOperationError(
      404,
      "automation_not_found",
      "Automation not found.",
    );
  }
}
