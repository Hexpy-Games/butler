// v1 allows backward-compatible optional response fields; bump only for
// required-field or incompatible semantic changes.
export const APP_PROTOCOL_VERSION = "butler.app.v1";

export type ChatKind = "chat" | "project";
export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "system_event"
  | "tool_summary"
  | "automation";
export type ProjectStatus = "active" | "archived";
export type MessageStatus =
  | "pending"
  | "sent"
  | "thinking"
  | "streaming"
  | "delivered"
  | "failed"
  | "retrying"
  | "cancelled";
export type MessageFileKind = "text" | "image" | "generic";
export type TurnState =
  | "queued"
  | "accepted"
  | "thinking"
  | "streaming"
  | "waiting_for_form"
  | "waiting_for_tool"
  | "waiting_runtime"
  | "cancelling"
  | "cancelled"
  | "delivered"
  | "runtime_fault"
  | "failed"
  | "retrying";
export interface ApiEnvelope<T> {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  data: T;
}

export interface ApiErrorEnvelope {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  error: {
    code: string;
    message: string;
  };
}

export function apiEnvelope<T>(data: T): ApiEnvelope<T> {
  return { protocol_version: APP_PROTOCOL_VERSION, data };
}

export function apiError(code: string, message: string): ApiErrorEnvelope {
  return { protocol_version: APP_PROTOCOL_VERSION, error: { code, message } };
}
