import { basename } from "node:path";
import type {
  ChatSummary,
  MessageRecord,
  ProjectSummary,
  SessionSummary,
  SessionViewStatus,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import { publicTurnStatusLabel } from "../../infrastructure/transport/btcc-public-projection.ts";

export interface ChatReadModelRow {
  id: string;
  title: string;
  kind: ChatSummary["kind"];
  project_id: string | null;
  conversation_session_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectReadModelRow {
  id: string;
  display_name: string;
  status: ProjectSummary["status"];
  workspace_path: string;
  workspace_label: string;
  safe_path_label: string;
  pinned: number;
  archived: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummaryReadModelRow {
  id: string;
  title: string;
  kind: ChatSummary["kind"];
  project_id: string | null;
  conversation_session_id?: string | null;
  project_display_name?: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
  active_turn_state: TurnState | null;
  active_turn_safe_error_code: string | null;
  safe_status_label: string | null;
}

export function chatFromRow(row: ChatReadModelRow): ChatSummary {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    project_id: row.project_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function projectFromRow(
  row: ProjectReadModelRow,
  sessions?: SessionSummary[],
): ProjectSummary {
  const activeSessions = (sessions ?? []).filter(
    (session) => !session.archived,
  );
  const latestSessionAt = activeSessions
    .map((session) => session.last_activity_at)
    .sort()
    .at(-1);
  const project: ProjectSummary = {
    id: row.id,
    display_name: row.display_name,
    status: row.status,
    last_activity_at: latestSessionAt ?? row.updated_at,
    active_session_count: activeSessions.length,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    error_summary: row.error_summary ?? undefined,
    workspace_label: row.workspace_label,
    safe_path_label: row.safe_path_label,
  };
  if (sessions) project.sessions = sessions;
  return project;
}

export function paginationInput(options: { limit?: number; offset?: number }): {
  limit: number;
  offset: number;
} {
  const requestedLimit = Number.isFinite(options.limit)
    ? Number(options.limit)
    : 20;
  const requestedOffset = Number.isFinite(options.offset)
    ? Number(options.offset)
    : 0;
  const limit = Math.max(1, Math.min(100, Math.floor(requestedLimit)));
  const offset = Math.max(0, Math.floor(requestedOffset));
  return { limit, offset };
}

export function sessionFromRow(
  row: SessionSummaryReadModelRow,
): SessionSummary {
  const publicStatusLabel = publicTurnStatusLabel(
    row.safe_status_label,
    row.active_turn_state,
    row.active_turn_safe_error_code,
  );
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    project_id: row.project_id ?? undefined,
    project:
      row.project_id && row.project_display_name
        ? { id: row.project_id, display_name: row.project_display_name }
        : undefined,
    session_hint: sessionHintForRow(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.updated_at,
    last_message_preview: previewText(row.last_message_preview),
    active_turn_state: row.active_turn_state ?? undefined,
    safe_status_label: publicStatusLabel,
    unread_count: 0,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    automation_target_count: 0,
  };
}

export function sessionViewStatus(
  latestTurnState: TurnState | "idle" | undefined,
): SessionViewStatus {
  if (!latestTurnState || latestTurnState === "idle") return "idle";
  if (isActiveSessionTurnState(latestTurnState)) return "active";
  if (latestTurnState === "failed") return "failed";
  if (latestTurnState === "cancelled") return "cancelled";
  return "delivered";
}

export function maxMessageCursor(messages: MessageRecord[]): number {
  return messages.reduce((max, message) => {
    const cursor = Number(message.cursor ?? 0);
    return Number.isFinite(cursor) && cursor > max ? cursor : max;
  }, 0);
}

export function previewText(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
}

export function sessionHintForRow(id: string): string {
  return `butler/app-${safeLocalSessionId(id)}`;
}

export function safeLocalSessionId(value: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-");
  return normalized || "session";
}

export function safeDisplayName(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim() || fallback.trim();
  return trimmed.slice(0, 80) || "Project";
}

export function safeWorkspaceLabel(workspacePath: string): string {
  return basename(workspacePath) || "Project";
}

export function isActiveSessionTurnState(state: string): boolean {
  return (
    state === "queued" ||
    state === "accepted" ||
    state === "thinking" ||
    state === "streaming" ||
    state === "waiting_for_form" ||
    state === "waiting_for_tool" ||
    state === "waiting_runtime" ||
    state === "cancelling" ||
    state === "retrying"
  );
}
