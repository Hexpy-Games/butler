import type { TurnState } from "../../interface/protocol/app-protocol.ts";

export interface AppConversationProjectionStatus {
  gateway: string;
  last_outbox_id: string | null;
  updated_at: string | null;
  pending_count: number;
  safe_error_code: string | null;
}

export interface AppConversationProjectionReplayResult {
  ok: boolean;
  processed: number;
  projected_messages: number;
  last_outbox_id: string | null;
  pending_count: number;
  safe_error_code?: string;
  failed_outbox_id?: string;
}

export interface AppConversationProjectionRebuildResult {
  ok: boolean;
  conversation_session_id: string;
  projected_messages: number;
  safe_error_code?: string;
}

export interface AppConversationProjectionBindingRef {
  gateway: string;
  external_session_id: string;
  conversation_session_id: string;
}

export interface AppConversationProjectionActivityState {
  conversation_session_id: string;
  app_session_id: string | null;
  latest_turn_state: TurnState | null;
  latest_turn_safe_error_code: string | null;
  latest_activity_updated_at: string | null;
  projection_pending_count: number;
  safe_error_code: string | null;
}
