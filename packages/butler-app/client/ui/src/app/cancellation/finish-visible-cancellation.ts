import type {
  MessageRecord,
  SessionSummaryView,
  SessionView,
  TurnProgressSnapshot,
} from "../types.ts";
import { freezeMessageWorkBlocks } from "../utils.ts";

export interface VisibleCancellationState {
  messages: MessageRecord[];
  turnProgress: Record<string, TurnProgressSnapshot>;
  sessionView: SessionView | null;
  summary: SessionSummaryView | null;
}

export function finishVisibleCancellation(
  state: VisibleCancellationState,
  sessionId: string,
  turnId: string,
): VisibleCancellationState {
  const sourceProgress =
    state.turnProgress[turnId] ?? state.sessionView?.latest_turn?.progress;
  const progress: TurnProgressSnapshot = {
    ...(sourceProgress ?? {}),
    turn_id: turnId,
    state: "cancelled",
    safe_progress_rows: sourceProgress?.safe_progress_rows ?? [],
  };
  const turnProgress = { ...state.turnProgress, [turnId]: progress };
  const messages = freezeMessageWorkBlocks(state.messages, turnProgress);
  const currentView = state.sessionView;
  const latestTurn = currentView?.latest_turn?.id === turnId
    ? {
        ...currentView.latest_turn,
        state: "cancelled" as const,
        delivery_state: "cancelled" as const,
        cancellable: false,
        retryable: false,
        progress,
      }
    : currentView?.latest_turn ?? null;
  const sessionView = currentView?.session_id === sessionId
    ? {
        ...currentView,
        status: "cancelled" as const,
        active_turn: null,
        latest_turn: latestTurn,
        messages,
      }
    : currentView;
  const summary = state.summary?.session_id === sessionId
    ? {
        ...state.summary,
        turn_state: "cancelled" as const,
        latest_progress: progress,
      }
    : state.summary;
  return { messages, turnProgress, sessionView, summary };
}
