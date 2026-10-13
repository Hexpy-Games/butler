import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useEnteringKeys } from "../../lib/useEnteringKeys";

/** `enter` plays the card's entrance, `leave` its exit (then it unmounts), `rest` neither. */
export type TabRailPhase = "enter" | "rest" | "leave";

export interface TabRailPresenceItem<T> {
  tab: T;
  phase: TabRailPhase;
}

/**
 * The rail's cards with their motion phase. A tab that appears enters; a tab
 * that goes away stays where it was, marked `leave`, until `settle(id)` (its
 * exit ended). Tabs present when `view` changes neither enter nor leave, and
 * under reduced motion nothing does: cards come and go at once.
 */
export function useTabRailPresence<T extends { id: string }>(tabs: readonly T[], view: string, reduced: boolean): {
  items: TabRailPresenceItem<T>[];
  settle: (id: string) => void;
} {
  const entering = useEnteringKeys(tabs.map((tab) => tab.id), view);
  const [leaving, setLeaving] = useState<ReadonlyArray<{ tab: T; index: number }>>([]);
  const previous = useRef<{ view: string; tabs: readonly T[] }>({ view, tabs });

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { view, tabs };
    const ids = new Set(tabs.map((tab) => tab.id));
    if (reduced || before.view !== view) {
      setLeaving((current) => (current.length ? [] : current));
      return;
    }
    const gone = before.tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => !ids.has(tab.id));
    setLeaving((current) => {
      const kept = current.filter((entry) => !ids.has(entry.tab.id));
      const added = gone.filter((entry) => !kept.some((held) => held.tab.id === entry.tab.id));
      return added.length || kept.length !== current.length ? [...kept, ...added] : current;
    });
  }, [tabs, view, reduced]);

  const settle = useCallback((id: string) => setLeaving((current) => current.filter((entry) => entry.tab.id !== id)), []);
  const items: TabRailPresenceItem<T>[] = tabs.map((tab) => ({ tab, phase: !reduced && entering.has(tab.id) ? "enter" : "rest" }));
  for (const { tab, index } of leaving) {
    if (!items.some((item) => item.tab.id === tab.id)) items.splice(Math.min(index, items.length), 0, { tab, phase: "leave" });
  }
  return { items, settle };
}
