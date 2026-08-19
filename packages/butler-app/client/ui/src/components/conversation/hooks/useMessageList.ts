import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError } from "@/app/notifications.ts";
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

export function useMessageList(
  messages: MessageRecord[],
  summary: SessionSummaryView | null | undefined,
  turnProgress: Record<string, TurnProgressSnapshot>,
  isSending: boolean,
) {
  const copyResetRef = useRef<number | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const visibleMessages = useMemo(
    () => collapseAssistantAttempts(messages),
    [messages],
  );

  const assistantFooterMetaById = useMemo(
    () => buildAssistantFooterMetaById(visibleMessages),
    [visibleMessages],
  );

  const workers = (summary?.worker_activity ?? []).filter(
    (worker): worker is WorkerActivitySummary =>
      Boolean(worker && isWorkerVisibleInComposer(worker)),
  );

  const activeSnapshot = useMemo(
    () => activeTurnProgressSnapshot(summary, turnProgress),
    [summary, turnProgress],
  );
  const stewardChild = summary?.steward_children?.find(
    (child) => child.active_turn,
  );
  const stewardProgress = stewardChild?.active_turn?.progress;
  const projectedSnapshot = stewardProgress ?? activeSnapshot;
  const activeTurn = Boolean(
    projectedSnapshot ||
      stewardChild?.active_turn ||
      (summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)),
  );

  const progressRows = visibleProgressRows(
    projectedSnapshot?.safe_progress_rows ??
    summary?.latest_progress?.safe_progress_rows ??
    [],
  );
  const timelineProgressRows = progressRows.filter((row) => row.kind !== "todo");
  const hasTodoProgress = progressRows.length !== timelineProgressRows.length;
  const turnState =
    projectedSnapshot?.state ??
    summary?.latest_progress?.state ??
    summary?.turn_state ??
    stewardChild?.active_turn?.state;

  const showTurnActivity = shouldShowTurnActivity({
    activeTurn,
    hasTodoProgress,
    isSending,
    timelineProgressRowCount: timelineProgressRows.length,
    turnState,
  });

  const itemCount = visibleMessages.length + (showTurnActivity ? 1 : 0);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    };
  }, []);

  const copyAssistantMessage = useCallback(async (message: MessageRecord) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(
        () => setCopiedMessageId(null),
        2000,
      );
    } catch (error) {
      notifyError(error, "Copy failed", { id: `copy-${message.id}` });
    }
  }, []);

  const copyContextMenuText = useCallback(async (message: MessageRecord) => {
    try {
      const selectedText = window.getSelection()?.toString();
      const textToCopy = selectedText || message.text;
      await navigator.clipboard.writeText(textToCopy);
    } catch (error) {
      notifyError(error, "Copy failed", { id: `copy-context-${message.id}` });
    }
  }, []);

  return {
    visibleMessages,
    assistantFooterMetaById,
    workers,
    activeTurn,
    progressRows,
    turnState,
    turnStartedAt:
      projectedSnapshot?.started_at ?? stewardChild?.active_turn?.created_at,
    turnId:
      projectedSnapshot?.turn_id ??
      stewardChild?.active_turn?.id ??
      summary?.latest_progress?.turn_id,
    showTurnActivity,
    itemCount,
    copiedMessageId,
    copyAssistantMessage,
    copyContextMenuText,
  };
}
