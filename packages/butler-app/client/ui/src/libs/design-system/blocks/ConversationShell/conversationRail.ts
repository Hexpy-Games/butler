import { createContext, useContext, useLayoutEffect, useState } from "react";

/** A rail in the shell's `rail` slot reports whether it shows any tab. */
export const ConversationRailContext = createContext<((showing: boolean) => void) | null>(null);

/** Reports `showing` to the enclosing ConversationShell (no-op outside one) and `false` on unmount. */
export function useConversationRailReport(showing: boolean): void {
  const report = useContext(ConversationRailContext);
  useLayoutEffect(() => {
    report?.(showing);
  }, [report, showing]);
  useLayoutEffect(() => () => report?.(false), [report]);
}

/**
 * Whether the column makes room for the rail. It does while the rail shows a
 * tab, and, once it has in a `view`, for the rest of that view: cards that
 * come and go never move the column back and forth. No `rail`, no room.
 */
export function useRailReserve(hasRail: boolean, view: string | undefined): { reserved: boolean; report: (showing: boolean) => void } {
  const [showing, setShowing] = useState(false);
  const [latched, setLatched] = useState<string | null>(null);
  if (showing && hasRail && view !== undefined && latched !== view) setLatched(view);
  if (!hasRail && latched !== null) setLatched(null);
  const reserved = hasRail && (showing || (view !== undefined && latched === view));
  return { reserved, report: setShowing };
}
