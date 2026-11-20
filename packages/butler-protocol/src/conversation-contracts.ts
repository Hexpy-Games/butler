import type { AnswerBlockSet } from "./app-contracts.ts";
import type { ChatKind, MessageFileRef, TurnState } from "./message-session-contracts.ts";

export type RuntimeDeliveryState =
  | "running"
  | "waiting_user"
  | "system_error"
  | "cancelled"
  | "delivered"
  | "delivered_with_limitations"
  | "delivered_with_continuation"
  | "failed_system";

export type SessionViewStatus =
  | "idle"
  | "active"
  | "delivered"
  | "failed"
  | "cancelled";

export interface SessionViewTurn {
  id: string;
  state: TurnState;
  safe_status_label?: string;
  cancellable: boolean;
  retryable: boolean;
  delivery_state?: RuntimeDeliveryState;
  created_at: string;
  updated_at: string;
}

export interface SessionViewMessageWindow {
  next_cursor: number;
  complete: boolean;
  previous_cursor?: number;
  previous_cursor_token?: string;
  requested_cursor?: number;
  requested_cursor_token?: string;
  requested_before_cursor?: number;
  requested_before_cursor_token?: string;
  next_cursor_token?: string;
  has_more?: boolean;
}

export interface SessionViewCursors {
  messages: number;
  events: number;
}

export type MessageRole = "user" | "assistant" | "system" | "system_event" | "tool_summary" | "automation";

export interface ConversationMessage {
  id: string;
  chat_id?: string;
  turn_id?: string;
  role: MessageRole;
  text: string;
  answer_blocks?: AnswerBlockSet[];
  attachments?: MessageFileRef[];
  status?: string;
  delivery_state?: RuntimeDeliveryState;
  safe_error_code?: string;
  retryable?: boolean;
  cursor?: number;
  created_at?: string;
  updated_at?: string;
}

export interface SessionView {
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  context?: ContextDetails | null;
  branch?: SessionBranch | null;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  messages: ConversationMessage[];
  message_window: SessionViewMessageWindow;
  cursors: SessionViewCursors;
  updated_at: string;
}

export interface MessageSendRequest {
  chat_id: string;
  text: string;
  client_message_id: string;
  attachments: { file_id: string }[];
  queue_policy: "send_now" | "enqueue_if_busy";
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelSummary {
  provider_id: string;
  provider_label: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  availability?: "ready" | "sign_in_required" | "plan_off" | "not_in_plan";
  /** Catalog image capability; absent means unknown. */
  image_input_support?: "supported" | "unsupported" | "unknown";
}

export interface ModelCatalog {
  generation: string;
  default_model_ref: string;
  default_reasoning_effort: ReasoningEffort;
  models: ModelSummary[];
  registered_models?: ModelSummary[];
}

export interface SessionControls {
  model: string;
  reasoning_effort: ReasoningEffort;
  access_mode: string;
  plan_mode: boolean;
}

export interface SessionControlsView {
  session_id: string;
  controls: SessionControls;
  revision: number;
  catalog_generation: string;
}

export interface ContextDetails {
  used_tokens: number;
  budget_tokens: number;
  ratio: number;
  auto_compact_at_tokens?: number;
  model_ref?: string;
}

export interface SessionBranch {
  available: boolean;
  label?: string;
  workspace_path?: string;
  branch?: string;
  safe_status?: string;
}
