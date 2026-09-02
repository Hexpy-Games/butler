import type { ChatKind } from "./base-contract.ts";
import type { MessageRecord } from "./messaging-contract.ts";
import type { WorkerActivityWorkBlock } from "./progress-contract.ts";

export type AutomationState =
  | "enabled"
  | "paused"
  | "running"
  | "failed"
  | "deleted";
export type AutomationRunState =
  | "never_run"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_target_unavailable"
  | "cancelled";

export interface AutomationTargetSummary {
  automation_id: string;
  title: string;
  state: AutomationState;
  interval_label: string;
  next_run_at?: string;
  last_run_state: AutomationRunState;
  safe_error_code?: string;
}

export interface AutomationSummary {
  id: string;
  title: string;
  state: AutomationState;
  target_kind: ChatKind;
  target_session_id: string;
  target_label: string;
  interval_seconds: number;
  interval_label: string;
  next_run_at?: string;
  last_run_at?: string;
  last_run_state: AutomationRunState;
  last_safe_error_code?: string;
  run_count: number;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationDetail extends AutomationSummary {
  prompt_body: string;
}

export interface AutomationListView {
  automations: AutomationSummary[];
}

export interface AutomationDetailView {
  automation: AutomationDetail;
}

export interface AutomationRunSummary {
  id: string;
  automation_id: string;
  target_session_id: string;
  state: AutomationRunState;
  trigger: "scheduled" | "run_now";
  started_at: string;
  completed_at?: string;
  safe_error_code?: string;
  queued_message_id?: string;
  turn_id?: string;
}

export interface AutomationRunListView {
  runs: AutomationRunSummary[];
}

export interface CreateAutomationRequest {
  title: string;
  prompt_body: string;
  target_session_id: string;
  interval_seconds: number;
}

export interface UpdateAutomationRequest {
  title?: string;
  prompt_body?: string;
  target_session_id?: string;
  interval_seconds?: number;
  state?: "enabled" | "paused";
}

export interface AutomationMutationResult {
  automation: AutomationDetail | AutomationSummary;
}

export interface AutomationRunResult {
  automation: AutomationSummary;
  run: AutomationRunSummary;
}

export type WorkerActivityPhase =
  | "orienting"
  | "planning"
  | "inspecting"
  | "executing"
  | "verifying"
  | "committing"
  | "consolidating"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable";

export interface WorkerActivitySummary {
  worker_id: string;
  activity_kind: "planned" | "worker";
  worker_label: string;
  worker_display_name: string;
  worker_ordinal_label: string;
  objective: string;
  phase: WorkerActivityPhase;
  status_line: string;
  current_activity_title?: string;
  work_blocks?: WorkerActivityWorkBlock[];
  session_id?: string;
  parent_turn_id?: string;
  project_id?: string;
  task_id?: string;
  orchestration_id?: string;
  terminal: boolean;
  created_at?: string;
  updated_at: string;
  supported_controls: Array<"cancel" | "resume">;
}

export interface WorkerActivityListView {
  workers: WorkerActivitySummary[];
  pagination?: {
    limit: number;
    offset: number;
    has_more: boolean;
    next_cursor?: string;
  };
}

export interface WorkerActivityControlRequest {
  action: "cancel" | "resume";
}

export interface WorkerActivityControlResult {
  worker: WorkerActivitySummary;
  notice?: MessageRecord;
}
