import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const APP_LOCAL_AUTH_SCHEMA = "butler.app-local-agent-auth.v1";

export function appLocalAuthPath(butlerData) {
  return join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
}

export function prepareAppLocalAuth({
  butlerData,
  now = () => new Date(),
  generateToken = () => randomBytes(32).toString("base64url"),
}) {
  const path = appLocalAuthPath(butlerData);
  const existing = readJsonIfPresent(path);
  if (
    existing?.schema === APP_LOCAL_AUTH_SCHEMA &&
    typeof existing.token === "string" &&
    existing.token.length >= 32
  ) {
    return {
      filePath: path,
      created: false,
      token: existing.token,
    };
  }
  const token = generateToken();
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("App local auth token generation failed");
  }
  atomicWriteJson(path, {
    schema: APP_LOCAL_AUTH_SCHEMA,
    product: "butler-app",
    purpose: "bundled-agent-local-auth",
    token,
    created_at: now().toISOString(),
    raw_text_included: false,
  });
  return {
    filePath: path,
    created: true,
    token,
  };
}

export function buildBundledAgentSupervisorEnv({
  baseEnv = process.env,
  gatewayEnv = {},
  port,
  serverUrl,
  appVersion,
  rendererOrigin,
  explicitUiUrl = null,
  projectFolderTokenSecret,
  localAuth,
}) {
  return {
    ...baseEnv,
    ...gatewayEnv,
    BUTLER_APP_SERVER_HOST: "127.0.0.1",
    BUTLER_APP_SERVER_PORT: String(port),
    BUTLER_APP_SERVER_URL: serverUrl,
    BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_APP_BUNDLED_SUPERVISOR: "1",
    BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
    BUTLER_APP_LOCAL_AUTH_FILE: localAuth.filePath,
    ...(safeString(appVersion) ? { BUTLER_APP_VERSION: safeString(appVersion) } : {}),
    ...(explicitUiUrl ? { BUTLER_APP_DEV_ORIGIN: rendererOrigin } : {}),
    ...(projectFolderTokenSecret
      ? { BUTLER_PROJECT_FOLDER_TOKEN_SECRET: projectFolderTokenSecret }
      : {}),
  };
}

