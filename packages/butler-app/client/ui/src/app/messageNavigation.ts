import { create } from "zustand";
import { api } from "./api";
import { useButlerStore } from "./store";
import type { SessionView } from "./types";

export const useMessageNavigation = create<{ target: { sessionId: string; messageId: string } | null }>(() => ({ target: null }));

export async function openBranchSource(sessionId: string): Promise<void> {
  const result = await api<{ view: SessionView; messageId: string }>("/space/branch-source", {
    method: "POST", body: JSON.stringify({ sessionId }),
  });
  useButlerStore.getState().openSession(result.view.session_id);
  // Replace the visible window so an older source is not pruned behind the latest page.
  useButlerStore.setState({ messages: [] });
  useButlerStore.getState().setSessionView(result.view);
  useMessageNavigation.setState({ target: { sessionId: result.view.session_id, messageId: result.messageId } });
}
