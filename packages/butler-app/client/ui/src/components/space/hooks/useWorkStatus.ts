import { useEffect, useState } from "react";
import { getWorkStatus, subscribeLiveEvents } from "@/app/api.ts";
import type { WorkStatusView } from "@/app/types.ts";

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
    const unsubscribe = subscribeLiveEvents(0, schedule, () => undefined);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return { view, unavailable };
}
