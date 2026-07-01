import type {
  ChatKind,
  MessageRole,
  MessageStatus,
  QueuedMessageRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";

export interface ChatRow {
  id: string;
  title: string;
  kind: ChatKind;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  display_name: string;
  status: "active" | "archived";
  workspace_path: string;
  workspace_label: string;
  safe_path_label: string;
  pinned: number;
  archived: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummaryRow {
  id: string;
  kind: ChatKind;
  title: string;
  project_id: string | null;
  project_display_name?: string | null;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
  active_turn_state: TurnState | null;
  safe_status_label: string | null;
  active_turn_safe_error_code: string | null;
  pinned: number;
  archived: number;
}

export interface MessageRow {
  rowid: number;
  id: string;
  chat_id: string;
  turn_id: string | null;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
  safe_error_code: string | null;
  retryable: number;
}

export interface QueuedMessageRow {
  rowid: number;
  id: string;
  chat_id: string;
  text: string;
  controls_json: string;
  attachments_json: string;
  state: QueuedMessageRecord["state"];
  safe_error_code: string | null;
  dispatched_message_id: string | null;
  turn_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface TurnRow {
  rowid: number;
  id: string;
  chat_id: string;
  user_message_id: string | null;
  state: TurnState;
  safe_status_label: string;
  safe_error_code: string | null;
  retryable: number;
  cancellable: number;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export interface SettingRow {
  key: string;
  value_json: string;
}
