export function createFirstRunSetupBridge({
  ensureReady,
  readSettings,
  readRuntimeDiagnostics = () => ({}),
  serviceControl = null,
  gatewayProfile = "electron",
  gatewayReadyPollAttempts = 120,
  gatewayReadyPollDelayMs = 250,
  serviceReadyPollAttempts = 120,
  serviceReadyPollDelayMs = 250,
  sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let runId = 0;
  let session = createSession("idle");

  return {
    status() {
      return statusView(session);
    },
    diagnostics() {
      return diagnosticsView(session);
    },
    cancel() {
      runId += 1;
      session.cancelled = true;
      session = createSession("cancelled", {
        checks: session.checks.map((check) => ({
          ...check,
          status: check.status === "pending" ? "cancelled" : check.status,
        })),
        startedAt: session.startedAt,
        cancelled: true,
      });
      return statusView(session);
    },
    async start() {
      const currentRunId = runId + 1;
      runId = currentRunId;
      const startedAt = new Date().toISOString();
      const currentSession = createSession("checking", {
        checks: [
          setupCheck(
            "agent_service",
            "Butler Agent 서비스",
          ),
          setupCheck(
            "managed_gateway",
            "Butler Agent 연결",
          ),
          setupCheck("bundled_agent_version", "Agent 버전 확인"),
          setupCheck("local_auth", "로컬 인증 확인"),
          setupCheck("health", "상태 확인"),
          setupCheck("protocol", "프로토콜 확인"),
          setupCheck(
            "gateway_profile",
            "Electron 연결 확인",
          ),
        ],
        startedAt,
      });
      session = currentSession;
      try {
        let runtimeDiagnostics = null;
        const serviceStatus = await readServiceStatus(serviceControl);
        if (!serviceReady(serviceStatus)) {
          await installOrStartService(serviceControl, serviceStatus);
        }
        const nextServiceStatus = await waitForServiceReady(serviceControl, {
          attempts: serviceReadyPollAttempts,
          delayMs: serviceReadyPollDelayMs,
          sleepMs,
          shouldContinue: () => isActiveRun(currentRunId, runId, session) &&
            !currentSession.cancelled,
        });
        let gatewayReadyConfirmed = false;
        if (!serviceReady(nextServiceStatus)) {
          try {
            await waitForGatewayReady(ensureReady, {
              attempts: gatewayReadyPollAttempts,
              delayMs: gatewayReadyPollDelayMs,
              sleepMs,
              shouldContinue: () => isActiveRun(currentRunId, runId, session) &&
                !currentSession.cancelled,
            });
            gatewayReadyConfirmed = true;
          } catch {
            throw setupError(serviceSetupErrorCode(nextServiceStatus));
          }
        }
        markCheck(
          currentSession,
          "agent_service",
          "passed",
        );
        if (!gatewayReadyConfirmed) {
          await waitForGatewayReady(ensureReady, {
            attempts: gatewayReadyPollAttempts,
            delayMs: gatewayReadyPollDelayMs,
            sleepMs,
            shouldContinue: () => isActiveRun(currentRunId, runId, session) &&
              !currentSession.cancelled,
          });
        }
        if (!isActiveRun(currentRunId, runId, session)) return statusView(session);
        if (currentSession.cancelled) return statusView(currentSession);
        markCheck(
          currentSession,
          "managed_gateway",
          "passed",
        );
        runtimeDiagnostics = safeReadRuntimeDiagnostics(readRuntimeDiagnostics);
        if (!bundledAgentVersionReady(runtimeDiagnostics)) {
          throw setupError("bundled_agent_version_missing");
        }
        markCheck(currentSession, "bundled_agent_version", "passed");
        if (runtimeDiagnostics?.local_auth?.required !== true ||
          runtimeDiagnostics?.local_auth?.token_configured !== true) {
          throw setupError("local_auth_unavailable");
        }
        markCheck(currentSession, "local_auth", "passed");
        if (runtimeDiagnostics?.phase !== "running") {
          throw setupError("health_unavailable");
        }
        markCheck(currentSession, "health", "passed");
        const settings = await readSettings();
        if (!isActiveRun(currentRunId, runId, session)) return statusView(session);
        if (currentSession.cancelled) return statusView(currentSession);
        markCheck(currentSession, "protocol", "passed");
        if (gatewayProfile !== "electron" || settings?.gateway_profile !== "electron") {
          throw setupError("gateway_profile_mismatch");
        }
        markCheck(
          currentSession,
          "gateway_profile",
          "passed",
        );
        if (isActiveRun(currentRunId, runId, session)) {
          session = createSession("ready", {
            checks: currentSession.checks,
            startedAt,
          });
        }
      } catch (error) {
        if (!isActiveRun(currentRunId, runId, session)) return statusView(session);
        const errorCode = setupErrorCode(error);
        session = createSession("failed", {
          checks: failPendingChecks(currentSession.checks),
          errorCode,
          supportDetails: setupSupportDetails({
            errorCode,
            error,
            runtimeDiagnostics: safeReadRuntimeDiagnostics(readRuntimeDiagnostics),
            serviceDiagnostics: await safeReadServiceDiagnostics(serviceControl),
          }),
          startedAt,
        });
      }
      return statusView(session);
    },
  };
}

function createSession(phase, patch = {}) {
  return {
    phase,
    checks: patch.checks ?? [],
    errorCode: patch.errorCode ?? null,
    supportDetails: patch.supportDetails ?? null,
    startedAt: patch.startedAt ?? null,
    updatedAt: new Date().toISOString(),
    cancelled: patch.cancelled === true,
  };
}

function statusView(session) {
  return {
    phase: session.phase,
    status_label: statusLabel(session),
    diagnostics_available: true,
    ...(session.errorCode ? { error_code: session.errorCode } : {}),
  };
}

function statusLabel(session) {
  if (session.phase === "ready") return "준비 완료";
  if (session.phase === "failed") return "Butler Agent를 준비하지 못했습니다.";
  if (session.phase === "cancelled") return "취소됨";
  if (session.phase === "checking") return "상태 확인 중";
  return "대기 중";
}

function diagnosticsView(session) {
  return {
    generated_at: new Date().toISOString(),
    phase: session.phase,
    checks: session.checks.map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
    })),
    errors: session.errorCode
      ? [{
        code: session.errorCode,
        message: statusLabel(session),
        details: session.supportDetails ?? undefined,
      }]
      : [],
  };
}

