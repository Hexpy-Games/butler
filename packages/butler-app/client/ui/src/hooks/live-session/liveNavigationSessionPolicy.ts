import type { SessionSummary, TimelineEvent } from "../../app/types.ts";

const SAFE_SESSION_KEYS = new Set([
  "id",
  "kind",
  "title",
  "project_id",
  "project",
  "session_hint",
  "created_at",
  "updated_at",
  "last_activity_at",
  "last_message_preview",
  "active_turn_state",
  "safe_status_label",
  "unread_count",
  "pinned",
  "archived",
  "automation_target_count",
]);

export function safeSessionSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null;
  const safeValue: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_SESSION_KEYS.has(key)) safeValue[key] = entry;
  }
  if (
    typeof safeValue.id !== "string" || !safeValue.id.trim() ||
    (safeValue.kind !== "chat" && safeValue.kind !== "project") ||
    typeof safeValue.title !== "string" ||
    typeof safeValue.last_activity_at !== "string" ||
    !isTimestamp(safeValue.last_activity_at) ||
    typeof safeValue.updated_at !== "string" || !isTimestamp(safeValue.updated_at) ||
    typeof safeValue.created_at !== "string" || !isTimestamp(safeValue.created_at) ||
    typeof safeValue.pinned !== "boolean" ||
    typeof safeValue.archived !== "boolean"
  ) {
    return null;
  }
  if (
    ("project_id" in safeValue && safeValue.project_id !== undefined &&
      typeof safeValue.project_id !== "string") ||
    ("created_at" in safeValue && !isTimestamp(safeValue.created_at)) ||
    ("updated_at" in safeValue && !isTimestamp(safeValue.updated_at)) ||
    ("last_activity_at" in safeValue && !isTimestamp(safeValue.last_activity_at)) ||
    ("project" in safeValue && !isRecord(safeValue.project)) ||
    ("session_hint" in safeValue && typeof safeValue.session_hint !== "string") ||
    ("last_message_preview" in safeValue &&
      typeof safeValue.last_message_preview !== "string") ||
    ("active_turn_state" in safeValue && typeof safeValue.active_turn_state !== "string") ||
    ("safe_status_label" in safeValue && typeof safeValue.safe_status_label !== "string") ||
    ("unread_count" in safeValue && !isNonNegativeNumber(safeValue.unread_count)) ||
    ("automation_target_count" in safeValue &&
      !isNonNegativeNumber(safeValue.automation_target_count)) ||
    ("pinned" in safeValue && typeof safeValue.pinned !== "boolean") ||
    ("archived" in safeValue && typeof safeValue.archived !== "boolean")
  ) {
    return null;
  }
  if (isRecord(safeValue.project) && (
    typeof safeValue.project.id !== "string" ||
    typeof safeValue.project.display_name !== "string"
  )) return null;
  if (isRecord(safeValue.project) && safeValue.project.id !== safeValue.project_id) {
    return null;
  }
  if (safeValue.kind === "project" &&
    (typeof safeValue.project_id !== "string" || !safeValue.project_id.trim())) {
    return null;
  }
  const summary: SessionSummary = {
    id: safeValue.id,
    kind: safeValue.kind,
    title: safeValue.title,
    project_id: typeof safeValue.project_id === "string" ? safeValue.project_id : undefined,
    created_at: safeValue.created_at,
    updated_at: safeValue.updated_at,
    last_activity_at: safeValue.last_activity_at,
    pinned: safeValue.pinned,
    archived: safeValue.archived,
  };
  if (isRecord(safeValue.project) &&
    typeof safeValue.project.id === "string" &&
    typeof safeValue.project.display_name === "string") {
    summary.project = {
      id: safeValue.project.id,
      display_name: safeValue.project.display_name,
    };
  }
  if (typeof safeValue.last_message_preview === "string") {
    summary.last_message_preview = safeValue.last_message_preview;
  }
  if (typeof safeValue.active_turn_state === "string") {
    summary.active_turn_state = safeValue.active_turn_state;
  }
  if (typeof safeValue.safe_status_label === "string") {
    summary.safe_status_label = safeValue.safe_status_label;
  }
  if (typeof safeValue.unread_count === "number" && Number.isFinite(safeValue.unread_count)) {
    summary.unread_count = safeValue.unread_count;
  }
  if (typeof safeValue.automation_target_count === "number" &&
    Number.isFinite(safeValue.automation_target_count)) {
    summary.automation_target_count = safeValue.automation_target_count;
  }
  return summary;
}

export function sessionIdFromEvent(event: TimelineEvent): string | undefined {
  const session = event.payload?.session;
  if (isRecord(session) && typeof session.id === "string") return session.id;
  return event.payload?.session_id;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function timestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareTimestamp(left?: string, right?: string): number {
  const leftTimestamp = timestampMs(left);
  const rightTimestamp = timestampMs(right);
  if (leftTimestamp === null && rightTimestamp === null) return 0;
  if (leftTimestamp === null) return -1;
  if (rightTimestamp === null) return 1;
  return leftTimestamp - rightTimestamp;
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestampMs(value) !== null;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
