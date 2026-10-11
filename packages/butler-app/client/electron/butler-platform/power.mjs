const constrainedThermalStates = new Set(["fair", "serious", "critical"]);
const supportedThermalStates = new Set(["unknown", "nominal", ...constrainedThermalStates]);

function initialOnBattery(powerMonitor) {
  try {
    if (typeof powerMonitor.isOnBatteryPower === "function") {
      return powerMonitor.isOnBatteryPower() === true;
    }
    return powerMonitor.onBatteryPower === true;
  } catch {
    return false;
  }
}

function initialThermalState(powerMonitor) {
  try {
    return typeof powerMonitor.getCurrentThermalState === "function"
      ? powerMonitor.getCurrentThermalState()
      : "unknown";
  } catch {
    return "unknown";
  }
}

function thermalStateFrom(args) {
  for (const value of args) {
    const state = typeof value === "string" ? value : value?.state ?? value?.details?.state;
    if (supportedThermalStates.has(state)) return state;
  }
  return null;
}

function speedLimitFrom(args) {
  for (const value of args) {
    const limit = typeof value === "number"
      ? value
      : value?.limit ?? value?.details?.limit;
    if (Number.isFinite(limit)) return limit;
  }
  return null;
}

function stateFor(onBattery, thermalState, speedLimit) {
  return {
    onBattery,
    constrained: constrainedThermalStates.has(thermalState) ||
      (speedLimit !== null && speedLimit < 100),
  };
}

function sameState(left, right) {
  return left.onBattery === right.onBattery && left.constrained === right.constrained;
}

/** Observe native power events; this source intentionally has no timer or polling path. */
export function createPowerStateMonitor(powerMonitor, onChange = () => {}) {
  let onBattery = initialOnBattery(powerMonitor);
  let thermalState = initialThermalState(powerMonitor);
  let speedLimit = null;
  let current = stateFor(onBattery, thermalState, speedLimit);
  const publishIfChanged = () => {
    const next = stateFor(onBattery, thermalState, speedLimit);
    if (sameState(current, next)) return;
    current = next;
    onChange({ ...next });
  };
  const setOnBattery = (value) => {
    onBattery = value;
    publishIfChanged();
  };
  const refreshThermalState = (...args) => {
    thermalState = thermalStateFrom(args) ?? initialThermalState(powerMonitor);
    publishIfChanged();
  };
  const updateSpeedLimit = (...args) => {
    const nextLimit = speedLimitFrom(args);
    if (nextLimit === null) return;
    speedLimit = nextLimit;
    publishIfChanged();
  };
  const handlers = [
    ["on-battery", () => setOnBattery(true)],
    ["on-ac", () => setOnBattery(false)],
    ["thermal-state-change", refreshThermalState],
    ["speed-limit-change", updateSpeedLimit],
  ];
  for (const [event, handler] of handlers) powerMonitor.on?.(event, handler);

  return {
    getState: () => ({ ...current }),
    stop() {
      for (const [event, handler] of handlers) powerMonitor.removeListener?.(event, handler);
    },
  };
}

export async function startPowerStateMonitor(onChange) {
  const { powerMonitor } = await import("electron");
  return createPowerStateMonitor(powerMonitor, onChange);
}
