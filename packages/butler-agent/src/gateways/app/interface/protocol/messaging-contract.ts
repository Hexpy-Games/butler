import { APP_PROTOCOL_VERSION } from "./base-contract.ts";
import type { MessageRole, MessageStatus, TurnState } from "./base-contract.ts";
import type { SettingsView } from "./settings-contract.ts";
import type { TurnExecutionControlsV1 } from "../../../core/turn-execution-controls.ts";
import type {
  MessageAttachmentInput,
  MessageFileRef,
  SessionArtifactSummary,
} from "./attachment-contract.ts";
import type {
  ProgressSummaryRow,
  WorkerActivityWorkBlock,
} from "./progress-contract.ts";
import type {
  SessionControlState,
  SessionViewTurnDeliveryState,
  TurnProgressSnapshotView,
} from "./session-contract.ts";

export interface MessageRecord {
  id: string;
  chat_id: string;
  turn_id?: string;
  conversation_session_id?: string;
  conversation_turn_id?: string;
  conversation_message_id?: string;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
  safe_error_code?: string;
  delivery_state?: SessionViewTurnDeliveryState;
  limitation_codes?: string[];
  limitations?: string[];
  retryable: boolean;
  cursor: number;
  attachments?: MessageFileRef[];
  artifacts?: SessionArtifactSummary[];
  work_blocks?: WorkerActivityWorkBlock[];
  turn_activity_rows?: ProgressSummaryRow[];
}

export interface MessageSendRequest {
  chat_id?: string;
  text?: string;
  client_message_id?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
  queue_policy?: "send_now" | "enqueue_if_busy";
  /** @internal Durable authority Allow adapter identity. */
  authority_request_ref?: string;
  /** @internal Trusted durable Steward-result synthesis origin. */
  subsession_result?: import("../../../core/turn-execution-controls.ts").SubsessionResultTurnContext;
}

export interface MessageSendResult {
  accepted?: MessageRecord;
  queued?: QueuedMessageRecord;
  reply?: MessageRecord;
  replies: MessageRecord[];
  turn?: TurnRecord;
  next_cursor: number;
}

export interface QueuedMessageRecord {
  id: string;
  chat_id: string;
  text: string;
  client_message_id?: string;
  attachments?: MessageFileRef[];
  controls: SessionControlState;
  state: "queued" | "dispatching" | "dispatched" | "deleted" | "failed";
  safe_error_code?: string;
  dispatched_message_id?: string;
  turn_id?: string;
  terminal_result_message_id?: string;
  cursor: number;
  created_at: string;
  updated_at: string;
}

export interface SessionQueueView {
  session_id: string;
  queued_messages: QueuedMessageRecord[];
}

export interface QueueMessageRequest {
  chat_id?: string;
  text?: string;
  client_message_id?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
  /** @internal Durable authority Allow adapter identity. */
  authority_request_ref?: string;
  /** @internal Trusted durable Steward-result synthesis origin. */
  subsession_result?: import("../../../core/turn-execution-controls.ts").SubsessionResultTurnContext;
}

export interface UpdateQueuedMessageRequest {
  text?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
  /** @internal Durable authority Allow adapter identity. */
  authority_request_ref?: string;
  /** @internal Trusted durable Steward-result synthesis origin. */
  subsession_result?: import("../../../core/turn-execution-controls.ts").SubsessionResultTurnContext;
}

export interface TurnRecord {
  id: string;
  chat_id: string;
  user_message_id?: string;
  state: TurnState;
  safe_status_label: string;
  safe_error_code?: string;
  retryable: boolean;
  cancellable: boolean;
  attempt: number;
  created_at: string;
  updated_at: string;
  cursor: number;
  execution_controls?: TurnExecutionControlsV1;
  execution_model?: {
    requested_model_ref: string;
    adapter_effective_model_ref: string;
    provider_reported_model_ref?: string;
  };
}

export interface AppEventEnvelope {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  id: number;
  type:
    | "message.created"
    | "message.deleted"
    | "chat.created"
    | "server.status"
    | "turn.state_changed"
    | "context.compaction.started"
    | "context.compaction.completed"
    | string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface HealthView {
  ok: boolean;
  service: "butler-app-server";
  protocol_version: typeof APP_PROTOCOL_VERSION;
}

export interface MessageListView {
  chat_id: string;
  messages: MessageRecord[];
  turn_progress?: Record<string, TurnProgressSnapshotView>;
  next_cursor: number;
}

export interface EventReplayView {
  events: AppEventEnvelope[];
  next_cursor: number;
}

export interface TurnListView {
  chat_id: string;
  turns: TurnRecord[];
  next_cursor: number;
}

export interface TurnActionResult {
  turn: TurnRecord;
  reply?: MessageRecord;
  replies: MessageRecord[];
  next_cursor: number;
}
