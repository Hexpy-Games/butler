import { createContext, useContext } from "react";

/**
 * The session whose activity a subtree renders when it is not the active chat
 * or the observer dialog's session (a work block's inline details), so nested
 * worker calls resolve against their own session.
 */
export const ObservedSessionContext = createContext<string | null>(null);

export function useObservedSessionId(): string | null {
  return useContext(ObservedSessionContext);
}
