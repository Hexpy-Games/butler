import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { movedAnnouncement, type TabStripLabels } from "./tabStripLabels";
import {
  chipKey, focusAfterClose, locateTab, moveTabByStep, nextFocusKey, stripItems, tabKey,
  type TabStripGroup, type TabStripItem, type TabStripMove, type TabStripNavKey,
} from "./tabStripModel";

const NAV_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "Home", "End"]);
/** The focusable element inside a registered slot (the tab or the chip). */
export const TAB_STRIP_STOP = "data-tab-strip-stop";

interface NavigationOptions {
  groups: readonly TabStripGroup[];
  activeTabId: string | null;
  labels: TabStripLabels;
  onClose: (tabId: string) => void;
  onMove?: (move: TabStripMove) => void;
  announce: (message: string) => void;
}

/** The roving tab stop: the focused item while focus is inside, else the active tab (or its folded chip). */
function restingKey(groups: readonly TabStripGroup[], items: readonly TabStripItem[], activeTabId: string | null) {
  const keys = new Set(items.map((item) => item.key));
  const at = activeTabId ? locateTab(groups, activeTabId) : null;
  if (at && keys.has(tabKey(at.tab.id))) return tabKey(at.tab.id);
  if (at && keys.has(chipKey(at.group.id))) return chipKey(at.group.id);
  return items[0]?.key ?? null;
}

/**
 * Roving focus for the strip (one tab stop): arrows move across chips and tabs and wrap, Home/End
 * jump, Delete/Backspace close the focused tab, Cmd/Ctrl+Shift+arrows move it. Focus follows the
 * tab through re-renders (a move remounts it inside its new group).
 */
export function useTabStripNavigation({ groups, activeTabId, labels, onClose, onMove, announce }: NavigationOptions) {
  const items = useMemo(() => stripItems(groups), [groups]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const pending = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const rovingKey = focusKey && items.some((item) => item.key === focusKey) ? focusKey : restingKey(groups, items, activeTabId);

  const register = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node) => (node ? nodes.current.set(key, node) : nodes.current.delete(key));
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  const focus = useCallback((key: string | null) => {
    const node = key ? nodes.current.get(key) : undefined;
    const stop = node?.querySelector<HTMLElement>(`[${TAB_STRIP_STOP}]`);
    if (!key || !stop) return false;
    stop.focus();
    setFocusKey(key);
    return true;
  }, []);

  useLayoutEffect(() => {
    if (pending.current && focus(pending.current)) pending.current = null;
  });

  const moveByKeyboard = (tabId: string, step: -1 | 1) => {
    const move = onMove ? moveTabByStep(groups, tabId, step) : null;
    if (!move || !onMove) return;
    const target = groups.find((group) => group.id === move.toGroupId);
    pending.current = target?.collapsed ? chipKey(move.toGroupId) : tabKey(tabId);
    onMove(move);
    announce(movedAnnouncement(groups, move, labels));
  };

  const onKeyDown = (item: TabStripItem) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.altKey) return;
    const modified = event.metaKey || event.ctrlKey;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (item.kind === "tab" && modified && event.shiftKey && horizontal) {
      event.preventDefault();
      moveByKeyboard(item.tabId, event.key === "ArrowLeft" ? -1 : 1);
    } else if (!modified && NAV_KEYS.has(event.key)) {
      event.preventDefault();
      focus(nextFocusKey(items, item.key, event.key as TabStripNavKey));
    } else if (item.kind === "tab" && !modified && (event.key === "Delete" || event.key === "Backspace")) {
      if (locateTab(groups, item.tabId)?.tab.closable === false) return;
      event.preventDefault();
      pending.current = focusAfterClose(items, item.key);
      onClose(item.tabId);
    }
  };

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusKey(null);
  };

  const node = useCallback((key: string) => nodes.current.get(key) ?? null, []);
  return { items, rovingKey, register, node, onKeyDown, onFocusItem: setFocusKey, onBlur };
}

export type TabStripNavigation = ReturnType<typeof useTabStripNavigation>;
