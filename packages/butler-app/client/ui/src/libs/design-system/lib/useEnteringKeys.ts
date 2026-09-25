import { useRef } from "react";

/** How long a key keeps its entering flag (covers the enter animation). */
export const ENTER_WINDOW_MS = 600;

/**
 * Keys that appeared since the previous render of the same scope (for
 * example message ids of one chat). Keys present on the first render or
 * right after a scope change do not enter, so opening a chat or scrolling a
 * virtualized list never replays entrances; `enterOnScopeChange` can still
 * mark just-sent keys that arrive together with a new scope.
 */
export function useEnteringKeys(
  keys: readonly string[],
  scope: string,
  { enterOnScopeChange }: { enterOnScopeChange?: (key: string) => boolean } = {},
): Set<string> {
  const state = useRef<{ scope: string | null; seen: Set<string>; enteredAt: Map<string, number> }>({
    scope: null,
    seen: new Set(),
    enteredAt: new Map(),
  });
  const now = Date.now();
  const current = state.current;
  if (current.scope !== scope) {
    const firstRender = current.scope === null;
    current.scope = scope;
    current.seen = new Set(keys);
    current.enteredAt = new Map();
    if (!firstRender && enterOnScopeChange) {
      for (const key of keys) if (enterOnScopeChange(key)) current.enteredAt.set(key, now);
    }
  } else {
    for (const key of keys) {
      if (current.seen.has(key)) continue;
      current.seen.add(key);
      current.enteredAt.set(key, now);
    }
  }
  const entering = new Set<string>();
  for (const [key, at] of current.enteredAt) {
    if (now - at <= ENTER_WINDOW_MS) entering.add(key);
    else current.enteredAt.delete(key);
  }
  return entering;
}
