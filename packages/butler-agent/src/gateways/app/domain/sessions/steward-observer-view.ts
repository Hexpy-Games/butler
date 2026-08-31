import {
  APP_PROTOCOL_VERSION,
  type MessageRecord,
  type SessionView,
} from "../../interface/protocol/app-protocol.ts";
import { encodeSessionCursor } from "./session-message-page.ts";
import {
  projectStewardSession,
  emptyStewardProjection,
  projectStewardActivityRows,
  type ProjectedStewardSession,
  type StewardObserverRelation,
  type StewardObserverSnapshot,
} from "./steward-observer.ts";

export function sessionViewForStewardObserver(
  relation: StewardObserverRelation,
  snapshot: StewardObserverSnapshot | null,
  latestEventCursor: number,
): SessionView {
  const projected = snapshot
    ? projectStewardSession(relation, snapshot)
    : emptyStewardProjection(relation);
  const messages = snapshot
    ? snapshot.messages.map((message, index) => {
      const activityRows = message.role === "assistant"
        ? projectStewardActivityRows(snapshot, message.turn_id)
        : [];
      return {
        id: message.id,
        chat_id: message.session_id,
        turn_id: message.turn_id,
        role: message.role,
        text: safeChildMessageText(message, projected),
        status: projectedStatus(projected.status),
        retryable: false,
        cursor: index + 1,
        created_at: message.created_at,
        updated_at: message.updated_at,
        ...(activityRows.length > 0
          ? { turn_activity_rows: activityRows }
          : {}),
        ...(index === snapshot.messages.length - 1 && projected.artifacts.length > 0
          ? { artifacts: projected.artifacts }
          : {}),
        ...(index === snapshot.messages.length - 1 && projected.changed_files.length > 0
          ? { changed_files: projected.changed_files }
          : {}),
      } satisfies MessageRecord;
    })
    : [];
  const resultMessage = projected.result && !messages.some(
    (message) =>
      message.id === projected.result?.result_id ||
      (message.role === "assistant" &&
        message.turn_id === projected.result?.child_turn_id),
  )
    ? {
        id: projected.result.result_id,
        chat_id: projected.session_id,
        turn_id: projected.result.child_turn_id,
        role: "assistant" as const,
        text: projected.result.summary,
        status: projectedStatus(projected.status),
        retryable: false,
        cursor: messages.length + 1,
        created_at: projected.result.created_at,
        updated_at: projected.result.created_at,
        ...(projected.activity_rows.length > 0
          ? { turn_activity_rows: projected.activity_rows }
          : {}),
        artifacts: projected.artifacts,
        changed_files: projected.changed_files,
      }
    : null;
  const fullMessages = resultMessage ? [...messages, resultMessage] : messages;
  return {
    protocol_version: APP_PROTOCOL_VERSION,
    session_id: projected.session_id,
    kind: "chat",
    status: projected.status,
    active_turn: projected.active_turn,
    latest_turn: projected.latest_turn,
    messages: fullMessages,
    message_window: {
      next_cursor: fullMessages.length,
      complete: true,
      ...(fullMessages.length > 0
        ? { next_cursor_token: encodeSessionCursor(projected.session_id, fullMessages.length) }
        : {}),
    },
    workers: [],
    work_streams: [],
    artifacts: projected.artifacts,
    context: null,
    branch: null,
    skills_used: [],
    automations: [],
    errors: [],
    cursors: {
      messages: fullMessages.length,
      events: latestEventCursor,
    },
    parent_session_id: relation.parent_session_id,
    relation,
    steward_children: [],
    generated_at: new Date().toISOString(),
    updated_at: projected.updated_at,
  };
}

function safeChildMessageText(
  message: StewardObserverSnapshot["messages"][number],
  projected: ProjectedStewardSession,
): string {
  if (message.role === "assistant" &&
    projected.result?.child_turn_id === message.turn_id) {
    return projected.result.summary;
  }
  return message.text;
}

function projectedStatus(
  status: ProjectedStewardSession["status"],
): MessageRecord["status"] {
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "thinking";
}
