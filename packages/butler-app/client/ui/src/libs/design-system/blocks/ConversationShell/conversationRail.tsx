import { createContext, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import styles from "./ConversationShell.module.css";

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

/** `held` while the aside shows or leaves; `released` once it has gone after a hold. */
export type RailHold = "held" | "released" | undefined;

/**
 * Whether the rail waits for the aside. The two share the right margin, so the rail stays hidden
 * while the aside shows and until its exit has ended (`asideExited`), then fades in: its cards
 * never show under a pane that is still leaving.
 */
function useRailHold(asideShown: boolean): { hold: RailHold; asideExited: () => void } {
  const [shown, setShown] = useState(asideShown);
  const [leaving, setLeaving] = useState(false);
  const [wasHeld, setWasHeld] = useState(asideShown);
  if (shown !== asideShown) {
    setShown(asideShown);
    setLeaving(!asideShown);
    if (asideShown) setWasHeld(true);
  }
  const asideExited = useCallback(() => setLeaving(false), []);
  const held = asideShown || leaving;
  return { hold: held ? "held" : wasHeld ? "released" : undefined, asideExited };
}

/** The shell's rail state: room for the rail (none while the aside shows) and whether it waits for the aside. */
export function useShellRail(hasRail: boolean, view: string | undefined, asideShown: boolean) {
  const { hold, asideExited } = useRailHold(asideShown);
  return { hold, asideExited, ...useRailReserve(hasRail && !asideShown, view) };
}

/** The rail slot: no box of its own (ConversationShell.module.css). Held, the rail is hidden and inert; released, it fades in. */
export function ConversationRailSlot({ hold, report, children }: { hold: RailHold; report: (showing: boolean) => void; children: ReactNode }) {
  return (
    <div className={styles.railSlot} data-slot="conversation-rail" data-hold={hold} inert={hold === "held"}>
      <ConversationRailContext.Provider value={report}>{children}</ConversationRailContext.Provider>
    </div>
  );
}