function setupCheck(id, label) {
  return { id, label, status: "pending" };
}

function markCheck(session, id, status) {
  session.checks = session.checks.map((check) =>
    check.id === id ? { ...check, status } : check,
  );
}

function failPendingChecks(checks) {
  return checks.map((check) =>
    check.status === "pending" ? { ...check, status: "failed" } : check,
  );
}

function setupErrorCode(error) {
  if (
    error?.code === "service_registration_unavailable" ||
    error?.code === "agent_service_not_ready" ||
    error?.code === "agent_service_failed" ||
    error?.code === "gateway_profile_mismatch" ||
    error?.code === "bundled_agent_version_missing" ||
    error?.code === "local_auth_unavailable" ||
    error?.code === "health_unavailable"
  ) {
    return error.code;
  }
  return "setup_failed";
}

function serviceReady(status) {
  return status?.status === "ready";
}

function serviceSetupErrorCode(status) {
  if (status?.error_code === "service_registration_unavailable") {
    return "service_registration_unavailable";
  }
  if (status?.status === "failed") return "agent_service_failed";
  return "agent_service_not_ready";
}

async function readServiceStatus(serviceControl) {
  if (!serviceControl?.getAgentServiceStatus) {
    return { status: "ready", raw_text_included: false };
  }
  return sanitizeDiagnosticsValue(await serviceControl.getAgentServiceStatus());
}

async function installOrStartService(serviceControl, serviceStatus) {
  if (!serviceControl) return;
  if (
    ["not_installed", "stopped", "needs_permission"].includes(serviceStatus?.status) &&
    serviceControl.installAgentService
  ) {
    const install = sanitizeDiagnosticsValue(await serviceControl.installAgentService({ source: "first-run" }));
    if (install?.ok === false) {
      throw setupError(install.error_code || serviceSetupErrorCode(install));
    }
  }
  if (
    ["not_installed", "stopped", "needs_permission"].includes(serviceStatus?.status) &&
    serviceControl.startAgentService
  ) {
    const start = sanitizeDiagnosticsValue(await serviceControl.startAgentService({ source: "first-run" }));
    if (start?.ok === false) {
      throw setupError(start.error_code || serviceSetupErrorCode(start));
    }
  }
}

