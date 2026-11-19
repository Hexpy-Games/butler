import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { NavigationView } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "./live";

export function useNavigationView() {
  const { client, reconcile, subscribe } = useConversation();
  const [view, setView] = useState<NavigationView | null>(null);
  const [error, setError] = useState(false);
  const reload = useRef(() => {});
  useEffect(() => {
    setView(null);
    if (!client) return;
    let closed = false, busy = false, pending = false, last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = () => {
      if (closed) return;
      pending = true;
      if (busy || timer) return;
      const delay = last + 1000 - Date.now();
      if (delay > 0) {
        timer = setTimeout(() => { timer = undefined; request(); }, delay);
        return;
      }
      busy = true;
      pending = false;
      last = Date.now();
      void client.request<NavigationView>("/navigation").then(next => {
        if (!closed) { setView(next); setError(false); }
      }).catch(() => { if (!closed) setError(true); }).finally(() => {
        busy = false;
        if (pending) request();
      });
    };
    reload.current = request;
    const unsubscribe = subscribe(event => {
      if (["session.", "turn.", "message.", "session_queue.", "space.", "project.", "pending_asks."]
        .some(prefix => event.type.startsWith(prefix))) request();
    });
    request();
    return () => {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      reload.current = () => {};
    };
  }, [client, subscribe]);
  useFocusEffect(useCallback(() => { reload.current(); }, []));
  const seen = useRef(reconcile);
  useEffect(() => {
    if (seen.current === reconcile) return;
    seen.current = reconcile;
    reload.current();
  }, [reconcile]);
  const retry = useCallback(() => reload.current(), []);
  return { view, error, retry };
}
