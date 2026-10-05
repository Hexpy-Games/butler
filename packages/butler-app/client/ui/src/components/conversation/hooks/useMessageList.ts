import { useAppLocale } from "@/app/copy.ts";
import { useMemo } from "react";
import { useMessageCopy } from "./useMessageCopy";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import {
  activeTurnProgressSnapshot,
  collapseAssistantAttempts,
  isWorkerVisibleInComposer,
  shouldShowTurnActivity,
} from "@/app/utils.ts";
import { visibleProgressRows } from "@/app/conversation-progress";
import type {
  MessageRecord,
  SessionSummaryView,
  TurnProgressSnapshot,
  WorkerActivitySummary,
} from "@/app/types.ts";
import { buildAssistantFooterMetaById } from "../messageFooterMeta";
import { anchoredStewardProgressByMessageId } from "../stewardParentProgressProjection";

export function useMessageList(
  messages: MessageRecord[],
  summary: SessionSummaryView | null | undefined,
  turnProgress: Record<string, TurnProgressSnapshot>,
  isSending: boolean,
) {
  const copy = useMessageCopy();

  const visibleMessages = useMemo(
    () => collapseAssistantAttempts(messages),
    [messages],
  );

  const locale = useAppLocale();
  const assistantFooterMetaById = useMemo(
    () => buildAssistantFooterMetaById(visibleMessages, locale),
    [locale, visibleMessages],
  );

  const anchoredStewardProgress = useMemo(
    () => anchoredStewardProgressByMessageId(visibleMessages, summary),
    [summary, visibleMessages],
  );
  const workers = (summary?.worker_activity ?? []).filter(
    (worker): worker is WorkerActivitySummary =>
      Boolean(worker && isWorkerVisibleInComposer(worker)),
  );

  const activeSnapshot = useMemo(
    () => activeTurnProgressSnapshot(summary, turnProgress),
    [summary, turnProgress],
  );
  const activeTurn = Boolean(
    activeSnapshot ||
      (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)),
  );

  const progressRows = visibleProgressRows(
    activeSnapshot?.safe_progress_rows ??
    summary?.latest_progress?.safe_progress_rows ??
    [],
  );
  const timelineProgressRows = progressRows.filter((row) => row.kind !== "todo");
  const hasTodoProgress = progressRows.length !== timelineProgressRows.length;
  const turnState =
    activeSnapshot?.state ??
    summary?.latest_progress?.state ??
    summary?.turn_state ??
    undefined;

  const showTurnActivity = shouldShowTurnActivity({
    activeTurn,
    hasTodoProgress,
    isSending,
    timelineProgressRowCount: timelineProgressRows.length,
    turnState,
  });

  const turnId = activeSnapshot?.turn_id ?? summary?.latest_progress?.turn_id;
  const liveMessageId = showTurnActivity ? lastLiveMessageId(visibleMessages, turnId) : undefined;
  const separateTurnActivity = showTurnActivity && !liveMessageId;
  const itemCount = visibleMessages.length + (separateTurnActivity ? 1 : 0);

  return {
    visibleMessages,
    assistantFooterMetaById,
    workers,
    activeTurn,
    progressRows,
    turnState,
    turnStartedAt: activeSnapshot?.started_at,
    turnId,
    anchoredStewardProgress,
    showTurnActivity: separateTurnActivity,
    liveMessageId,
    itemCount,
    ...copy,
  };
}

function lastLiveMessageId(messages: MessageRecord[], turnId?: string): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && (turnId ? message.turn_id === turnId : message.status === "streaming")) return message.id;
  }
  return undefined;
}
