import { subscribeLiveEvents } from "@/app/api.ts";
import type { TimelineEvent } from "@/app/types.ts";
import { LIVE_EVENT_STABLE_CONNECTION_MS, liveEventReconnectDelayMs } from "./liveEventReconnect.ts";

const OPEN_DEADLINE_MS = 30_000;
const HEARTBEAT_DEADLINE_MS = 45_000; // Server sends a heartbeat every 15s.

/** One owner for transport lifetime; replaced subscriptions have no authority. */
export function createLiveEventConnection(options: {
  cursor: () => number;
  onEvent: (event: TimelineEvent) => void;
  onLostChange: (lost: boolean) => void;
  onRecovered: () => void;
}): () => void {
  let disposed = false;
  let generation = 0;
  let attempts = 0;
  let failures = 0;
  let lost = false;
  let lastSignal = 0;
  let unsubscribe: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  const setLost = (value: boolean) => { lost = value; options.onLostChange(value); };
  const close = () => {
    generation++;
    clearTimeout(retryTimer); clearTimeout(deadline); clearTimeout(stableTimer);
    retryTimer = deadline = stableTimer = undefined;
    const previous = unsubscribe;
    unsubscribe = undefined;
    previous?.();
  };
  const disconnect = (retry = true) => {
    if (disposed) return;
    close();
    setLost(true);
    if (retry && navigator.onLine !== false) {
      retryTimer = setTimeout(connect, liveEventReconnectDelayMs(failures++));
    }
  };
  const connect = () => {
    if (disposed) return;
    close();
    setLost(true);
    if (navigator.onLine === false) return;
    const current = generation;
    const isCurrent = () => !disposed && current === generation;
    const recovering = attempts++ > 0;
    let opened = false;
    let heartbeatObserved = false;
    const healthy = (activity = false, heartbeat = false) => {
      if (!isCurrent()) return;
      heartbeatObserved ||= heartbeat;
      lastSignal = Date.now();
      clearTimeout(deadline);
      deadline = heartbeatObserved
        ? setTimeout(() => { if (isCurrent()) disconnect(); }, HEARTBEAT_DEADLINE_MS)
        : undefined; // Older servers/preloads do not expose heartbeat callbacks.
      setLost(false);
      if (activity) failures = 0;
      if (!opened) {
        opened = true;
        stableTimer = setTimeout(() => { if (isCurrent()) failures = 0; }, LIVE_EVENT_STABLE_CONNECTION_MS);
        if (recovering) options.onRecovered();
      }
    };
    const fail = () => { if (isCurrent()) disconnect(); };
    deadline = setTimeout(fail, OPEN_DEADLINE_MS);
    try {
      const next = subscribeLiveEvents(options.cursor(), event => {
        if (!isCurrent()) return;
        try { options.onEvent(event); healthy(true); } catch { fail(); }
      }, fail, () => healthy(), () => healthy(true, true));
      if (isCurrent()) unsubscribe = next;
      else next(); // Handles a synchronous subscription failure without leaking.
    } catch { fail(); }
  };
  const online = () => { if (lost) connect(); };
  const offline = () => disconnect(false);
  const visible = () => {
    if (document.visibilityState === "visible" && (lost || Date.now() - lastSignal >= HEARTBEAT_DEADLINE_MS)) connect();
  };
  window.addEventListener("online", online);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", visible);
  connect();
  return () => {
    disposed = true;
    close();
    window.removeEventListener("online", online);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", visible);
    setLost(false);
  };
}
