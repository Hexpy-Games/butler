import { useRef, useLayoutEffect, useState } from "react";
import { useMessageNavigation } from "@/app/messageNavigation";
import type { MessageRecord, SessionSummaryView } from "@/app/types";
import { useMessageVirtualizer } from "./useMessageVirtualizer";
import { useConversationAutoScroll } from "./useConversationAutoScroll";

export function useMessageListLayout({ visibleMessages, showTurnActivity, itemCount,
  bottomReserve, activeChatId, isSending, queuedKeys, branchSeed }: {
  visibleMessages: MessageRecord[];
  showTurnActivity: boolean;
  itemCount: number;
  bottomReserve: number;
  activeChatId: string;
  isSending: boolean;
  queuedKeys: readonly string[];
  branchSeed: SessionSummaryView["branch_seed"];
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const seedRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const target = useMessageNavigation(state => state.target);
  useLayoutEffect(() => {
    const node = seedRef.current;
    if (!node) { setHeaderHeight(0); return; }
    const measure = () => setHeaderHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [branchSeed]);

  const { rowVirtualizer, topOffset, virtualListHeight, latestMessageVersion } =
    useMessageVirtualizer({
      visibleMessages,
      showTurnActivity,
      itemCount,
      bottomReserve,
      scrollRef: parentRef,
      headerHeight,
      queuedKeys,
    });

  const scrollState = useConversationAutoScroll({
    activeChatId,
    latestMessageVersion,
    itemCount,
    virtualListHeight,
    isSending,
    showTurnActivity,
    scrollRef: parentRef,
  });
  useLayoutEffect(() => {
    if (target?.sessionId !== activeChatId) return;
    const index = visibleMessages.findIndex(message => message.id === target.messageId);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      scrollState.releaseBottomLock();
      const offset = rowVirtualizer.getOffsetForIndex(index, "start");
      rowVirtualizer.scrollToOffset((offset?.[0] ?? 0) + topOffset);
      useMessageNavigation.setState({ target: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, activeChatId, visibleMessages, rowVirtualizer, scrollState.releaseBottomLock, topOffset]);
  return { parentRef, seedRef, rowVirtualizer, topOffset, virtualListHeight, scrollState };
}
