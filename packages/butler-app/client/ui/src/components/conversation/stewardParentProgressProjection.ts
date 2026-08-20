import type {
  MessageRecord,
  ProgressRow,
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
 * Resolve the one factual parent message that may host a live Steward child.
 * Both durable relation anchors are required; an active child is never
 * attached to the newest or merely same-session message.
 */
export function anchoredStewardProgressByMessageId(
  messages: MessageRecord[],
  summary: SessionSummaryView | null | undefined,
): Map<string, AnchoredStewardProgress> {
  const result = new Map<string, AnchoredStewardProgress>();
  const ambiguousParents = new Set<string>();
  if (!summary?.session_id) return result;
  for (const child of summary.steward_children ?? []) {
    const turn = child.active_turn;
    const relation = child.relation;
    if (!turn || relation.child_session_id !== child.session_id) continue;

    const anchorIndex = messages.findIndex(
      (message) => message.id === relation.anchor_message_id,
    );
    if (anchorIndex < 0 || messages[anchorIndex]?.role !== "user") continue;
    if (messages[anchorIndex]?.chat_id !== summary.session_id) continue;

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
    if (parentIndex < 0) continue;

    let precedingUserId: string | undefined;
    for (let index = parentIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") {
        precedingUserId = message.id;
        break;
      }
    }
    if (precedingUserId !== relation.anchor_message_id) continue;

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
      rows: turn.progress.safe_progress_rows,
    });
  }
  return result;
}
