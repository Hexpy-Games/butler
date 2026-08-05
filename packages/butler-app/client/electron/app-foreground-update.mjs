const foregroundDrainStates = new Set([
  "ready",
  "degraded",
  "update_pending",
]);

export function planAppForegroundUpdateStop({
  usesAppForegroundLifecycle = false,
  foregroundState = null,
  activeWorkSnapshot = null,
  restoreState = null,
} = {}) {
  const requiresDrain = activeWorkSnapshot?.classification !== "no_active_work";
  if (!requiresDrain) {
    return {
      allowed: true,
      requiresDrain: false,
      restoreState: null,
      reason: "no_active_work",
    };
  }
  if (
    !usesAppForegroundLifecycle ||
    !foregroundDrainStates.has(foregroundState)
  ) {
    return {
      allowed: false,
      requiresDrain: true,
      restoreState: null,
      reason: "foreground_drain_unavailable",
    };
  }
  return {
    allowed: true,
    requiresDrain: true,
    restoreState: restoreState ?? foregroundState,
    reason: null,
  };
}

export async function quitAndInstallAppUpdate({
  readActiveWork,
  confirmQuit,
  stopForUpdate,
  quitAndInstall,
}) {
  const snapshot = await readActiveWork();
  if (!(await confirmQuit(snapshot))) {
    return {
      status: "cancelled",
      update_started: false,
      raw_text_included: false,
    };
  }
  const stopResult = await stopForUpdate(snapshot);
  if (stopResult?.update_ready !== true) {
    return {
      status: "drain_failed",
      update_started: false,
      drain: stopResult?.drain ?? null,
      raw_text_included: false,
    };
  }
  quitAndInstall();
  return {
    status: "update_started",
    update_started: true,
    raw_text_included: false,
  };
}
