import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { observeElementRect, useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
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
        : (visibleMessages[index]?.role === "assistant" && visibleMessages[index]?.turn_id
          ? `answer-${visibleMessages[index].turn_id}:${index}` : visibleMessages[index]?.id ?? `message-${index}`),
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

  const { viewportHeight: measuredViewportHeight, observeViewportRect } = useMessageViewport();
  const rowVirtualizer = useVirtualizer({
    observeElementRect: observeViewportRect,
    count: itemCount,
    getScrollElement,
    getItemKey,
    estimateSize,
    overscan: 8,
    paddingStart: headerHeight,
  });
  const keepLine = useKeepMiddleLine(rowVirtualizer, scrollRef);
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = keepLine;

  const virtualContentHeight = Math.max(headerHeight, rowVirtualizer.getTotalSize());
  const viewportHeight =
    measuredViewportHeight ?? rowVirtualizer.scrollRect?.height ?? scrollRef.current?.clientHeight ?? 0;
  const naturalTopOffset = Math.max(
    MESSAGE_LIST_TOP_PADDING,
    viewportHeight - virtualContentHeight - bottomReserve,
  );
  const topOffset = naturalTopOffset;
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

/**
 * Rows above the reader change height when the column's width changes (the window, a pane beside the chat): they rewrap,
 * then or when they scroll back into range. The line in the middle of the view stays there: it is noted as a place in its
 * row, in proportion, as text rewraps evenly, and put back after each commit with the new heights. Any other resize
 * (streaming, a block opening) leaves the scroll offset alone.
 */
function useKeepMiddleLine(rowVirtualizer: Virtualizer<HTMLDivElement, Element>, scrollRef: RefObject<HTMLDivElement | null>) {
  const measuredAtWidth = useRef(new Map<VirtualItem["key"], number>());
  const line = useRef<{ key: VirtualItem["key"]; place: number } | null>(null);
  const rewrapped = useRef(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !line.current) return;
    if (!rewrapped.current) { line.current = null; return; }
    rewrapped.current = false;
    const key = line.current.key, row = rowVirtualizer.measurementsCache.find((item) => item.key === key);
    if (row) element.scrollTop = row.start + line.current.place * row.size - element.clientHeight / 2;
  });
  return (item: VirtualItem, _delta: number, instance: Virtualizer<HTMLDivElement, Element>) => {
    const element = instance.scrollElement;
    if (!element) return false;
    const width = element.clientWidth, measured = measuredAtWidth.current.get(item.key);
    measuredAtWidth.current.set(item.key, width);
    const middle = element.scrollTop + element.clientHeight / 2;
    if (measured === width || item.start >= middle) return false;
    rewrapped.current = true;
    if (!line.current) {
      const row = instance.getVirtualItemForOffset(middle);
      if (row) line.current = { key: row.key, place: (middle - row.start) / row.size };
    }
    return false;
  };
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

function useMessageViewport() {
  const [viewportHeight, setViewportHeight] = useState<number>();
  const observeViewportRect = useCallback<typeof observeElementRect<HTMLDivElement>>(
    (instance, callback) => observeElementRect(instance, (rect) => {
      callback(rect);
      // Height changes must render even when the virtual range stays the same.
      setViewportHeight(rect.height);
    }),
    [],
  );
  return { viewportHeight, observeViewportRect };
}
