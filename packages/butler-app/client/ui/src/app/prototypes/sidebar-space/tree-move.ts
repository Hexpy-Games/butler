import type { SpaceItem } from "./sample-data";
export type DropPosition = "before" | "inside" | "after" | "group";

function projectOf(items: SpaceItem[], item: SpaceItem): string | null {
  let parent = items.find((row) => row.id === item.parent);
  while (parent) {
    if (parent.kind === "project") return parent.id;
    parent = items.find((row) => row.id === parent?.parent);
  }
  return null;
}

export function canGroupSessions(
  items: SpaceItem[],
  id: string,
  targetId: string | null,
): boolean {
  const source = items.find((row) => row.id === id);
  const target = items.find((row) => row.id === targetId);
  return Boolean(
    source &&
    target &&
    source.id !== target.id &&
    source.kind === "session" &&
    target.kind === "session" &&
    projectOf(items, source) === projectOf(items, target),
  );
}

export function groupSessions(
  items: SpaceItem[],
  id: string,
  targetId: string,
  groupId: string,
): SpaceItem[] | null {
  if (!canGroupSessions(items, id, targetId)) return null;
  const source = items.find((row) => row.id === id)!;
  const target = items.find((row) => row.id === targetId)!;
  return items.flatMap((row) => {
    if (row.id === id) return [];
    if (row.id !== targetId) return [row];
    return [
      {
        id: groupId,
        title: "새 그룹",
        kind: "group" as const,
        parent: target.parent,
      },
      { ...target, parent: groupId },
      { ...source, parent: groupId },
    ];
  });
}

function contains(
  items: SpaceItem[],
  ancestor: string,
  id: string | null,
): boolean {
  let current = items.find((item) => item.id === id);
  while (current) {
    if (current.id === ancestor) return true;
    current = items.find((item) => item.id === current?.parent);
  }
  return false;
}

export function moveTreeItem(
  items: SpaceItem[],
  id: string,
  targetId: string | null,
  position: DropPosition,
): SpaceItem[] | null {
  if (position === "group") return null;
  const item = items.find((row) => row.id === id);
  const target = items.find((row) => row.id === targetId);
  if (!item || id === targetId || (targetId && !target)) return null;
  if (position === "inside" && target?.kind === "session") return null;
  const parent = position === "inside" ? targetId : (target?.parent ?? null);
  if (contains(items, id, parent)) return null;
  const projectParent = items.some(
    (row) => row.kind === "project" && contains(items, row.id, parent),
  );
  const movesProject = items.some(
    (row) => row.kind === "project" && contains(items, id, row.id),
  );
  if (projectParent && movesProject) return null;
  const next = items.filter((row) => row.id !== id);
  const index =
    target && position !== "inside"
      ? next.findIndex((row) => row.id === targetId) +
        (position === "after" ? 1 : 0)
      : next.length;
  next.splice(index, 0, { ...item, parent });
  return next;
}
