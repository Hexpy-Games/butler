import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const BOTTOM_LOCK_THRESHOLD = 120;
const USER_SCROLL_INPUT_WINDOW_MS = 180;
const PROGRAMMATIC_SCROLL_WINDOW_MS = 120;
const SCROLL_DRIFT_RESTORE_TOLERANCE = 2;

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
  const lastContentVersionRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const lastUserScrollInputAtRef = useRef(0);
  const lastKnownUnpinnedScrollTopRef = useRef<number | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const pointerScrollActiveRef = useRef(false);

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
    programmaticScrollUntilRef.current =
      window.performance.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
    element.scrollTop = Math.max(0, contentHeight - element.clientHeight);
    pinnedToBottomRef.current = true;
    lastKnownUnpinnedScrollTopRef.current = null;
  };

  const isPinnedToBottom = () => {
    const element = scrollRef.current;
    if (!element) return pinnedToBottomRef.current;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom < BOTTOM_LOCK_THRESHOLD;
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const markUserScrollInput = () => {
      lastUserScrollInputAtRef.current = window.performance.now();
    };
    const markPointerScrollInput = () => {
      pointerScrollActiveRef.current = true;
      markUserScrollInput();
    };
    const clearPointerScrollInput = () => {
      pointerScrollActiveRef.current = false;
    };
    const markKeyboardScrollInput = (event: KeyboardEvent) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "End",
          "Home",
          "PageDown",
          "PageUp",
          " ",
        ].includes(event.key)
      ) {
        markUserScrollInput();
      }
    };
    const updatePinnedState = () => {
      const now = window.performance.now();
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      const pinned = distanceFromBottom < BOTTOM_LOCK_THRESHOLD;
      pinnedToBottomRef.current = pinned;
      if (pinned) {
        lastKnownUnpinnedScrollTopRef.current = null;
        return;
      }
      cancelScheduledScrolls();
      const recentlyUserScrolled =
        pointerScrollActiveRef.current ||
        now - lastUserScrollInputAtRef.current < USER_SCROLL_INPUT_WINDOW_MS;
      const programmaticScroll = now < programmaticScrollUntilRef.current;
      const expectedScrollTop = lastKnownUnpinnedScrollTopRef.current;
      if (
        !recentlyUserScrolled &&
        !programmaticScroll &&
        expectedScrollTop !== null &&
        Math.abs(element.scrollTop - expectedScrollTop) >
          SCROLL_DRIFT_RESTORE_TOLERANCE
      ) {
        programmaticScrollUntilRef.current =
          now + PROGRAMMATIC_SCROLL_WINDOW_MS;
        element.scrollTop = expectedScrollTop;
        return;
      }
      lastKnownUnpinnedScrollTopRef.current = element.scrollTop;
    };
    updatePinnedState();
    element.addEventListener("wheel", markUserScrollInput, { passive: true });
    element.addEventListener("touchmove", markUserScrollInput, {
      passive: true,
    });
    element.addEventListener("pointerdown", markPointerScrollInput, {
      passive: true,
    });
    window.addEventListener("pointerup", clearPointerScrollInput);
    window.addEventListener("keydown", markKeyboardScrollInput);
    element.addEventListener("scroll", updatePinnedState, { passive: true });
    return () => {
      element.removeEventListener("wheel", markUserScrollInput);
      element.removeEventListener("touchmove", markUserScrollInput);
      element.removeEventListener("pointerdown", markPointerScrollInput);
      window.removeEventListener("pointerup", clearPointerScrollInput);
      window.removeEventListener("keydown", markKeyboardScrollInput);
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
    const contentVersion = [
      itemCount,
      latestMessageVersion,
      showTurnActivity ? "activity" : "messages",
    ].join(":");
    const contentChanged = lastContentVersionRef.current !== contentVersion;
    lastContentVersionRef.current = contentVersion;
    const currentlyPinned = isPinnedToBottom();
    const canFollowActiveContent = isSending || showTurnActivity;
    const shouldPin =
      enteringChat ||
      currentlyPinned ||
      (pinnedToBottomRef.current && contentChanged && canFollowActiveContent);
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
  ]);
}
