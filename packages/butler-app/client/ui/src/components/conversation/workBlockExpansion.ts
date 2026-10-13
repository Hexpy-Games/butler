import { useCallback, useSyncExternalStore } from "react";

// Per-block "Show details" state for this App run. It lives outside React so a
// block keeps its state when the virtualized message list unmounts and
// remounts it; nothing is persisted across restarts.
const expanded = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toggle(id: string): void {
  if (!expanded.delete(id)) expanded.add(id);
  for (const listener of listeners) listener();
}

export function useWorkBlockExpanded(id: string): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => expanded.has(id));
  return [open, useCallback(() => toggle(id), [id])];
}
