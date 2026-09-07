import { create } from "zustand";
import type { SpaceRowData } from "./projection";
export type DropPosition = "before" | "after" | "inside" | "group";
type DropTarget = {
  key: string | null;
  instance: string;
  position: DropPosition;
};
export const SESSION_REFERENCE_MIME = "application/x-butler-session-reference";
export const useSpaceDrag = create<{
  source: string | null;
  sourceInstance: string | null;
  target: DropTarget | null;
  start(source: string, instance: string): void;
  over(target: DropTarget | null): void;
  end(): void;
}>((set) => ({
  source: null,
  sourceInstance: null,
  target: null,
  start: (source, sourceInstance) =>
    set({ source, sourceInstance, target: null }),
  over: (target) => set({ target }),
  end: () => set({ source: null, sourceInstance: null, target: null }),
}));

/** Preview only. The transaction independently enforces scope and cycle invariants. */
export function canDrop(
  rows: Map<string, SpaceRowData>,
  sourceKey: string,
  targetKey: string | null,
  position: DropPosition,
): boolean {
  const source = rows.get(sourceKey);
  if (sourceKey === "s:general" || targetKey === "s:general") return false;
  const target = targetKey ? rows.get(targetKey) : undefined;
  if (!source || sourceKey === targetKey || (targetKey && !target))
    return false;
  if (position === "group")
    return Boolean(
      target &&
      source.node.kind === "session" &&
      target.node.kind === "session" &&
      source.node.scopeProjectId === target.node.scopeProjectId,
    );
  if (position === "inside" && target?.node.kind === "session") return false;
  const parentKey =
    position === "inside" ? targetKey : (target?.node.parentKey ?? null);
  const parent = parentKey ? rows.get(parentKey) : undefined;
  const scope =
    parent?.node.kind === "project"
      ? parent.node.entityId
      : (parent?.node.scopeProjectId ?? null);
  if (scope !== source.node.scopeProjectId && source.node.kind !== "session") return false;
  let ancestor = parent;
  while (ancestor) {
    if (ancestor.node.key === sourceKey) return false;
    ancestor = ancestor.node.parentKey
      ? rows.get(ancestor.node.parentKey)
      : undefined;
  }
  return true;
}
