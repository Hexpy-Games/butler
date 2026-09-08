import { appCopy } from "@/app/copy.ts";
import { create } from "zustand";
import { api } from "../api";
import { useButlerStore } from "../store";
import type { SpaceCommand, SpaceMutationResult } from "../types";

type TreeIntent = SpaceCommand extends infer T
  ? T extends SpaceCommand
    ? Omit<T, "expectedRevision">
    : never
  : never;
export type SpaceIntent = TreeIntent | { action: "relocate"; sessionId: string; operationId: string; targetKey: string | null; position: "inside" | "before" | "after" };
export type SpaceDialog =
  | { kind: "create"; parentKey: string | null }
  | { kind: "rename"; groupId: string; title: string }
  | { kind: "move"; sourceKey: string }
  | { kind: "relocate"; sourceKey: string; targetKey: string | null; position: "inside" | "before" | "after"; operationId: string }
  | { kind: "favorites" }
  | null;

interface OrganizationUi {
  tab: "all" | "recent" | "running";
  collapsed: string[];
  dialog: SpaceDialog;
  pending: boolean;
  error: string | null;
  undoToken: string | null;
  undoRevision: number | null;
  revealPath: string[];
  reveal(key: string): void;
  setTab(tab: OrganizationUi["tab"]): void;
  setDialog(dialog: SpaceDialog): void;
  toggle(key: string): void;
  mutate(intent: SpaceIntent): Promise<boolean>;
}

export const useOrganization = create<OrganizationUi>((set, get) => ({
  tab: "all",
  collapsed: [],
  dialog: null,
  pending: false,
  error: null,
  undoToken: null,
  undoRevision: null,
  revealPath: [],
  reveal: (key) => {
    const nodes = new Map(
      useButlerStore
        .getState()
        .navigation.space.nodes.map((node) => [node.key, node]),
    );
    const path: string[] = [];
    let current = nodes.get(key);
    while (current) {
      path.push(current.key);
      current = current.parentKey ? nodes.get(current.parentKey) : undefined;
    }
    useButlerStore.getState().setLeftOpen(true);
    set((s) => ({
      tab: "all",
      revealPath: path,
      collapsed: s.collapsed.filter((id) => !path.includes(id)),
    }));
  },
  setTab: (tab) => set({ tab }),
  setDialog: (dialog) => set({ dialog, error: null }),
  toggle: (key) =>
    set((s) => ({
      collapsed: s.collapsed.includes(key)
        ? s.collapsed.filter((k) => k !== key)
        : [...s.collapsed, key],
    })),
  mutate: async (intent) => {
    if (get().pending) return false;
    set({ pending: true, error: null });
    const command = {
      ...intent,
      expectedRevision: useButlerStore.getState().navigation.space.revision,
    };
    const groupPath =
      "groupId" in intent
        ? `/space/groups/${encodeURIComponent(intent.groupId)}`
        : "";
    const paths = {
      create: "/space/groups",
      move: "/space/moves",
      group: "/space/group-sessions",
      undo: "/space/undo",
      pin: "/space/pins",
      rename: groupPath,
      dissolve: groupPath,
      relocate: "/space/relocations",
    };
    try {
      const result = await api<SpaceMutationResult>(paths[intent.action], {
        method:
          intent.action === "rename"
            ? "PATCH"
            : intent.action === "dissolve"
              ? "DELETE"
              : "POST",
        body: JSON.stringify(command),
      });
      const app = useButlerStore.getState();
      app.noteNavigationEvent();
      app.setNavigation({ ...app.navigation, space: result.space });
      await app.refreshNavigation();
      set({
        pending: false,
        dialog:
          intent.action === "group" && result.groupId
            ? { kind: "rename", groupId: result.groupId, title: appCopy.space.newGroup }
            : null,
        undoToken: result.undoToken ?? null,
        undoRevision: result.space.revision,
      });
      return true;
    } catch (error) {
      await useButlerStore.getState().refreshNavigation();
      set({
        pending: false,
        error:
          error instanceof Error
            ? error.message
            : appCopy.space.saveFailed,
      });
      return false;
    }
  },
}));
