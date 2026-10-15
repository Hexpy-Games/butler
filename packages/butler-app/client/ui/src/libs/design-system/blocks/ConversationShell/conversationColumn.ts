import { createContext, useContext, useEffect, useRef } from "react";

/**
 * The message column a conversation background keeps clear: the column's
 * left and right edges and the conversation's top, in client CSS px. The
 * composer shares the column's width. Scrolling moves none of them.
 */
export interface ConversationColumnRect {
  left: number;
  right: number;
  top: number;
}

/** The shell's element, for the column's `top`. */
export const ConversationShellElementContext = createContext<HTMLElement | null>(null);

const sameRect = (a: ConversationColumnRect | null, b: ConversationColumnRect) =>
  a !== null && a.left === b.left && a.right === b.right && a.top === b.top;

/**
 * Reports `column`'s rect once laid out and again only when it changes: on
 * column or shell resizes (ResizeObserver, read right after layout) and
 * window resizes. No scroll listener and no per-frame work; equal values are
 * not reported twice.
 */
export function useConversationColumnRect(column: HTMLElement | null, onColumnRect: ((rect: ConversationColumnRect) => void) | undefined) {
  const shell = useContext(ConversationShellElementContext);
  const callback = useRef(onColumnRect);
  useEffect(() => {
    callback.current = onColumnRect;
  });
  const reporting = onColumnRect !== undefined;
  useEffect(() => {
    if (!reporting || !column) return undefined;
    let last: ConversationColumnRect | null = null;
    const update = () => {
      const { left, right } = column.getBoundingClientRect();
      const next = { left, right, top: (shell ?? column).getBoundingClientRect().top };
      if (sameRect(last, next)) return;
      last = next;
      callback.current?.(next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(column);
    if (shell) observer.observe(shell);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [reporting, column, shell]);
}
