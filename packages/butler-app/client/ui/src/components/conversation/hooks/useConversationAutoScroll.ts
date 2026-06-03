import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const BOTTOM_LOCK_THRESHOLD = 120;

interface UseConversationAutoScrollOptions {
  activeChatId: string;
  itemCount: number;
  latestMessageVersion: string;
  virtualListHeight: number;
  isSending: boolean;
  showTurnActivity: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function useConversationAutoScroll({
  activeChatId,
  latestMessageVersion,
  virtualListHeight,
  itemCount,
  isSending,
  showTurnActivity,
  scrollRef,
}: UseConversationAutoScrollOptions) {
  const pinnedToBottomRef = useRef(true);
  const lastAutoScrolledChatRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const cancelScheduledScroll = () => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };

  const cancelSettledScroll = () => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  };

  const cancelScheduledScrolls = () => {
    cancelScheduledScroll();
    cancelSettledScroll();
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    const contentHeight = Math.max(element.scrollHeight, virtualListHeight);
    element.scrollTop = Math.max(0, contentHeight - element.clientHeight);
    pinnedToBottomRef.current = true;
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updatePinnedState = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottomRef.current = distanceFromBottom < BOTTOM_LOCK_THRESHOLD;
      if (!pinnedToBottomRef.current) cancelScheduledScrolls();
    };
    updatePinnedState();
    element.addEventListener("scroll", updatePinnedState, { passive: true });
    return () => {
      element.removeEventListener("scroll", updatePinnedState);
      cancelScheduledScrolls();
    };
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (itemCount <= 0) return;
    const enteringChat = lastAutoScrolledChatRef.current !== activeChatId;
    if (enteringChat) {
      lastAutoScrolledChatRef.current = activeChatId;
      pinnedToBottomRef.current = true;
    }
    const shouldPin = enteringChat || pinnedToBottomRef.current;
    pinnedToBottomRef.current = shouldPin;
    if (!shouldPin) return;
    cancelScheduledScrolls();
    scrollToBottom();
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      if (pinnedToBottomRef.current) {
        scrollToBottom();
      }
      if (enteringChat) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          if (pinnedToBottomRef.current) scrollToBottom();
        });
      }
    });
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (pinnedToBottomRef.current) scrollToBottom();
    }, enteringChat ? 120 : 48);
  }, [
    activeChatId,
    isSending,
    itemCount,
    latestMessageVersion,
    scrollRef,
    showTurnActivity,
    virtualListHeight,
  ]);
}
