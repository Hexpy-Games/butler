export function createFirstRunSetupBridge({
  ensureReady,
  readSettings,
  readRuntimeDiagnostics = () => ({}),
  gatewayProfile = "electron",
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
        await ensureReady();
        if (!isActiveRun(currentRunId, runId, session)) return statusView(session);
        if (currentSession.cancelled) return statusView(currentSession);
        markCheck(
          currentSession,
          "managed_gateway",
          "passed",
        );
        const diagnostics = readRuntimeDiagnostics();
        if (!bundledAgentVersionReady(diagnostics)) {
          throw setupError("bundled_agent_version_missing");
        }
        markCheck(currentSession, "bundled_agent_version", "passed");
        if (diagnostics?.local_auth?.required !== true ||
          diagnostics?.local_auth?.token_configured !== true) {
          throw setupError("local_auth_unavailable");
        }
        markCheck(currentSession, "local_auth", "passed");
        if (diagnostics?.phase !== "running") {
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
        session = createSession("failed", {
          checks: failPendingChecks(currentSession.checks),
          errorCode: setupErrorCode(error),
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
      ? [{ code: session.errorCode, message: statusLabel(session) }]
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
    error?.code === "gateway_profile_mismatch" ||
    error?.code === "bundled_agent_version_missing" ||
    error?.code === "local_auth_unavailable" ||
    error?.code === "health_unavailable"
  ) {
    return error.code;
  }
  return "setup_failed";
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
