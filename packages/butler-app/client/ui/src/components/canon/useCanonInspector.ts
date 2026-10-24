import { useButlerStore } from "@/app/store.ts";

/** Board selection belongs to the current app view and uses the shared inspector. */
export function useCanonInspector(projectId: string) {
  const selected = useButlerStore(state => state.rightOpen && state.view.kind === "project-dashboard"
    && state.view.projectId === projectId ? state.view.epicId ?? null : null);
  const select = (epicId: string | null) => {
    const state = useButlerStore.getState();
    if (state.view.kind !== "project-dashboard" || state.view.projectId !== projectId) return;
    if (!epicId) { state.setRightOpen(false); return; }
    state.setView({ ...state.view, epicId });
    state.setRightTab("epic");
    state.setRightOpen(true);
  };
  return { selected, select };
}
