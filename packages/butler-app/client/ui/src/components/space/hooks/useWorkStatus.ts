import { useEffect, useState } from "react";
import { subscribeAgentRuntimeState } from "@/app/agentRuntime.ts";
import { getWorkStatus } from "@/app/api.ts";
import type { WorkStatusView } from "@/app/types.ts";
import { createLiveEventConnection } from "@/hooks/live-session/liveEventConnection.ts";

export function useWorkStatus(): {
  view: WorkStatusView | null;
  unavailable: boolean;
} {
  const [view, setView] = useState<WorkStatusView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let dirty = false;
    const refresh = async () => {
      if (!active || inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      try {
        const next = await getWorkStatus();
        if (active) {
          setView(next);
          setUnavailable(false);
        }
      } catch {
        if (active) setUnavailable(true);
      } finally {
        inFlight = false;
        if (active && dirty) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        dirty = false;
        void refresh();
      }, 1500);
    };
    void refresh();
    const cursor = { current: 0 };
    const disconnect = createLiveEventConnection({
      cursor: () => cursor.current,
      onEvent: (event) => {
        if (typeof event.id === "number" && Number.isFinite(event.id)) {
          cursor.current = Math.max(cursor.current, event.id);
        }
        schedule();
      },
      onLostChange: () => undefined,
      onRecovered: schedule,
      subscribeResume: (resume) => subscribeAgentRuntimeState((state) => {
        if (state === "running") resume();
      }),
    });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      disconnect();
    };
  }, []);

  return { view, unavailable };
}
