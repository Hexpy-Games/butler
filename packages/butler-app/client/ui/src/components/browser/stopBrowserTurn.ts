import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { ACTIVE_TURN_STATES } from "@/app/constants";
import { notifyError } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { SessionView } from "@/app/types";
import { publicBrowserOwner } from "./browserOwnership";

/** A hub tab belongs to its conversation, independently of the selected chat. */
export async function stopBrowserTurn(owner: string): Promise<void> {
  const sessionId = publicBrowserOwner(owner, useButlerStore.getState().navigation);
  if (!sessionId) return;
  try {
    const view = await api<SessionView>(`/session-view?session_id=${encodeURIComponent(sessionId)}`);
    const turn = view.active_turn;
    if (!turn?.id || !turn.cancellable || !ACTIVE_TURN_STATES.has(turn.state)) return;
    await api(`/turns/${encodeURIComponent(turn.id)}/cancel`, {
      method: "POST", body: JSON.stringify({}),
    });
    if (useButlerStore.getState().activeChatId === sessionId) {
      await useButlerStore.getState().refreshSessionView(sessionId);
    }
  } catch (error) {
    notifyError(error, appCopy.interfaceFeedback.stopFailed, { id: `browser-stop-${sessionId}` });
  }
}
