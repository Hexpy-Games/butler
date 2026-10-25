import { leaveCanonEditor } from "@/app/canonEditGuard.ts";
import { useButlerStore } from "@/app/store.ts";

/** Board selection belongs to the current app view and uses the ManagementPage aside. */
export function useCanonSelection(projectId: string) {
  const selected = useButlerStore(state => state.view.kind === "project-dashboard"
    && state.view.projectId === projectId ? state.view.epicId ?? null : null);
  const select = async (epicId: string | null) => {
    if (!await leaveCanonEditor()) return;
    const state = useButlerStore.getState();
    if (state.view.kind !== "project-dashboard" || state.view.projectId !== projectId) return;
    state.setView({ ...state.view, epicId: epicId === selected ? undefined : epicId ?? undefined });
  };
  return { selected, select };
}
