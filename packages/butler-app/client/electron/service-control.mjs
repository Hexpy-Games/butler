export const APP_AGENT_SERVICE_CONTROL_SCHEMA =
  "butler.app-agent-service-control.v1";

const serviceStatuses = new Set([
  "not_installed",
  "installing",
  "starting",
  "ready",
  "stopped",
  "failed",
  "needs_permission",
  "staging",
  "draining",
  "updating",
  "restarting",
  "candidate_ready",
  "promoting",
  "rollback",
]);

const platformDecisions = {
  darwin: "macos-registration-path",
  linux: "linux-package-service-path",
  win32: "windows-user-security-context",
};

export function createAgentServiceControl({
  platform = process.platform,
  adapter = null,
  now = () => new Date(),
} = {}) {
  const servicePlatform = platformDecisions[platform] ? platform : "unsupported";
  const requiredDecision = platformDecisions[servicePlatform] ?? "unsupported-platform";
  let lastError = null;

  async function getAgentServiceStatus() {
    if (!adapter?.getStatus) {
      return statusView({
        platform: servicePlatform,
        requiredDecision,
        status: "not_installed",
        serviceAvailable: false,
        diagnosticsAvailable: true,
        updatedAt: now().toISOString(),
      });
    }
    const adapterStatus = await adapter.getStatus();
    return statusView({
      platform: servicePlatform,
      requiredDecision,
      status: adapterStatus?.status,
      serviceAvailable: true,
      diagnosticsAvailable: true,
      updatedAt: now().toISOString(),
    });
  }

  async function installAgentService(request = {}) {
    return runServiceAction("install", adapter?.install, request);
  }

  async function startAgentService(request = {}) {
    return runServiceAction("start", adapter?.start, request);
  }

  async function stopAgentService(request = {}) {
    return runServiceAction("stop", adapter?.stop, request);
  }

  async function restartAgentService(request = {}) {
    return runServiceAction("restart", adapter?.restart, request);
  }

  async function prepareAgentRuntimeUpdate(request = {}) {
    return runServiceAction(
      "prepare_runtime_update",
      adapter?.prepareRuntimeUpdate,
      request,
      "agent_runtime_update_unavailable",
      "failed",
    );
  }

  async function applyAgentRuntimeUpdate(request = {}) {
    return runServiceAction(
      "apply_runtime_update",
      adapter?.applyRuntimeUpdate,
      request,
      "agent_runtime_update_unavailable",
      "failed",
    );
  }

  async function rollbackAgentRuntimeUpdate(request = {}) {
    return runServiceAction(
      "rollback_runtime_update",
      adapter?.rollbackRuntimeUpdate,
      request,
      "agent_runtime_update_unavailable",
      "failed",
    );
  }

  async function readAgentServiceDiagnostics() {
    const adapterDiagnostics = adapter?.diagnostics
      ? await safeDiagnostics(adapter.diagnostics)
      : null;
    return {
      schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
      generated_at: now().toISOString(),
      platform: servicePlatform,
      required_decision: requiredDecision,
      service_available: Boolean(adapter),
      diagnostics_available: true,
      last_error: lastError,
      adapter: adapterDiagnostics,
      raw_text_included: false,
    };
  }

  async function runServiceAction(
    action,
    handler,
    request,
    unavailableCode = "service_registration_unavailable",
    unavailableStatus = "needs_permission",
  ) {
    if (!handler) {
      lastError = {
        code: unavailableCode,
        action,
        at: now().toISOString(),
      };
      return actionResult({
        action,
        ok: false,
        status: unavailableStatus,
        platform: servicePlatform,
        requiredDecision,
        errorCode: lastError.code,
        updatedAt: lastError.at,
      });
    }
    try {
      const result = await handler(request ?? {});
      const ok = result?.ok !== false;
      lastError = null;
      return actionResult({
        action,
        ok,
        status: result?.status,
        platform: servicePlatform,
        requiredDecision,
        errorCode: ok ? null : safeErrorCode(result),
        updatedAt: now().toISOString(),
      });
    } catch (error) {
      lastError = {
        code: safeErrorCode(error),
        action,
        at: now().toISOString(),
      };
      return actionResult({
        action,
        ok: false,
        status: "failed",
        platform: servicePlatform,
        requiredDecision,
        errorCode: lastError.code,
        updatedAt: lastError.at,
      });
    }
  }

  return {
    getAgentServiceStatus,
    installAgentService,
    startAgentService,
    stopAgentService,
    restartAgentService,
    prepareAgentRuntimeUpdate,
    applyAgentRuntimeUpdate,
    rollbackAgentRuntimeUpdate,
    readAgentServiceDiagnostics,
  };
}

function statusView({
  platform,
  requiredDecision,
  status,
  serviceAvailable,
  diagnosticsAvailable,
  updatedAt,
}) {
  return {
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    status: normalizeStatus(status, serviceAvailable ? "stopped" : "not_installed"),
    platform,
    required_decision: requiredDecision,
    service_available: serviceAvailable,
    diagnostics_available: diagnosticsAvailable,
    updated_at: updatedAt,
    raw_text_included: false,
  };
}

function actionResult({
  action,
  ok,
  status,
  platform,
  requiredDecision,
  errorCode = null,
  updatedAt,
}) {
  return {
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    action,
    ok,
    status: normalizeActionStatus(status, ok),
    platform,
    required_decision: requiredDecision,
    error_code: errorCode,
    updated_at: updatedAt,
    raw_text_included: false,
  };
}

function normalizeActionStatus(value, ok) {
  const status = normalizeStatus(value, ok ? "ready" : "failed");
  if (ok) return status;
  return ["failed", "needs_permission", "stopped"].includes(status) ? status : "failed";
}

async function safeDiagnostics(readDiagnostics) {
  try {
    const value = await readDiagnostics();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      status: normalizeStatus(value.status, "stopped"),
      service_available: value.service_available !== false,
      raw_text_included: false,
    };
  } catch (error) {
    return {
      status: "failed",
      error_code: safeErrorCode(error),
      raw_text_included: false,
    };
  }
}

function normalizeStatus(value, fallback) {
  return typeof value === "string" && serviceStatuses.has(value) ? value : fallback;
}

function safeErrorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") {
    return error.code.replace(/[^a-z0-9_:-]/giu, "_").slice(0, 80) || "service_action_failed";
  }
  return "service_action_failed";
}
