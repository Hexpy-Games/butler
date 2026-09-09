import { create } from "zustand";
import type { DropPosition } from "@/app/prototypes/sidebar-space/tree-move";

type Target = {
  id: string | null;
  instance: string;
  position: DropPosition;
} | null;
export const useTreeDrag = create<{
  dragged: string | null;
  sourceInstance: string | null;
  target: Target;
  start: (id: string, instance: string) => void;
  over: (target: Target) => void;
  end: () => void;
}>((set) => ({
  dragged: null,
  sourceInstance: null,
  target: null,
  start: (dragged, sourceInstance) =>
    set({ dragged, sourceInstance, target: null }),
  over: (target) => set({ target }),
  end: () => set({ dragged: null, sourceInstance: null, target: null }),
}));
