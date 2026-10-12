import { useCallback } from "react";

/** Distance from the end that still counts as "reading the latest". */
const FOLLOW_SLACK_PX = 24;
/** A scroll this soon after wheel, touch, key or pointer input is the user's. */
const USER_INTENT_WINDOW_MS = 300;
const INTENT_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * Callback ref for a bounded scroller that tails its newest content while
 * `live`. It only moves this scroller's own scrollTop (never scrollIntoView,
 * so the conversation never moves). Only a user's own scroll away from the
 * end stops following (layout and image loads never do); scrolling back to
 * the end resumes it.
 */
export function useFollowLatest(live: boolean) {
  return useCallback((scroller: HTMLDivElement | null) => {
    if (!scroller || !live) return undefined;
    let pinned = true;
    let intentAt = Number.NEGATIVE_INFINITY;
    const toEnd = () => {
      if (pinned) scroller.scrollTop = scroller.scrollHeight;
    };
    const onIntent = () => {
      intentAt = performance.now();
    };
    const onScroll = () => {
      if (performance.now() - intentAt > USER_INTENT_WINDOW_MS) return;
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_SLACK_PX;
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(toEnd);
    if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
    observer?.observe(scroller);
    for (const type of INTENT_EVENTS) scroller.addEventListener(type, onIntent, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    toEnd();
    return () => {
      observer?.disconnect();
      for (const type of INTENT_EVENTS) scroller.removeEventListener(type, onIntent);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [live]);
}
