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
    const refresh = async () => {
      try {
        const next = await getWorkStatus();
        if (active) {
          setView(next);
          setUnavailable(false);
        }
      } catch {
        if (active) setUnavailable(true);
      }
    };
    void refresh();
    const unsubscribe = subscribeLiveEvents(0, () => void refresh(), () => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { view, unavailable };
}
