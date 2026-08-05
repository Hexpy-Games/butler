import { useEffect, useMemo, useRef, useState } from "react";

export const SIDEBAR_SESSION_PAGE_SIZE = 5;

interface IdentifiedSession {
  id: string;
}

export function useSidebarSessionPaging<T extends IdentifiedSession>(
  sessions: readonly T[],
  activeSessionId?: string | null,
) {
  const [visibleCount, setVisibleCount] = useState(
    SIDEBAR_SESSION_PAGE_SIZE,
  );
  const previouslyVisibleIds = useRef<Set<string>>(new Set());

  const effectiveVisibleCount = useMemo(() => {
    const activeIndex = activeSessionId
      ? sessions.findIndex((session) => session.id === activeSessionId)
      : -1;
    const activeWasVisible =
      activeSessionId !== null &&
      activeSessionId !== undefined &&
      previouslyVisibleIds.current.has(activeSessionId);

    if (activeWasVisible && activeIndex >= visibleCount) {
      return activeIndex + 1;
    }
    return visibleCount;
  }, [activeSessionId, sessions, visibleCount]);

  const visibleSessions = sessions.slice(0, effectiveVisibleCount);
  const remainingCount = Math.max(0, sessions.length - effectiveVisibleCount);

  useEffect(() => {
    previouslyVisibleIds.current = new Set(
      visibleSessions.map((session) => session.id),
    );
  }, [visibleSessions]);

  function showMore() {
    setVisibleCount((count) =>
      Math.max(count, effectiveVisibleCount) + SIDEBAR_SESSION_PAGE_SIZE,
    );
  }

  return {
    visibleSessions,
    remainingCount,
    showMore,
  };
}
