import { Children, isValidElement, useEffect, useReducer, useRef, type Key, type ReactElement, type ReactNode } from "react";
import { Collapsible } from "./Collapsible";

export interface CollapsibleListProps {
  /** Keyed rows. */
  children: ReactNode;
  /**
   * What the rows belong to (a tab, a folder). A scope change swaps the rows
   * without insert or remove motion.
   */
  scope?: string;
}

type Row = { key: Key; element: ReactElement };

/**
 * Keyed rows that reveal when inserted and fold away when removed (height +
 * fade through Collapsible). Rows present on the first render, the first
 * rows after an empty list and rows after a scope change do not animate, so
 * opening the app, loading data or switching tabs never replays motion.
 */
export function CollapsibleList({ children, scope = "" }: CollapsibleListProps) {
  const rows: Row[] = Children.toArray(children)
    .filter(isValidElement)
    .map((element) => ({ key: element.key ?? "", element }));
  const state = useRef<{ scope: string | null; keys: Set<Key>; last: Row[]; exiting: Map<Key, { row: Row; index: number; closing: boolean }> }>({
    scope: null, keys: new Set(), last: [], exiting: new Map(),
  });
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const current = state.current;
  const quiet = current.scope !== scope || current.keys.size === 0;
  const keys = new Set(rows.map((row) => row.key));
  if (quiet) {
    current.exiting.clear();
  } else {
    current.last.forEach((row, index) => {
      if (!keys.has(row.key) && !current.exiting.has(row.key)) current.exiting.set(row.key, { row, index, closing: false });
    });
    for (const key of keys) current.exiting.delete(key);
  }
  const entering = quiet ? new Set<Key>() : new Set([...keys].filter((key) => !current.keys.has(key)));
  // Removed rows keep their place (their last index) until their exit ends.
  const merged: Array<Row & { present: boolean }> = rows.map((row) => ({ ...row, present: true }));
  // A removed row starts folding one frame after the commit that removed it,
  // so the (often heavy) removal render does not swallow its exit.
  for (const { row, index, closing } of [...current.exiting.values()].sort((a, b) => a.index - b.index)) {
    merged.splice(Math.min(index, merged.length), 0, { ...row, present: !closing });
  }
  const pending = [...current.exiting.values()].some((entry) => !entry.closing);
  useEffect(() => {
    if (!pending) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        for (const entry of state.current.exiting.values()) entry.closing = true;
        rerender();
      });
    });
    return () => cancelAnimationFrame(frame);
  });
  current.scope = scope;
  current.keys = keys;
  current.last = rows;
  return (
    <>
      {merged.map(({ key, element, present }) => (
        <Collapsible
          key={key}
          open={present}
          appear={entering.has(key)}
          data-slot="collapsible-list-item"
          onExitComplete={() => {
            if (state.current.exiting.delete(key)) rerender();
          }}
        >
          {element}
        </Collapsible>
      ))}
    </>
  );
}