async function waitForServiceReady(
  serviceControl,
  { attempts, delayMs, sleepMs, shouldContinue },
) {
  let lastStatus = await readServiceStatus(serviceControl);
  if (serviceReady(lastStatus)) return lastStatus;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt < maxAttempts && shouldContinue(); attempt += 1) {
    await sleepMs(delayMs);
    lastStatus = await readServiceStatus(serviceControl);
    if (serviceReady(lastStatus)) return lastStatus;
    if (lastStatus?.status === "failed") return lastStatus;
  }
  return lastStatus;
}

async function waitForGatewayReady(
  ensureReady,
  { attempts, delayMs, sleepMs, shouldContinue },
) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts && shouldContinue(); attempt += 1) {
    try {
      await ensureReady();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await sleepMs(delayMs);
    }
  }
  throw lastError ?? setupError("agent_service_not_ready");
}

async function safeReadServiceDiagnostics(serviceControl) {
  if (!serviceControl?.readAgentServiceDiagnostics) return null;
  try {
    return sanitizeDiagnosticsValue(await serviceControl.readAgentServiceDiagnostics());
  } catch {
    return {
      status: "unavailable",
      raw_text_included: false,
    };
  }
}

function bundledAgentVersionReady(diagnostics) {
  if (diagnostics?.bundled_agent?.version_configured === true) return true;
  return diagnostics?.bundled_agent?.source === "development";
}

function setupError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isActiveRun(currentRunId, runId, session) {
  return runId === currentRunId && session.phase === "checking";
}

function safeReadRuntimeDiagnostics(readRuntimeDiagnostics) {
  try {
    return sanitizeDiagnosticsValue(readRuntimeDiagnostics());
  } catch {
    return {
      phase: "unavailable",
      raw_text_included: false,
    };
  }
}

function setupSupportDetails({
  errorCode,
  error,
  runtimeDiagnostics,
  serviceDiagnostics = null,
}) {
  return sanitizeDiagnosticsValue({
    setup_error_code: errorCode,
    exception_code:
      error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : undefined,
    exception_message:
      error instanceof Error ? redactDiagnosticsText(error.message) : undefined,
    runtime: runtimeDiagnostics,
    service: serviceDiagnostics,
    raw_text_included: false,
  });
}

function sanitizeDiagnosticsValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactDiagnosticsText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticsValue(item));
  if (typeof value !== "object") return undefined;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "raw_text_included") {
      output.raw_text_included = false;
      continue;
    }
    if (/stack|trace|stdout|stderr|raw_output|raw_error/iu.test(key)) {
      continue;
    }
    if (/code$/iu.test(key) && typeof raw === "string") {
      output[key] = raw.replace(/[^a-z0-9_:-]/giu, "_").slice(0, 80);
      continue;
    }
    if (/token|secret|authorization|password|credential/iu.test(key)) {
      output[key] = typeof raw === "boolean" ? raw : "[redacted]";
      continue;
    }
    if (/path|file|dir|home|root|cwd/iu.test(key) && typeof raw === "string") {
      output[key] = redactDiagnosticsPath(raw);
      continue;
    }
    output[key] = sanitizeDiagnosticsValue(raw);
  }
  output.raw_text_included = false;
  return output;
}

function redactDiagnosticsText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [redacted-token]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/gu, "[redacted-token]")
    .replace(/~[\\/][^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/[A-Za-z]:\\Users\\[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\\Users\\[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\/Users\/[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/\/private\/[^"'\n\r\t,)]+/gu, "[redacted-path]")
    .replace(/(^|[=:\s'"(])\/(?!\/)[^ "'\n\r\t,)]+/gu, "$1[redacted-path]")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted-token]");
}

function redactDiagnosticsPath(value) {
  const text = String(value);
  const normalized = text.replaceAll("\\", "/");
  if (text.includes(".app/Contents/Resources")) return "[app-resource]";
  if (text.startsWith("app/")) return text;
  if (text.startsWith("runtime/")) return text;
  if (
    normalized.startsWith("~/") ||
    normalized.startsWith("/Users/") ||
    normalized.startsWith("/private/") ||
    /^[A-Za-z]:\/Users\//u.test(normalized)
  ) {
    return "[redacted-path]";
  }
  if (text.startsWith("/")) return "[redacted-path]";
  return redactDiagnosticsText(text);
}
