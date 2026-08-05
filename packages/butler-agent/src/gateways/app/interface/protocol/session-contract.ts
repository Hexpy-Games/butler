import { APP_PROTOCOL_VERSION } from "./base-contract.ts";
import type { ChatKind, TurnState } from "./base-contract.ts";
import type {
  AutomationTargetSummary,
  WorkerActivitySummary,
} from "./automation-worker-contract.ts";
import type { ContextDetailsView } from "./context-contract.ts";
import type { MessageRecord, TurnRecord } from "./messaging-contract.ts";
import type { ProgressSummaryRow } from "./progress-contract.ts";
import type { SessionArtifactSummary } from "./attachment-contract.ts";
import type { SettingsView } from "./settings-contract.ts";

export interface SessionControlState {
  model: string;
  reasoning_effort: SettingsView["reasoning_effort"];
  access_mode: SettingsView["access_mode"];
  plan_mode: boolean;
}

export interface SessionControlsView {
  session_id: string;
  controls: SessionControlState;
  revision: number;
  catalog_generation: string;
}

export interface WorkStreamSummaryView {
  id: string;
  title: string;
  owner_session_id?: string;
  project_id?: string;
  state: string;
  current_phase?: string;
  active_step_id?: string;
  todo_list_id?: string;
  terminal: boolean;
  updated_at: string;
}

export interface TurnProgressSnapshotView {
  summary?: string;
  updated_at?: string;
  turn_id?: string;
  state?: TurnState | "idle";
  delivery_state?: SessionViewTurnDeliveryState;
  limitations?: string[];
  limitation_codes?: string[];
  safe_progress_rows: ProgressSummaryRow[];
}

export type SessionViewStatus =
  | "idle"
  | "active"
  | "delivered"
  | "failed"
  | "cancelled";

export interface SessionViewTurn {
  id: string;
  state: TurnState;
  delivery_state: SessionViewTurnDeliveryState;
  limitations: string[];
  limitation_codes: string[];
  safe_status_label?: string;
  cancellable: boolean;
  retryable: boolean;
  progress: TurnProgressSnapshotView;
  created_at: string;
  updated_at: string;
  execution_controls?: Pick<
    NonNullable<TurnRecord["execution_controls"]>,
    "model_ref" | "reasoning_effort" | "source"
  >;
  execution_model?: NonNullable<TurnRecord["execution_model"]>;
}

export type SessionViewTurnDeliveryState =
  | "running"
  | "waiting_user"
  | "system_error"
  | "cancelled"
  | "delivered"
  | "delivered_with_limitations"
  | "delivered_with_continuation"
  | "failed_system";

export interface SessionViewMessageWindow {
  next_cursor: number;
  complete: boolean;
}

export interface SafeSessionError {
  code: string;
  message: string;
  created_at: string;
}

export interface SessionViewCursors {
  messages: number;
  events: number;
}

export interface SessionView {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  messages: MessageRecord[];
  message_window: SessionViewMessageWindow;
  workers: WorkerActivitySummary[];
  work_streams: WorkStreamSummaryView[];
  artifacts: SessionArtifactSummary[];
  context: ContextDetailsView | null;
  branch: SessionSummaryView["branch_info"] | null;
  skills_used: string[];
  automations: AutomationTargetSummary[];
  errors: SafeSessionError[];
  cursors: SessionViewCursors;
  generated_at: string;
  updated_at: string;
}

export interface SessionSummaryView {
  session_id: string;
  latest_progress: TurnProgressSnapshotView;
  turn_state: TurnState | "idle";
  branch_info: {
    available: boolean;
    workspace_mode: "git" | "folder" | "none" | "unknown";
    branch_name?: string;
    safe_status: string;
    safe_error_code?: string;
  };
  artifacts: SessionArtifactSummary[];
  skills_used: string[];
  context_details: ContextDetailsView;
  safe_errors: Array<{ code: string; message: string; created_at: string }>;
  automation_targets: AutomationTargetSummary[];
  worker_activity: WorkerActivitySummary[];
  work_streams: WorkStreamSummaryView[];
  staleness: {
    state: "fresh" | "stale" | "unavailable" | "failed";
    updated_at: string;
    source: string;
  };
}

export interface TranscriptExportView {
  session_id: string;
  format: "markdown";
  filename: string;
  content: string;
  message_count: number;
  generated_at: string;
}
