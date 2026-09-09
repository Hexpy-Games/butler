import { useLayoutEffect, useState } from "react";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";

/** Restore only view state; asynchronous content can grow before reaching the saved offset. */
export function useProjectDashboardScroll(projectId: string | undefined, tab: string) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!element || !projectId) return;
    const state = useProjectDashboardState.getState();
    let position = state.projects[projectId]?.scrollPositions?.[tab] ?? 0;
    let restoring = true;
    const restore = () => {
      if (!restoring) return;
      element.scrollTop = position;
      if (Math.abs(element.scrollTop - position) < 1) restoring = false;
    };
    const remember = () => { if (!restoring) position = element.scrollTop; };
    const takeControl = () => { restoring = false; position = element.scrollTop; };
    restore();
    const observer = new ResizeObserver(restore);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", remember, { passive: true });
    element.addEventListener("wheel", takeControl, { passive: true });
    element.addEventListener("touchstart", takeControl, { passive: true });
    element.addEventListener("pointerdown", takeControl, { passive: true });
    element.addEventListener("keydown", takeControl);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", remember);
      element.removeEventListener("wheel", takeControl);
      element.removeEventListener("touchstart", takeControl);
      element.removeEventListener("pointerdown", takeControl);
      element.removeEventListener("keydown", takeControl);
      const current = useProjectDashboardState.getState();
      current.update(projectId, { scrollPositions: { ...current.projects[projectId]?.scrollPositions, [tab]: position } });
    };
  }, [element, projectId, tab]);
  return setElement;
}
