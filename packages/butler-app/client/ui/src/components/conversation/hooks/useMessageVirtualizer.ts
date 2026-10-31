import { useCallback, useRef, useState, type RefObject } from "react";
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
  const measuredAtWidth = useRef(new Map<VirtualItem["key"], number>());
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) =>
    keepReaderOnRewrap(item, delta, instance, measuredAtWidth.current);

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
 * A row re-measured at another column width (the window, a pane beside the chat) rewrapped, now or when it scrolled back
 * into range, and the reader keeps their place. Above the reader, the scroll offset follows its whole change. Under
 * the top of the view, it follows the part above the reader's line, in proportion, as the text rewraps evenly. Any other
 * resize (streaming, a block opening) leaves the offset alone.
 */
function keepReaderOnRewrap(item: VirtualItem, delta: number, instance: Virtualizer<HTMLDivElement, Element>, measuredAtWidth: Map<VirtualItem["key"], number>) {
  const element = instance.scrollElement;
  if (!element) return false;
  const width = element.clientWidth, measured = measuredAtWidth.get(item.key);
  measuredAtWidth.set(item.key, width);
  if (measured === undefined || measured === width) return false;
  const offset = instance.scrollOffset ?? 0;
  if (item.end <= offset) return true;
  // After the rows above, whose adjustment sets the offset outright.
  if (item.start < offset) queueMicrotask(() => { element.scrollTop += delta * (offset - item.start) / item.size; });
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
