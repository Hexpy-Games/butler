import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { NavigationView } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "./live";

export function useNavigationView() {
  const { client, reconcile, subscribe } = useConversation();
  const [view, setView] = useState<NavigationView | null>(null);
  const [error, setError] = useState(false);
  const reload = useRef<(immediate?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    setView(null);
    if (!client) return;
    let closed = false, pending = false, last = 0;
    let active: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async (immediate = false): Promise<void> => {
      if (closed) return;
      if (immediate) {
        const since = Date.now();
        while (active) await active;
        if (closed || last >= since) return;
        clearTimeout(timer); timer = undefined;
      } else {
        pending = true;
        if (active || timer) return;
      }
      const delay = last + 1000 - Date.now();
      if (!immediate && delay > 0) {
        timer = setTimeout(() => { timer = undefined; void request(); }, delay);
        return;
      }
      pending = false;
      last = Date.now();
      active = client.request<NavigationView>("/navigation").then(next => {
        if (!closed) { setView(next); setError(false); }
      }).catch(() => { if (!closed) setError(true); }).finally(() => {
        active = null;
        if (pending) void request();
      });
      await active;
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
      reload.current = async () => {};
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
  const refresh = useCallback(() => reload.current(true), []);
  return { view, error, retry, refresh };
}
