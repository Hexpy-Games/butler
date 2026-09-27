import { useCallback, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MessageRecord } from "@/app/types.ts";
import { MESSAGE_LIST_TOP_PADDING } from "../conversationUtils";

interface UseMessageVirtualizerOptions {
  visibleMessages: MessageRecord[];
  showTurnActivity: boolean;
  itemCount: number;
  bottomReserve: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  headerHeight?: number;
  /** Queued follow-ups listed after the messages and the activity row. */
  queuedKeys?: readonly string[];
}

export function useMessageVirtualizer({
  visibleMessages,
  showTurnActivity,
  itemCount,
  bottomReserve,
  scrollRef,
  headerHeight = 0,
  queuedKeys = NO_QUEUED_KEYS,
}: UseMessageVirtualizerOptions) {
  const queuedStart = visibleMessages.length + (showTurnActivity ? 1 : 0);
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef]);
  const getItemKey = useCallback(
    (index: number) =>
      index >= queuedStart
        ? `queued-${queuedKeys[index - queuedStart] ?? index}`
        : showTurnActivity && index === visibleMessages.length
        ? "active-turn-activity"
        : (visibleMessages[index]?.id ?? `message-${index}`),
    [queuedKeys, queuedStart, showTurnActivity, visibleMessages],
  );
  const estimateSize = useCallback(
    (index: number) =>
      index >= queuedStart
        ? QUEUED_ROW_ESTIMATE
        : estimateMessageRowSize(visibleMessages[index], {
          isActivity: showTurnActivity && index === visibleMessages.length,
        }),
    [queuedStart, showTurnActivity, visibleMessages],
  );

  const rowVirtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 8,
    paddingStart: headerHeight,
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange =
    keepScrollOffsetOnSizeChange;

  const virtualContentHeight = Math.max(headerHeight, rowVirtualizer.getTotalSize());
  const viewportHeight =
    rowVirtualizer.scrollRect?.height ?? scrollRef.current?.clientHeight ?? 0;
  const topOffset = Math.max(
    MESSAGE_LIST_TOP_PADDING,
    viewportHeight - virtualContentHeight - bottomReserve,
  );
  const virtualListHeight = Math.max(
    viewportHeight,
    virtualContentHeight + topOffset + bottomReserve,
  );
  const latestMessage = visibleMessages[visibleMessages.length - 1];
  const latestMessageVersion = latestMessage
    ? [
        latestMessage.id,
        latestMessage.cursor ?? "",
        latestMessage.status ?? "",
        latestMessage.text.length,
      ].join(":")
    : "empty";

  return {
    rowVirtualizer,
    topOffset,
    virtualListHeight,
    latestMessageVersion,
  };
}

const NO_QUEUED_KEYS: readonly string[] = [];
/** Status line, one-line bubble and controls row of a QueuedMessage. */
const QUEUED_ROW_ESTIMATE = 112;

function keepScrollOffsetOnSizeChange() {
  return false;
}

function estimateMessageRowSize(
  message: MessageRecord | undefined,
  { isActivity }: { isActivity: boolean },
): number {
  if (isActivity) return 112;
  if (!message) return 64;
  const textLength = message.text?.length ?? 0;
  const estimatedLines = Math.ceil(textLength / 52);
  if (message.role === "user") {
    return Math.max(72, Math.min(220, 42 + estimatedLines * 24));
  }
  if (message.role === "assistant") {
    return Math.max(140, Math.min(520, 96 + estimatedLines * 26));
  }
  return 58;
}
