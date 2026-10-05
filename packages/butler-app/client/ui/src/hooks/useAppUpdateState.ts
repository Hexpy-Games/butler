import { useEffect, useState } from "react";
import type { AppUpdateState } from "@/app/api.ts";

export function useAppUpdateState() {
  const [state, setState] = useState<AppUpdateState>({ status: "idle", request_id: null });
  useEffect(() => {
    const bridge = window.butlerApp;
    if (!bridge?.getAppUpdateState || !bridge.onAppUpdateState) return;
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onAppUpdateState((next) => {
      receivedEvent = true;
      if (mounted) setState(next);
    });
    void bridge.getAppUpdateState().then((next) => {
      if (mounted && !receivedEvent) setState(next);
    }).catch(() => {});
    return () => { mounted = false; unsubscribe(); };
  }, []);
  return state;
}
