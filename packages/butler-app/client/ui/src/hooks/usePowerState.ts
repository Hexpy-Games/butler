import { useEffect, useState } from "react";
import type { PowerState } from "../app/api.ts";

const DEFAULT_POWER_STATE: PowerState = { onBattery: false, constrained: false };

export function usePowerState(): PowerState {
  const [state, setState] = useState(DEFAULT_POWER_STATE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    return window.butlerApp?.onPowerState?.(setState);
  }, []);

  return state;
}