export function createBundledAgentSupervisor({
  butlerData,
  resolveGateway,
  spawnProcess,
  healthCheck,
  readinessCheck = async () => true,
  isPortAvailable,
  findAvailablePort,
  updatePort,
  getPort,
  getServerUrl,
  getAppVersion = () => null,
  getRendererOrigin,
  explicitServerUrl = null,
  explicitUiUrl = null,
  projectFolderTokenSecret = null,
  baseEnv = process.env,
  sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMs = () => Date.now(),
  setKillTimer = (fn, ms) => setTimeout(fn, ms),
  clearKillTimer = (timer) => clearTimeout(timer),
  startupAttempts = 60,
  startupDelayMs = 150,
  startupTimeoutMs = null,
  killTimeoutMs = 2000,
  probeTimeoutMs = 2000,
  stdio = "inherit",
  onUnexpectedExit = () => {},
  onGatewayStarting = () => {},
}) {
  let child = null;
  let startupPromise = null;
  let shutdownKillTimer = null;
  let phase = "idle";
  let lastErrorCode = null;
  let lastErrorDetails = null;
  let lastExit = null;
  let localAuth = null;
  let activeGateway = null;
  let readyGateway = null;

  async function ensureReady() {
    localAuth = localAuth ?? prepareAppLocalAuth({ butlerData });
    if (explicitServerUrl) {
      await waitForExplicitServerReady();
      return;
    }
    if (child && (await checkGatewayReadiness()).ready) {
      phase = "running";
      return;
    }
    if (startupPromise) return startupPromise;
    let gateway;
    try {
      gateway = readyGateway ?? resolveGateway();
    } catch (error) {
      recordError("gateway_unavailable", {
        reason: "resolve_gateway_failed",
        error_code:
          error && typeof error === "object" && typeof error.code === "string"
            ? error.code
            : null,
      });
      throw error;
    }
    activeGateway = gateway;
    if ((await checkGatewayReadiness()).ready) {
      if (!gateway.commitActivation) {
        phase = "running";
        readyGateway = gateway;
        return;
      }
      updatePort(await findAvailablePort(getPort() + 1));
    }
    if (!(await isPortAvailable(getPort()))) {
      updatePort(await findAvailablePort(getPort() + 1));
    }
    startupPromise = start(gateway);
    try {
      await startupPromise;
    } finally {
      startupPromise = null;
    }
  }

  async function waitForExplicitServerReady() {
    let observedHealthy = false;
    const startupWindow = createStartupWindow();
    while (startupWindow.canAttempt()) {
      startupWindow.recordAttempt();
      const state = await checkGatewayReadiness();
      observedHealthy = observedHealthy || state.healthy;
      if (state.ready) {
        phase = "running";
        lastErrorCode = null;
        lastErrorDetails = null;
        return;
      }
      await startupWindow.waitBeforeRetry();
    }
    recordError(observedHealthy ? "external_not_ready" : "external_unhealthy", {
      attempts: startupWindow.attempts(),
      server_url: explicitServerUrl,
    });
    throw new Error(`Butler app server is not healthy: ${explicitServerUrl}`);
  }

  async function start(gateway = resolveGateway()) {
    if (child) {
      recordError("already_starting");
      throw new Error("Butler app server is already starting but is not healthy yet.");
    }
    phase = "starting";
    activeGateway = gateway;
    lastErrorCode = null;
    lastExit = null;
    localAuth = localAuth ?? prepareAppLocalAuth({ butlerData });
    onGatewayStarting(gateway);
    const env = buildBundledAgentSupervisorEnv({
      baseEnv,
      gatewayEnv: gateway.env,
      port: getPort(),
      serverUrl: getServerUrl(),
      appVersion: getAppVersion(),
      rendererOrigin: getRendererOrigin(),
      explicitUiUrl,
      projectFolderTokenSecret,
      localAuth,
    });
    try {
      gateway.publishLaunchPointer?.();
      child = spawnProcess(gateway.command, gateway.args, {
        ...(gateway.cwd ? { cwd: gateway.cwd } : {}),
        env,
        stdio: gateway.stdio ?? stdio,
        detached: gateway.detached === true,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      rollbackGatewayActivation(gateway, error);
      recordError("spawn_failed", {
        reason: "process_start_failed",
        error_code:
          error && typeof error === "object" && typeof error.code === "string"
            ? error.code
            : null,
      });
      throw error;
    }
    let spawnError = null;
    let earlyExit = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      const wasRunning = phase === "running";
      earlyExit = { code, signal };
      lastExit = earlyExit;
      clearShutdownTimer();
      child = null;
      if (phase !== "stopping") phase = "stopped";
      if (wasRunning) {
        invalidateGatewayRuntimeReceipt(gateway);
        if (readyGateway === gateway) readyGateway = null;
        if (activeGateway === gateway) activeGateway = null;
        queueMicrotask(() => onUnexpectedExit(earlyExit));
      }
    });

    let observedHealthy = false;
    const startupWindow = createStartupWindow();
    while (startupWindow.canAttempt()) {
      startupWindow.recordAttempt();
      const state = await checkGatewayReadiness();
      observedHealthy = observedHealthy || state.healthy;
      if (state.ready) {
        try {
          gateway.commitActivation?.();
        } catch (error) {
          const activationError = normalizeError(error, "App-managed Agent activation commit failed");
          await stopCandidateAfterStartupFailure();
          rollbackGatewayActivation(gateway, activationError);
          recordError("activation_commit_failed", {
            reason: "commit_activation_failed",
            error_code:
              error && typeof error === "object" && typeof error.code === "string"
                ? error.code
                : null,
          });
          throw activationError;
        }
        phase = "running";
        readyGateway = gateway;
        return;
      }
      if (spawnError) {
        recordError("spawn_failed", {
          reason: "process_start_failed",
          error_code: typeof spawnError.code === "string" ? spawnError.code : null,
        });
        rollbackGatewayActivation(gateway, spawnError);
        throw new Error(`Failed to start Butler app server: ${spawnError.message}`);
      }
      if (earlyExit) {
        recordError("early_exit", {
          exit_code: earlyExit.code,
          signal: earlyExit.signal,
        });
        rollbackGatewayActivation(
          gateway,
          new Error(
            `Butler app server exited before becoming healthy: code=${earlyExit.code ?? "null"} signal=${earlyExit.signal ?? "null"}.`,
          ),
        );
        throw new Error(
          `Butler app server exited before becoming healthy: code=${earlyExit.code ?? "null"} signal=${earlyExit.signal ?? "null"}.`,
        );
      }
      await startupWindow.waitBeforeRetry();
    }
    const errorCode = observedHealthy ? "readiness_timeout" : "health_timeout";
    const timeoutError = new Error(
      `Timed out waiting for Butler app server at ${getServerUrl()}.`,
    );
    await stopCandidateAfterStartupFailure();
    rollbackGatewayActivation(gateway, timeoutError);
    recordError(errorCode, {
      attempts: startupWindow.attempts(),
      host: "127.0.0.1",
      port: getPort(),
    });
    throw timeoutError;
  }

  async function restart() {
    await stop({ wait: true });
    await ensureReady();
  }

  async function repair() {
    await stop({ wait: true });
    invalidateGatewayRuntimeReceipt(readyGateway ?? activeGateway);
    readyGateway = null;
    activeGateway = null;
    lastErrorCode = null;
    lastErrorDetails = null;
    lastExit = null;
    phase = "idle";
    await ensureReady();
  }

  async function stop({ wait = false } = {}) {
    if (!child) {
      phase = "stopped";
      return {
        stopped: true,
        containment_released:
          activeGateway === null || activeGateway.containmentVerified === true,
        raw_text_included: false,
      };
    }
    phase = "stopping";
    const stopping = child;
    stopping.kill("SIGTERM");
    shutdownKillTimer = setKillTimer(() => {
      if (child === stopping) stopping.kill("SIGKILL");
    }, killTimeoutMs);
    if (wait) {
      await new Promise((resolve) => stopping.once("exit", resolve));
      if (child === null) phase = "stopped";
    }
    return {
      stopped: child === null,
      containment_released: wait && child === null &&
        activeGateway?.containmentVerified === true,
      raw_text_included: false,
    };
  }

  function diagnostics() {
    return {
      phase,
      pid: typeof child?.pid === "number" ? child.pid : null,
      binding: {
        host: "127.0.0.1",
        port: getPort(),
      },
      containment: {
        kind: activeGateway?.containmentKind ?? "direct_child",
        verified: activeGateway?.containmentVerified === true,
        owner_death_guaranteed: activeGateway?.ownerDeathGuaranteed === true,
        raw_text_included: false,
      },
      lifecycle_patch: {
        agent_host_pid: typeof child?.pid === "number" ? child.pid : null,
        process_group_id:
          activeGateway?.recordsProcessGroupId === true &&
            typeof child?.pid === "number"
            ? child.pid
            : null,
        containment_kind: activeGateway?.containmentKind ?? "direct_child",
        containment_verified: activeGateway?.containmentVerified === true,
        owner_death_guaranteed: activeGateway?.ownerDeathGuaranteed === true,
      },
      bundled_agent: {
        source: activeGateway?.appManaged ? "app-managed" : "development",
        version: activeGateway?.bundledAgentVersion ?? null,
        version_configured: Boolean(activeGateway?.bundledAgentVersion),
      },
      local_auth: {
        required: true,
        file_configured: Boolean(localAuth?.filePath),
        token_configured: Boolean(localAuth?.token),
        raw_text_included: false,
      },
      last_error_code: lastErrorCode,
      last_error: lastErrorCode
        ? {
          code: lastErrorCode,
          details: lastErrorDetails ?? {},
          raw_text_included: false,
        }
        : null,
      last_exit: lastExit,
      raw_text_included: false,
    };
  }

  function authHeaders() {
    localAuth = localAuth ?? prepareAppLocalAuth({ butlerData });
    return localAuth.token
      ? { authorization: `Bearer ${localAuth.token}` }
      : {};
  }

  function clearShutdownTimer() {
    if (!shutdownKillTimer) return;
    clearKillTimer(shutdownKillTimer);
    shutdownKillTimer = null;
  }

  function recordError(code, details = null) {
    lastErrorCode = code;
    lastErrorDetails = details;
    phase = "failed";
  }

  function createStartupWindow() {
    const usesDeadline = Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0;
    const deadline = usesDeadline ? nowMs() + startupTimeoutMs : null;
    let attempts = 0;
    return {
      attempts: () => attempts,
      canAttempt: () =>
        attempts === 0 || (usesDeadline ? nowMs() < deadline : attempts < startupAttempts),
      recordAttempt: () => {
        attempts += 1;
      },
      waitBeforeRetry: async () => {
        const canRetry = usesDeadline
          ? nowMs() < deadline
          : attempts < startupAttempts;
        if (!canRetry) return;
        const delay = usesDeadline
          ? Math.min(startupDelayMs, Math.max(0, deadline - nowMs()))
          : startupDelayMs;
        if (delay > 0) await sleepMs(delay);
      },
    };
  }

  async function checkGatewayReadiness() {
    const health = await runBoundedProbe(() => healthCheck(localAuth));
    const healthy = health.value;
    if (!healthy) {
      return { healthy: false, ready: false, timedOut: health.timedOut };
    }
    const readiness = await runBoundedProbe(() => readinessCheck(localAuth, activeGateway));
    return {
      healthy: true,
      ready: readiness.value,
      timedOut: readiness.timedOut,
    };
  }

  async function runBoundedProbe(probe) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, value: false }), probeTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(probe)
          .then(
            (value) => ({ timedOut: false, value: value === true }),
            () => ({ timedOut: false, value: false }),
          ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function stopCandidateAfterStartupFailure() {
    if (!child) return;
    await stop({ wait: true });
  }

  function rollbackGatewayActivation(gateway, error) {
    if (readyGateway === gateway) readyGateway = null;
    try {
      gateway.rollbackActivation?.(error);
    } catch {
      // Keep the supervisor failure focused on the startup error.
    }
  }

  function invalidateGatewayRuntimeReceipt(gateway) {
    try {
      gateway?.invalidateRuntimeReceipt?.();
    } catch {
      // Recovery still needs to replace the stopped gateway.
    }
  }

  function normalizeError(error, fallbackMessage) {
    return error instanceof Error ? error : new Error(fallbackMessage);
  }

  return {
    authHeaders,
    diagnostics,
    ensureReady,
    repair,
    restart,
    start,
    stop,
  };
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tempPath, path);
}
