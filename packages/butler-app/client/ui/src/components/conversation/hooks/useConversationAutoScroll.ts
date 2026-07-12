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
  conversationBottomLockAfterScroll,
  conversationDistanceFromBottom,
  scrollConversationToBottom,
  type ScrollToBottomOptions,
} from "../conversationScrollUtils";

const USER_SCROLL_INTENT_WINDOW_MS = 250;
const POINTER_SCROLL_INTENT_DISTANCE_PX = 4;
const SCROLLBAR_POINTER_HIT_WIDTH_PX = 12;
const SCROLL_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

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
  const lastUserScrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const pointerScrollActiveRef = useRef(false);
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null);
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
    const markUserScrollIntent = () => {
      lastUserScrollIntentAtRef.current = window.performance.now();
    };
    const markPointerScrollIntent = (event: PointerEvent) => {
      pointerOriginRef.current = { x: event.clientX, y: event.clientY };
      const bounds = element.getBoundingClientRect();
      const scrollbarHitWidth = Math.max(
        element.offsetWidth - element.clientWidth,
        SCROLLBAR_POINTER_HIT_WIDTH_PX,
      );
      if (event.clientX >= bounds.right - scrollbarHitWidth) {
        pointerScrollActiveRef.current = true;
        markUserScrollIntent();
      }
    };
    const markPointerDragScrollIntent = (event: PointerEvent) => {
      const origin = pointerOriginRef.current;
      if (!origin) return;
      if (
        Math.abs(event.clientX - origin.x) <
          POINTER_SCROLL_INTENT_DISTANCE_PX &&
        Math.abs(event.clientY - origin.y) < POINTER_SCROLL_INTENT_DISTANCE_PX
      ) {
        return;
      }
      pointerScrollActiveRef.current = true;
      markUserScrollIntent();
    };
    const clearPointerScrollIntent = () => {
      pointerScrollActiveRef.current = false;
      pointerOriginRef.current = null;
    };
    const markKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (SCROLL_NAVIGATION_KEYS.has(event.key)) markUserScrollIntent();
    };
    const recentUserScrollIntent = () =>
      pointerScrollActiveRef.current ||
      window.performance.now() - lastUserScrollIntentAtRef.current <=
        USER_SCROLL_INTENT_WINDOW_MS;
    const updatePinnedState = () => {
      const distanceFromBottom = conversationDistanceFromBottom(element);
      const pinned =
        distanceFromBottom < BOTTOM_LOCK_THRESHOLD ||
        conversationBottomLockAfterScroll({
          wasPinned: pinnedToBottomRef.current,
          distanceFromBottom,
          userScrollIntent: recentUserScrollIntent(),
        });
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
    element.addEventListener("wheel", markUserScrollIntent, { passive: true });
    element.addEventListener("touchmove", markUserScrollIntent, {
      passive: true,
    });
    element.addEventListener("pointerdown", markPointerScrollIntent, {
      passive: true,
    });
    window.addEventListener("pointermove", markPointerDragScrollIntent, {
      passive: true,
    });
    window.addEventListener("pointerup", clearPointerScrollIntent);
    window.addEventListener("pointercancel", clearPointerScrollIntent);
    window.addEventListener("blur", clearPointerScrollIntent);
    window.addEventListener("keydown", markKeyboardScrollIntent);
    element.addEventListener("scroll", updatePinnedState, { passive: true });
    return () => {
      element.removeEventListener("wheel", markUserScrollIntent);
      element.removeEventListener("touchmove", markUserScrollIntent);
      element.removeEventListener("pointerdown", markPointerScrollIntent);
      window.removeEventListener("pointermove", markPointerDragScrollIntent);
      window.removeEventListener("pointerup", clearPointerScrollIntent);
      window.removeEventListener("pointercancel", clearPointerScrollIntent);
      window.removeEventListener("blur", clearPointerScrollIntent);
      window.removeEventListener("keydown", markKeyboardScrollIntent);
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
