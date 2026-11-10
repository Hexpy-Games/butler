import type {
  MessageRecord,
  ProgressRow,
  SessionRelationView,
  SessionSummaryView,
  SessionViewTurn,
  StewardSessionSummaryView,
} from "@/app/types.ts";

export interface AnchoredStewardProgress {
  child: StewardSessionSummaryView;
  turn: SessionViewTurn;
  rows: ProgressRow[];
}

/**
 * Resolve the one factual parent message that owns a Steward child activity
 * card. Both durable relation anchors are required; neither a live nor a
 * terminal child is attached to the newest or merely same-session message.
 */
export function anchoredStewardProgressByMessageId(
  messages: MessageRecord[],
  summary: SessionSummaryView | null | undefined,
): Map<string, AnchoredStewardProgress> {
  const result = new Map<string, AnchoredStewardProgress>();
  const ambiguousParents = new Set<string>();
  if (!summary?.session_id) return result;
  for (const child of summary.steward_children ?? []) {
    const turn = child.active_turn ?? child.latest_turn;
    const relation = child.relation;
    if (!turn || relation.child_session_id !== child.session_id) continue;

    const parentIndex = parentMessageIndex(messages, relation, summary.session_id);
    if (parentIndex < 0) continue;

    const parent = messages[parentIndex];
    if (!parent?.id) continue;
    if (parent.chat_id !== summary.session_id) continue;
    if (ambiguousParents.has(parent.id)) continue;
    if (result.has(parent.id)) {
      result.delete(parent.id);
      ambiguousParents.add(parent.id);
      continue;
    }
    result.set(parent.id, {
      child,
      turn,
      rows: turn.progress?.safe_progress_rows ?? [],
    });
  }
  return result;
}

/**
 * The parent turn's assistant message. A request the owner sees must be the
 * user message right before it. A Butler-initiated turn (a schedule run, a
 * canon step, a delegated result) keeps its request off the chat, so its
 * parent turn alone identifies the message.
 */
function parentMessageIndex(
  messages: MessageRecord[],
  relation: SessionRelationView,
  sessionId: string,
): number {
  const anchorIndex = messages.findIndex(
    (message) => message.id === relation.anchor_message_id,
  );
  if (anchorIndex < 0) {
    const index = messages.findIndex(
      (message) =>
        message.role === "assistant" && message.turn_id === relation.parent_turn_id,
    );
    return index >= 0 && messages[index]?.initiated ? index : -1;
  }
  if (messages[anchorIndex]?.role !== "user") return -1;
  if (messages[anchorIndex]?.chat_id !== sessionId) return -1;

  let parentIndex = -1;
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.turn_id === relation.parent_turn_id
    ) {
      parentIndex = index;
      break;
    }
  }
  if (parentIndex < 0) return -1;

  for (let index = parentIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.id === relation.anchor_message_id ? parentIndex : -1;
    }
  }
  return -1;
}
