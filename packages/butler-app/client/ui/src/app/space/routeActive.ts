import type { AppView } from "../types";

/** The chat shown by the current route, rather than the remembered conversation. */
export function routeActiveChatId(state: { view: AppView; activeChatId: string }): string | null {
  return state.view.kind === "session" ? state.activeChatId : null;
}
