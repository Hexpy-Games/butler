import { create } from "zustand";

/**
 * SCRATCH PROTOTYPE (research/canon-detail-layout): where the 과제 detail opens
 * and how the dashboard sits on the wallpaper. Switch with a URL param or a
 * localStorage key, read once at load:
 *   ?canonDetail=panel|inspector|push   localStorage "butler:canon-detail-layout"
 *   ?canonSurface=glass|flat            localStorage "butler:canon-surface"
 */
export type CanonDetailLayout = "panel" | "inspector" | "push";
export type CanonSurface = "glass" | "flat";

function readFlag<T extends string>(param: string, key: string, values: readonly T[], fallback: T): T {
  try {
    const value = new URLSearchParams(window.location.search).get(param) ?? window.localStorage.getItem(key);
    return values.includes(value as T) ? value as T : fallback;
  } catch { return fallback; }
}

export const canonDetailLayout: CanonDetailLayout = readFlag("canonDetail", "butler:canon-detail-layout", ["panel", "inspector", "push"], "panel");
export const canonSurface: CanonSurface = readFlag("canonSurface", "butler:canon-surface", ["glass", "flat"], "glass");

/** `via`: the inspector, or the push column (desktop push layout only; phones use the inspector). */
export type CanonDetailTarget = { projectId: string; epicId: string; via: "inspector" | "push" };
interface CanonDetailSelection {
  target: CanonDetailTarget | null;
  open: (target: CanonDetailTarget | null) => void;
}
/** The 과제 the dashboard shows outside the board (inspector or push column). */
export const useCanonDetailSelection = create<CanonDetailSelection>(set => ({
  target: null,
  open: target => set({ target }),
}));

/** The dashboard's inspector 과제, while the dashboard of its project is showing. */
export function dashboardInspectorTarget(view: { kind: string; projectId?: string }, target = useCanonDetailSelection.getState().target): CanonDetailTarget | null {
  if (canonDetailLayout === "panel" || view.kind !== "project-dashboard") return null;
  return target?.via === "inspector" && target.projectId === view.projectId ? target : null;
}
