import {
  APP_PROTOCOL_VERSION,
  type MessageRecord,
  type SessionView,
} from "../../interface/protocol/app-protocol.ts";
import { encodeSessionCursor } from "./session-message-page.ts";
import {
  projectStewardSession,
  emptyStewardProjection,
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
  const lastAssistantMessageId = snapshot?.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant")?.id;
  const messages = snapshot
    ? snapshot.messages.map((message, index) => ({
        id: message.id,
        chat_id: message.session_id,
        turn_id: message.turn_id,
        role: message.role,
        text: safeChildMessageText(message, relation, projected),
        status: projectedStatus(projected.status),
        retryable: false,
        cursor: index + 1,
        created_at: message.created_at,
        updated_at: message.updated_at,
        ...(!projected.active_turn &&
        message.id === lastAssistantMessageId &&
        projected.activity_rows.length > 0
          ? { turn_activity_rows: projected.activity_rows }
          : {}),
        ...(index === snapshot.messages.length - 1 && projected.artifacts.length > 0
          ? { artifacts: projected.artifacts }
          : {}),
      } satisfies MessageRecord))
    : [];
  const resultMessage = projected.result && !messages.some(
    (message) => message.id === projected.result?.result_id,
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
  relation: StewardObserverRelation,
  projected: ProjectedStewardSession,
): string {
  if (message.role === "user") return relation.safe_title;
  return projected.result?.summary ?? "Steward progress is available in the activity view.";
}

function projectedStatus(
  status: ProjectedStewardSession["status"],
): MessageRecord["status"] {
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "thinking";
}
