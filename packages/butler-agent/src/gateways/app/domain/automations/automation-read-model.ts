import type {
  AutomationDetail,
  AutomationRunState,
  AutomationRunSummary,
  AutomationState,
  AutomationSummary,
  ChatKind,
} from "../../interface/protocol/app-protocol.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";

export interface AutomationReadModelRow {
  id: string;
  title: string;
  prompt_body: string;
  target_kind: ChatKind;
  target_session_id: string;
  interval_seconds: number;
  state: AutomationState;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_state: AutomationRunState;
  last_safe_error_code: string | null;
  run_count: number;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationRunReadModelRow {
  rowid: number;
  id: string;
  automation_id: string;
  target_session_id: string;
  state: AutomationRunState;
  trigger: "scheduled" | "run_now";
  started_at: string;
  completed_at: string | null;
  safe_error_code: string | null;
  queued_message_id: string | null;
  turn_id: string | null;
}

export function automationSummaryFromRow(
  row: AutomationReadModelRow,
  targetLabel: string,
): AutomationSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    target_kind: row.target_kind,
    target_session_id: row.target_session_id,
    target_label: targetLabel,
    interval_seconds: row.interval_seconds,
    interval_label: automationIntervalLabel(row.interval_seconds),
    next_run_at: row.next_run_at ?? undefined,
    last_run_at: row.last_run_at ?? undefined,
    last_run_state: row.last_run_state,
    last_safe_error_code: row.last_safe_error_code ?? undefined,
    run_count: row.run_count,
    consecutive_failure_count: row.consecutive_failure_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function automationDetailFromRow(
  row: AutomationReadModelRow,
  targetLabel: string,
): AutomationDetail {
  return {
    ...automationSummaryFromRow(row, targetLabel),
    prompt_body: row.prompt_body,
  };
}

export function automationSummaryWithoutPrompt(
  automation: AutomationDetail | AutomationSummary,
): AutomationSummary {
  const { prompt_body: _promptBody, ...summary } =
    automation as AutomationDetail;
  return summary;
}

export function automationRunFromRow(
  row: AutomationRunReadModelRow,
): AutomationRunSummary {
  return {
    id: row.id,
    automation_id: row.automation_id,
    target_session_id: row.target_session_id,
    state: row.state,
    trigger: row.trigger,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    safe_error_code: row.safe_error_code ?? undefined,
    queued_message_id: row.queued_message_id ?? undefined,
    turn_id: row.turn_id ?? undefined,
  };
}

export function normalizeAutomationInterval(value: number): number {
  const seconds = Math.trunc(value);
  if (!Number.isFinite(seconds) || seconds < 300 || seconds > 86_400) {
    throw new AppStoreOperationError(
      400,
      "automation_interval_invalid",
      "Automation interval must be between 5 minutes and 24 hours.",
    );
  }
  return seconds;
}

function automationIntervalLabel(seconds: number): string {
  if (seconds === 600) return "10 minutes";
  if (seconds === 1800) return "30 minutes";
  if (seconds === 3600) return "1 hour";
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
