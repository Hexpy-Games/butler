import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";
import {
  BOTTOM_LOCK_THRESHOLD,
  conversationDistanceFromBottom,
  scrollConversationToBottom,
  type ScrollToBottomOptions,
} from "../conversationScrollUtils";

interface UseConversationAutoScrollOptions {
  activeChatId: string;
  itemCount: number;
  latestMessageVersion: string;
  virtualListHeight: number;
  isSending: boolean;
  showTurnActivity: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export interface ConversationScrollState {
  isAwayFromBottom: boolean;
  hasUnreadMessages: boolean;
  scrollToBottom: (options?: ScrollToBottomOptions) => void;
}

export function useConversationAutoScroll({
  activeChatId,
  latestMessageVersion,
  virtualListHeight,
  itemCount,
  isSending,
  showTurnActivity,
  scrollRef,
}: UseConversationAutoScrollOptions): ConversationScrollState {
  const pinnedToBottomRef = useRef(true);
  const lastAutoScrolledChatRef = useRef<string | null>(null);
  const latestSeenMessageVersionRef = useRef(latestMessageVersion);
  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);

  const cancelScheduledScroll = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const cancelSettledScroll = useCallback(() => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  }, []);

  const cancelScheduledScrolls = useCallback(() => {
    cancelScheduledScroll();
    cancelSettledScroll();
  }, [cancelScheduledScroll, cancelSettledScroll]);

  const scrollToBottom = useCallback(
    (options?: ScrollToBottomOptions) => {
      const element = scrollRef.current;
      if (!element) return;
      scrollConversationToBottom(element, virtualListHeight, options);
      pinnedToBottomRef.current = true;
      latestSeenMessageVersionRef.current = latestMessageVersion;
      setIsAwayFromBottom(false);
      setHasUnreadMessages(false);
    },
    [latestMessageVersion, scrollRef, virtualListHeight],
  );

  useEffect(() => {
    latestSeenMessageVersionRef.current = latestMessageVersion;
    pinnedToBottomRef.current = true;
    setIsAwayFromBottom(false);
    setHasUnreadMessages(false);
  }, [activeChatId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updatePinnedState = () => {
      const distanceFromBottom = conversationDistanceFromBottom(element);
      const pinned = distanceFromBottom < BOTTOM_LOCK_THRESHOLD;
      pinnedToBottomRef.current = pinned;
      setIsAwayFromBottom(!pinned);
      if (pinned) {
        latestSeenMessageVersionRef.current = latestMessageVersion;
        setHasUnreadMessages(false);
      } else {
        cancelScheduledScrolls();
      }
    };
    updatePinnedState();
    element.addEventListener("scroll", updatePinnedState, { passive: true });
    return () => {
      element.removeEventListener("scroll", updatePinnedState);
      cancelScheduledScrolls();
    };
  }, [cancelScheduledScrolls, latestMessageVersion, scrollRef]);

  useEffect(() => {
    if (itemCount <= 0) return;
    if (pinnedToBottomRef.current) {
      latestSeenMessageVersionRef.current = latestMessageVersion;
      setHasUnreadMessages(false);
      return;
    }
    if (latestSeenMessageVersionRef.current !== latestMessageVersion) {
      setIsAwayFromBottom(true);
      setHasUnreadMessages(true);
    }
  }, [itemCount, latestMessageVersion]);

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
    settleTimerRef.current = window.setTimeout(
      () => {
        settleTimerRef.current = null;
        if (pinnedToBottomRef.current) scrollToBottom();
      },
      enteringChat ? 120 : 48,
    );
  }, [
    activeChatId,
    isSending,
    itemCount,
    latestMessageVersion,
    scrollToBottom,
    scrollRef,
    showTurnActivity,
    virtualListHeight,
    cancelScheduledScrolls,
  ]);

  return {
    isAwayFromBottom,
    hasUnreadMessages,
    scrollToBottom,
  };
}
