import { useEffect, useRef } from "react";
import type { LogRecord } from "./logsApi";
import { subscribeLogs } from "./logsTransport";

const MAX_FAILURES = 5;
const MAX_DELAY_MS = 30_000;

/**
 * GET /logs/live while `enabled`: a dropped stream reconnects with backoff
 * (waiting while the page is hidden); after repeated failures `onLost` runs.
 * Unmounting or disabling closes it.
 */
export function useLiveLogs(enabled: boolean, onRecord: (record: LogRecord) => void, onLost: () => void) {
  const handlers = useRef({ onRecord, onLost });
  handlers.current = { onRecord, onLost };
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let failures = 0;
    let timer: number | undefined;
    let close: (() => void) | null = null;
    const whenVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", whenVisible);
      connect();
    };
    const retry = () => {
      close?.();
      close = null;
      failures += 1;
      if (failures >= MAX_FAILURES) {
        handlers.current.onLost();
        return;
      }
      timer = window.setTimeout(connect, Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 1)));
    };
    function connect() {
      if (closed) return;
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", whenVisible);
        return;
      }
      close = subscribeLogs({
        onOpen: () => { failures = 0; },
        onRecord: (record) => handlers.current.onRecord(record),
        onError: () => { if (!closed) retry(); },
      });
    }
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", whenVisible);
      close?.();
    };
  }, [enabled]);
}
