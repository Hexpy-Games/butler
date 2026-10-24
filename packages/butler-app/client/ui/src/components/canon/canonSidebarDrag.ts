import { create } from "zustand";
import { useSpaceDrag } from "@/app/space/drag.ts";
import type { EpicCard } from "@/app/canonApi.ts";
export const CANON_EPIC_MIME = "application/x-butler-canon-epic";
export const useCanonSidebarDrag = create<{
  source: { projectId: string; groupKey: string; epic: EpicCard } | null;
  start: (projectId: string, groupKey: string, epic: EpicCard) => void;
  end: () => void;
}>(set => ({
  source: null,
  start: (projectId, groupKey, epic) => {
    set({ source: { projectId, groupKey, epic } });
    useSpaceDrag.getState().start(`canon:${epic.id}`, `canon:${epic.id}`);
  },
  end: () => { set({ source: null }); useSpaceDrag.getState().end(); },
}));
