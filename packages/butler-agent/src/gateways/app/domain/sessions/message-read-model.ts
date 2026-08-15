import type {
  MessageFileKind,
  MessageFileRef,
  MessageRecord,
  MessageRole,
  MessageStatus,
  SessionArtifactSummary,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import {
  verifyTurnExecutionControls,
  type TurnExecutionControlsV1,
} from "../../../core/turn-execution-controls.ts";

export interface MessageReadModelRow {
  rowid: number;
  id: string;
  chat_id: string;
  turn_id: string | null;
  conversation_session_id: string | null;
  conversation_turn_id: string | null;
  conversation_message_id: string | null;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  safe_error_code: string | null;
  retryable: number;
  created_at: string;
  updated_at: string;
}

export interface MessageFileReadModelRow {
  id: string;
  owner_session_id: string | null;
  storage_name: string;
  safe_name: string;
  mime_type: string;
  kind: MessageFileKind;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

/**
 * The bounded artifact projection joins the latest message window directly
 * to attachment rows. It intentionally carries only the fields needed by
 * the public artifact contract, rather than materializing MessageRecord
 * objects and their transcript text.
 */
export interface SessionArtifactReadModelRow extends MessageFileReadModelRow {
  message_rowid: number;
  message_id: string;
  chat_id: string;
  turn_id: string | null;
}

export interface TurnReadModelRow {
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
  execution_controls_json?: string | null;
  execution_model_json?: string | null;
  created_at: string;
  updated_at: string;
}

export function messageFromRow(
  row: MessageReadModelRow,
  attachments: MessageFileRef[] = [],
): MessageRecord {
  const message: MessageRecord = {
    id: row.id,
    chat_id: row.chat_id,
    turn_id: row.turn_id ?? undefined,
    conversation_session_id: row.conversation_session_id ?? undefined,
    conversation_turn_id: row.conversation_turn_id ?? undefined,
    conversation_message_id: row.conversation_message_id ?? undefined,
    role: row.role,
    text: row.text,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    safe_error_code: row.safe_error_code ?? undefined,
    retryable: row.retryable === 1,
    cursor: row.rowid,
  };
  if (attachments.length > 0) message.attachments = attachments;
  const artifacts = artifactSummariesFromMessage(row, attachments);
  if (artifacts.length > 0) message.artifacts = artifacts;
  return message;
}

export function messageFileRefFromRow(
  row: MessageFileReadModelRow,
): MessageFileRef {
  return {
    file_id: row.id,
    kind: row.kind,
    mime_type: row.mime_type,
    safe_name: row.safe_name,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    url: `/message-files/${encodeURIComponent(row.id)}`,
    created_at: row.created_at,
  };
}

export function turnFromRow(row: TurnReadModelRow): TurnRecord {
  const executionControls = executionControlsFromJson(
    row.execution_controls_json,
  );
  const executionModel = executionModelFromJson(row.execution_model_json);
  return {
    id: row.id,
    chat_id: row.chat_id,
    user_message_id: row.user_message_id ?? undefined,
    state: row.state,
    safe_status_label: row.safe_status_label,
    safe_error_code: row.safe_error_code ?? undefined,
    retryable: row.retryable === 1,
    cancellable: row.cancellable === 1,
    attempt: row.attempt,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cursor: row.rowid,
    execution_controls: executionControls,
    execution_model: executionModel,
  };
}

function executionModelFromJson(
  value: string | null | undefined,
): TurnRecord["execution_model"] {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as {
      requested_model_ref?: unknown;
      adapter_effective_model_ref?: unknown;
      provider_reported_model_ref?: unknown;
    };
    if (
      typeof parsed.requested_model_ref !== "string" ||
      typeof parsed.adapter_effective_model_ref !== "string"
    ) return undefined;
    return {
      requested_model_ref: parsed.requested_model_ref,
      adapter_effective_model_ref: parsed.adapter_effective_model_ref,
      ...(typeof parsed.provider_reported_model_ref === "string"
        ? { provider_reported_model_ref: parsed.provider_reported_model_ref }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function executionControlsFromJson(
  value: string | null | undefined,
): TurnExecutionControlsV1 | undefined {
  if (!value) return undefined;
  return verifyTurnExecutionControls(JSON.parse(value));
}

export function isTerminalTurnState(state: TurnState): boolean {
  return (
    state === "delivered" ||
    state === "failed" ||
    state === "runtime_fault" ||
    state === "cancelled"
  );
}

function artifactSummariesFromMessage(
  row: MessageReadModelRow,
  attachments: MessageFileRef[],
): SessionArtifactSummary[] {
  if (row.role !== "assistant" || attachments.length === 0) return [];
  return attachments.map((attachment) => ({
    id: `artifact-${attachment.file_id}`,
    session_id: row.chat_id,
    message_id: row.id,
    turn_id: row.turn_id ?? undefined,
    file_id: attachment.file_id,
    kind: artifactKindFromMessageFile(attachment),
    title: attachment.safe_name,
    safe_path_label: attachment.safe_name,
    url: attachment.url,
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
    open_action: "route",
  }));
}

export function artifactSummaryFromRow(
  row: SessionArtifactReadModelRow,
): SessionArtifactSummary {
  const attachment = messageFileRefFromRow(row);
  return {
    id: `artifact-${attachment.file_id}`,
    session_id: row.chat_id,
    message_id: row.message_id,
    turn_id: row.turn_id ?? undefined,
    file_id: attachment.file_id,
    kind: artifactKindFromMessageFile(attachment),
    title: attachment.safe_name,
    safe_path_label: attachment.safe_name,
    url: attachment.url,
    size_bytes: attachment.size_bytes,
    created_at: attachment.created_at,
    open_action: "route",
  };
}

function artifactKindFromMessageFile(
  file: MessageFileRef,
): SessionArtifactSummary["kind"] {
  const name = file.safe_name.toLocaleLowerCase("en-US");
  const mime = file.mime_type.toLocaleLowerCase("en-US");
  if (file.kind === "image") return "image";
  if (mime === "text/csv" || name.endsWith(".csv")) return "csv_file";
  if (mime === "text/tab-separated-values" || name.endsWith(".tsv")) {
    return "table_file";
  }
  if (mime === "application/pdf") return "report";
  if (file.kind === "text") return "document";
  if (
    [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"].some(
      (ext) => name.endsWith(ext),
    )
  ) {
    return "code";
  }
  return "file";
}
