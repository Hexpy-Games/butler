const launchRecoverableStatuses = new Set([
  "not_installed",
  "stopped",
  "failed",
  "needs_permission",
  "starting",
]);

const installBeforeStartStatuses = new Set([
  "not_installed",
  "stopped",
  "needs_permission",
]);

export async function reconcileAgentServiceOnAppLaunch({
  serviceControl = null,
  enabled = true,
  runtimeCurrent = () => ({ current: true }),
  source = "app-launch",
  logger = console,
  debug = process.env.BUTLER_APP_DEBUG_LAUNCH_RECONCILE === "1",
} = {}) {
  if (!enabled || !serviceControl?.getAgentServiceStatus) {
    debugLog(logger, debug, "skipped", { reason: "disabled" });
    return skipped("disabled");
  }
  const initialStatus = await safeServiceStatus(serviceControl);
  const status = safeStatus(initialStatus?.status);
  debugLog(logger, debug, "initial-status", { status, initialStatus });
  if (status === "ready") {
    const runtimeStatus = await safeRuntimeCurrent(runtimeCurrent);
    debugLog(logger, debug, "runtime-status", { runtimeStatus });
    if (!runtimeStatus.current) {
      return repairReadyRuntimeMismatch({
        serviceControl,
        source,
        initialStatus,
        runtimeStatus,
        logger,
        debug,
      });
    }
    return {
      attempted: false,
      reason: "already_ready",
      initialStatus,
      finalStatus: initialStatus,
    };
  }
  if (!launchRecoverableStatuses.has(status)) {
    debugLog(logger, debug, "not-recoverable", { status });
    return {
      attempted: false,
      reason: "not_recoverable",
      initialStatus,
      finalStatus: initialStatus,
    };
  }
  try {
    if (
      installBeforeStartStatuses.has(status) &&
      serviceControl.installAgentService
    ) {
      const install = await serviceControl.installAgentService({ source });
      debugLog(logger, debug, "install-result", { install });
      if (install?.ok === false) {
        return {
          attempted: true,
          reason: "install_failed",
          initialStatus,
          actionResult: install,
          finalStatus: await safeServiceStatus(serviceControl),
        };
      }
    }
    if (serviceControl.startAgentService) {
      const start = await serviceControl.startAgentService({ source });
      debugLog(logger, debug, "start-result", { start });
      const finalStatus = await safeServiceStatus(serviceControl);
      debugLog(logger, debug, "final-status", { finalStatus });
      return {
        attempted: true,
        reason: start?.ok === false ? "start_failed" : "started",
        initialStatus,
        actionResult: start,
        finalStatus,
      };
    }
    debugLog(logger, debug, "start-unavailable", {});
    return {
      attempted: false,
      reason: "start_unavailable",
      initialStatus,
      finalStatus: initialStatus,
    };
  } catch (error) {
    logger?.warn?.(
      `Butler Agent service launch reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      attempted: true,
      reason: "error",
      initialStatus,
      error: safeErrorCode(error),
      finalStatus: await safeServiceStatus(serviceControl),
    };
  }
}

async function repairReadyRuntimeMismatch({
  serviceControl,
  source,
  initialStatus,
  runtimeStatus,
  logger,
  debug,
}) {
  try {
    const install = await serviceControl.installAgentService({ source });
    debugLog(logger, debug, "runtime-install-result", { install });
    if (install?.ok === false) {
      return {
        attempted: true,
        reason: "install_failed",
        initialStatus,
        runtimeStatus,
        actionResult: install,
        finalStatus: await safeServiceStatus(serviceControl),
      };
    }
    const restart = serviceControl.restartAgentService
      ? await serviceControl.restartAgentService({ source })
      : await serviceControl.startAgentService({ source });
    debugLog(logger, debug, "runtime-restart-result", { restart });
    const finalStatus = await safeServiceStatus(serviceControl);
    debugLog(logger, debug, "runtime-final-status", { finalStatus });
    return {
      attempted: true,
      reason: restart?.ok === false ? "restart_failed" : "runtime_updated",
      initialStatus,
      runtimeStatus,
      actionResult: restart,
      finalStatus,
    };
  } catch (error) {
    logger?.warn?.(
      `Butler Agent service runtime reconciliation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      attempted: true,
      reason: "error",
      initialStatus,
      runtimeStatus,
      error: safeErrorCode(error),
      finalStatus: await safeServiceStatus(serviceControl),
    };
  }
}

function debugLog(logger, enabled, event, data) {
  if (!enabled) return;
  logger?.warn?.(`[butler-app-launch-reconcile] ${event} ${JSON.stringify(data)}`);
}

function skipped(reason) {
  return {
    attempted: false,
    reason,
    initialStatus: null,
    finalStatus: null,
  };
}

async function safeServiceStatus(serviceControl) {
  try {
    return await serviceControl.getAgentServiceStatus();
  } catch (error) {
    return {
      status: "failed",
      error_code: safeErrorCode(error),
      raw_text_included: false,
    };
  }
}

async function safeRuntimeCurrent(runtimeCurrent) {
  try {
    const result = await runtimeCurrent();
    if (typeof result === "boolean") {
      return { current: result, raw_text_included: false };
    }
    return {
      current: result?.current !== false,
      expectedVersion: safeOptionalString(result?.expectedVersion),
      activeVersion: safeOptionalString(result?.activeVersion),
      reason: safeOptionalString(result?.reason),
      raw_text_included: false,
    };
  } catch (error) {
    return {
      current: false,
      reason: safeErrorCode(error),
      raw_text_included: false,
    };
  }
}

function safeStatus(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "failed";
}

function safeErrorCode(error) {
  const code = error?.code ?? error?.name ?? "service_reconcile_failed";
  return String(code).toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
}

function safeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
