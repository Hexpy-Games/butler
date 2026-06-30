import type { Database } from "bun:sqlite";
import type {
  AutomationRunState,
  AutomationState,
  ChatKind,
} from "./protocol.ts";

export interface AutomationRow {
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

export interface AutomationRunRow {
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

export interface QueuedAutomationRunRow {
  run_id: string;
  automation_id: string;
  target_session_id: string;
  trigger: "scheduled" | "run_now";
  queued_message_id: string | null;
  title: string;
  prompt_body: string;
  target_kind: ChatKind;
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

export const AUTOMATION_COLUMNS =
  "id, title, prompt_body, target_kind, target_session_id, interval_seconds, state, " +
  "next_run_at, last_run_at, last_run_state, last_safe_error_code, " +
  "run_count, consecutive_failure_count, created_at, updated_at";

export function getAutomationRow(
  db: Database,
  automationId: string,
): AutomationRow | null {
  return (
    db
      .query<AutomationRow, [string]>(
        `
      SELECT ${AUTOMATION_COLUMNS}
      FROM app_automations
      WHERE id = ?
    `,
      )
      .get(automationId) ?? null
  );
}

export function listAutomationRunRows(
  db: Database,
  automationId: string,
): AutomationRunRow[] {
  return db
    .query<AutomationRunRow, [string]>(
      `
      SELECT rowid, id, automation_id, target_session_id, state, trigger, started_at,
        completed_at, safe_error_code, queued_message_id, turn_id
      FROM app_automation_runs
      WHERE automation_id = ?
      ORDER BY rowid DESC
      LIMIT 50
    `,
    )
    .all(automationId);
}
