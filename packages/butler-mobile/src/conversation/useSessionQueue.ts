import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionQueueView, SessionView } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "./live";

export function useSessionQueue(id: string | undefined, session: SessionView | null) {
  const { client, subscribe } = useConversation();
  const [view, setView] = useState<SessionQueueView | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!client || !id) return;
    const current = ++request.current;
    try {
      const next = await client.request<SessionQueueView>(`/session-queue?session_id=${encodeURIComponent(id)}`);
      if (current === request.current) setView(next);
    } catch { /* Retain the current queue until the next refresh. */ }
  }, [client, id]);
  useEffect(() => {
    setView(null);
    return () => { request.current++; };
  }, [client, id]);
  useEffect(() => {
    void refresh();
  }, [refresh, session?.active_turn?.state, session?.latest_turn?.id]);
  useEffect(() => subscribe(event => {
    if (!id || (!event.type.startsWith("session_queue.") && !event.type.startsWith("session.queue."))) return;
    const payload = event.payload;
    if ((payload?.session_id ?? payload?.chat_id) === id) void refresh();
  }), [id, subscribe, refresh]);
  return { view, refresh };
}
