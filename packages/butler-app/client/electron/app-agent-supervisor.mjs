import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_RESTART_RECONNECT_TIMEOUT_MS,
  AGENT_STOP_KILL_TIMEOUT_MS,
  decideAgentExit,
  processIsAlive,
  readAgentStopIntent,
  readNativeServiceInstance,
  retractAgentStopIntent,
  selectReplacementInstance,
  writeAgentStopIntent,
} from "./app-agent-stop-intent.mjs";

export const APP_LOCAL_AUTH_SCHEMA = "butler.app-local-agent-auth.v1";

export function appLocalAuthPath(butlerData) {
  return join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
}

/**
 * Reads the DATA-owned local auth file without writing it. App-spawned and
 * CLI-started Agents read the same file, so any token-bearing file is reused
 * rather than overwritten, whichever side created it.
 */
export function readAppLocalAuth({ butlerData }) {
  const path = appLocalAuthPath(butlerData);
  const existing = readJsonIfPresent(path);
  if (typeof existing?.token !== "string" || existing.token.length < 32) return null;
  return {
    filePath: path,
    created: false,
    token: existing.token,
  };
}

export function prepareAppLocalAuth({
  butlerData,
  now = () => new Date(),
  generateToken = () => randomBytes(32).toString("base64url"),
}) {
  const path = appLocalAuthPath(butlerData);
  const existing = readAppLocalAuth({ butlerData });
  if (existing) return existing;
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
  // SIGTERM → SIGKILL grace, the same as the CLI/MCP controllers: an Agent
  // still draining an announced stop exits 0 by itself at 6 s (#244).
  killTimeoutMs = AGENT_STOP_KILL_TIMEOUT_MS,
  probeTimeoutMs = 2000,
  stdio = "inherit",
  onUnexpectedExit = () => {},
  onGatewayStarting = () => {},
  readStopIntent = () => readAgentStopIntent(butlerData),
  writeStopIntent = (intent) => writeAgentStopIntent(butlerData, intent),
  retractStopIntent = (target) => retractAgentStopIntent(butlerData, target),
  readInstanceRecord = () => readNativeServiceInstance(butlerData),
  isProcessAlive = (pid) => processIsAlive(pid),
  restartReconnectTimeoutMs = AGENT_RESTART_RECONNECT_TIMEOUT_MS,
  externalPollMs = 1000,
  schedulePoll = defaultSchedulePoll,
  cancelPoll = (timer) => clearTimeout(timer),
  onIntentionalExit = () => {},
  onExternalAttach = () => {},
  onRestartReconnectFailed = () => {},
}) {
  let child = null;
  let childSpawnError = null;
  let startupPromise = null;
  let shutdownKillTimer = null;
  let phase = "idle";
  let lastErrorCode = null;
  let lastErrorDetails = null;
  let lastExit = null;
  let localAuth = null;
  let activeGateway = null;
  let readyGateway = null;
  // Identity ({ instanceId, appSupervised }) of the spawned child, remembered
  // as soon as its native service record shows the child's pid.
  let childInstance = null;
  // A ready Agent this App did not spawn (external start/restart, or launch adoption).
  let attached = null;
  // An intentional external stop or a timed-out external restart. Only an
  // explicit start/restart from the App (or an external start) clears it.
  let halt = null;
  let restartWait = null;
  let exitGeneration = 0;
  // A CLI/MCP restart left the App's child to the App (`respawn_by: app`).
  let respawning = false;
  // Counts intentional restarts (respawn or wait) seen at an Agent exit.
  let restartGeneration = 0;
  let lastExited = null;
  let pollTimer = null;

  async function ensureReady() {
    for (;;) {
      const generation = restartGeneration;
      try {
        await sharedStartup();
        return;
      } catch (error) {
        // An intentional restart replaced the candidate mid-startup: hand the
        // caller its replacement instead of the startup failure.
        if (generation === restartGeneration || !(respawning || restartWait)) throw error;
      }
    }
  }

  function sharedStartup() {
    if (!startupPromise) {
      const operation = ensureReadyOnce().finally(() => {
        if (startupPromise === operation) startupPromise = null;
      });
      startupPromise = operation;
    }
    return startupPromise;
  }

  async function ensureReadyOnce() {
    localAuth = localAuth ?? prepareAppLocalAuth({ butlerData });
    if (explicitServerUrl) {
      await waitForExplicitServerReady();
      return;
    }
    reconcileAttachedExit();
    if (halt) throw haltError();
    if (restartWait) {
      await restartWait;
      return;
    }
    if (child) {
      await adoptOwnedChild(child, activeGateway ?? readyGateway);
      return;
    }
    if (attached && (await checkGatewayReadiness()).ready) {
      phase = "running";
      return;
    }
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
        adoptListenerIdentity();
        return;
      }
      updatePort(await findAvailablePort(getPort() + 1));
    }
    if (!gateway.commitActivation && await attachReplacement(null)) {
      readyGateway = gateway;
      return;
    }
    if (!(await isPortAvailable(getPort()))) {
      updatePort(await findAvailablePort(getPort() + 1));
    }
    await start(gateway);
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

  async function adoptOwnedChild(candidate, gateway) {
    let observedHealthy = false;
    const startupWindow = createStartupWindow();
    while (startupWindow.canAttempt()) {
      throwIfCandidateFailed(
        gateway,
        childSpawnError,
        child === candidate ? null : lastExit ?? { code: null, signal: null },
      );
      startupWindow.recordAttempt();
      rememberChildInstance();
      const state = await checkGatewayReadiness();
      observedHealthy = observedHealthy || state.healthy;
      throwIfCandidateFailed(
        gateway,
        childSpawnError,
        child === candidate ? null : lastExit ?? { code: null, signal: null },
      );
      rememberChildInstance();
      if (state.ready) {
        await acceptReadyCandidate(gateway, {
          commitActivation: readyGateway !== gateway,
        });
        return;
      }
      await startupWindow.waitBeforeRetry();
    }
    await throwCandidateStartupTimeout(gateway, observedHealthy, startupWindow);
  }

  function throwIfCandidateFailed(gateway, spawnError, exit) {
    if (spawnError) {
      recordError("spawn_failed", {
        reason: "process_start_failed",
        error_code: typeof spawnError.code === "string" ? spawnError.code : null,
      });
      rollbackGatewayActivation(gateway, spawnError);
      throw new Error(`Failed to start Butler app server: ${spawnError.message}`);
    }
    if (!exit) return;
    if (halt?.reason === "stop") {
      // A stop requested while the Agent was still starting (it exits 0).
      const stopped = haltError();
      rollbackGatewayActivation(gateway, stopped);
      throw stopped;
    }
    if (respawning || restartWait) {
      // A restart requested while the Agent was still starting; ensureReady
      // hands its caller the replacement.
      const restarting = new Error("Butler Agent is restarting.");
      restarting.code = "agent_restarting";
      rollbackGatewayActivation(gateway, restarting);
      throw restarting;
    }
    const error = new Error(
      `Butler app server exited before becoming healthy: code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}.`,
    );
    recordError("early_exit", {
      exit_code: exit.code,
      signal: exit.signal,
    });
    rollbackGatewayActivation(gateway, error);
    throw error;
  }

  async function throwCandidateStartupTimeout(gateway, observedHealthy, startupWindow) {
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

  async function acceptReadyCandidate(gateway, { commitActivation }) {
    if (commitActivation) {
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
    }
    phase = "running";
    readyGateway = gateway;
    lastErrorCode = null;
    lastErrorDetails = null;
    respawning = false;
    rememberChildInstance();
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
    childSpawnError = null;
    childInstance = null;
    attached = null;
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
    let earlyExit = null;
    const spawned = child;
    child.once("error", (error) => {
      childSpawnError = error;
    });
    child.once("exit", (code, signal) => {
      const wasRunning = phase === "running";
      const appRequested = phase === "stopping";
      const pid = typeof spawned.pid === "number" ? spawned.pid : null;
      const identity = (child === spawned ? childInstance : null) ?? instanceForPid(pid);
      const exited = {
        pid,
        instanceId: identity?.instanceId ?? null,
        appSupervised: identity?.appSupervised === true,
        spawnedByApp: true,
      };
      earlyExit = { code, signal };
      lastExit = earlyExit;
      clearShutdownTimer();
      child = null;
      childInstance = null;
      if (phase !== "stopping") phase = "stopped";
      if (wasRunning) {
        invalidateGatewayRuntimeReceipt(gateway);
        if (readyGateway === gateway) readyGateway = null;
        if (activeGateway === gateway) activeGateway = null;
      }
      if (!appRequested) handleAgentExit(exited, earlyExit, { wasRunning });
    });

    let observedHealthy = false;
    const startupWindow = createStartupWindow();
    while (startupWindow.canAttempt()) {
      startupWindow.recordAttempt();
      rememberChildInstance();
      const state = await checkGatewayReadiness();
      observedHealthy = observedHealthy || state.healthy;
      throwIfCandidateFailed(gateway, childSpawnError, earlyExit);
      rememberChildInstance();
      if (state.ready) {
        await acceptReadyCandidate(gateway, { commitActivation: true });
        return;
      }
      await startupWindow.waitBeforeRetry();
    }
    await throwCandidateStartupTimeout(gateway, observedHealthy, startupWindow);
  }

  async function restart() {
    await stop({ wait: true, reason: "restart" });
    halt = null;
    await ensureReady();
  }

  async function resume() {
    halt = null;
    lastErrorCode = null;
    lastErrorDetails = null;
    await ensureReady();
  }

  async function repair() {
    await stop({ wait: true, reason: "restart" });
    halt = null;
    invalidateGatewayRuntimeReceipt(readyGateway ?? activeGateway);
    readyGateway = null;
    activeGateway = null;
    lastErrorCode = null;
    lastErrorDetails = null;
    lastExit = null;
    phase = "idle";
    await ensureReady();
  }

  async function stop({ wait = false, reason = "stop" } = {}) {
    cancelRestartWait();
    cancelPollTick();
    respawning = false;
    // An attached Agent was not spawned by this App. Its record pid alone is
    // not authority to signal it, so the App only detaches from it.
    attached = null;
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
    const intent = recordAppStopIntent(stopping, reason);
    // TODO(#223): on Windows, child.kill() terminates the Agent without a clean
    // exit. Stop it with `butler-agent service stop --requested-by app` there.
    if (!deliverSignal(stopping, "SIGTERM") && intent) safeRetractStopIntent(intent);
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
      agent_state: agentState().state,
      external_agent_attached: attached !== null,
      raw_text_included: false,
    };
  }

  function agentState() {
    let state;
    if (halt?.reason === "stop") state = "stopped";
    else if (halt?.reason === "restart_timeout") state = "restart_failed";
    else if (restartWait || respawning) state = "restarting";
    else if (["running", "starting", "failed"].includes(phase)) state = phase;
    else state = "idle";
    return {
      state,
      requested_by: halt?.requestedBy ?? null,
      raw_text_included: false,
    };
  }

  // Runs synchronously in the exit handler: the intent is read before any
  // await, timer or respawn, so the next instance cannot clear it first.
  function handleAgentExit(exited, exit, { wasRunning }) {
    lastExited = exited;
    const decision = decideAgentExit({ intent: safeReadStopIntent(), exited });
    if (decision.action === "recover") {
      if (wasRunning) queueMicrotask(() => onUnexpectedExit(exit));
      return;
    }
    const { requestedBy, respawnBy } = decision;
    if (decision.action === "stay_stopped") {
      halt = { reason: "stop", requestedBy };
      phase = "stopped";
      schedulePollTick();
      queueMicrotask(() => onIntentionalExit({ reason: "stop", requestedBy, respawnBy, exit }));
      return;
    }
    restartGeneration += 1;
    if (decision.action === "respawn") {
      // The controller waits for this App to start the replacement with its
      // own environment and lease. No crash budget is spent.
      respawning = true;
      const generation = restartGeneration;
      queueMicrotask(() => onIntentionalExit({ reason: "restart", requestedBy, respawnBy, exit }));
      queueMicrotask(() => {
        if (respawning && generation === restartGeneration) void respawnReplacement();
      });
      return;
    }
    phase = "restarting";
    const wait = awaitReplacement(exited, requestedBy, ++exitGeneration);
    restartWait = wait;
    wait.catch(() => {});
    queueMicrotask(() => onIntentionalExit({ reason: "restart", requestedBy, respawnBy, exit }));
  }

  async function respawnReplacement() {
    try {
      await ensureReady();
    } catch {
      // ensureReady recorded the failure; agentState() and diagnostics report it.
    }
  }

  async function awaitReplacement(exited, requestedBy, generation) {
    const deadline = nowMs() + restartReconnectTimeoutMs;
    try {
      while (generation === exitGeneration) {
        if (await attachReplacement(exited)) return;
        if (nowMs() >= deadline) break;
        await sleepMs(Math.min(externalPollMs, Math.max(0, deadline - nowMs())));
      }
    } finally {
      if (generation === exitGeneration) restartWait = null;
    }
    if (generation !== exitGeneration) return;
    halt = { reason: "restart_timeout", requestedBy };
    recordError("restart_reconnect_timeout", { timeout_ms: restartReconnectTimeoutMs });
    schedulePollTick();
    queueMicrotask(() => onRestartReconnectFailed());
    throw haltError();
  }

  async function attachReplacement(exited) {
    const candidate = selectReplacementInstance(safeReadInstanceRecord(), {
      exitedInstanceId: exited?.instanceId ?? null,
      isProcessAlive,
    });
    if (!candidate) return false;
    if (candidate.port !== getPort()) updatePort(candidate.port);
    // An external Agent authenticates with the DATA-owned auth file, never an
    // App-only in-memory token.
    localAuth = readAppLocalAuth({ butlerData }) ?? localAuth;
    if (!(await checkGatewayReadiness()).ready || child) return false;
    markAttached(candidate);
    return true;
  }

  function adoptListenerIdentity() {
    if (attached || child) return;
    const record = safeReadInstanceRecord();
    if (record?.state !== "ready" || record.port !== getPort()) return;
    if (!isProcessAlive(record.pid)) return;
    markAttached(record);
  }

  // An Agent this App did not spawn is supervised (watched, reconnected) but
  // never owned: the App does not signal or respawn it. `appSupervised` says
  // whether another App holds its lease and will replace it on a restart.
  function markAttached(record) {
    attached = {
      pid: record.pid,
      instanceId: record.instanceId,
      appSupervised: record.appSupervised === true,
    };
    halt = null;
    respawning = false;
    // The replacement arrived: the attach event already reports running.
    restartWait = null;
    phase = "running";
    lastErrorCode = null;
    lastErrorDetails = null;
    schedulePollTick();
    const event = { ...attached, port: getPort() };
    queueMicrotask(() => onExternalAttach(event));
  }

  function reconcileAttachedExit() {
    if (!attached || child || isProcessAlive(attached.pid)) return;
    const exited = { ...attached, spawnedByApp: false };
    attached = null;
    phase = "stopped";
    handleAgentExit(exited, { code: null, signal: null }, { wasRunning: true });
  }

  function schedulePollTick() {
    if (pollTimer !== null) return;
    pollTimer = schedulePoll(() => {
      pollTimer = null;
      return pollTick();
    }, externalPollMs);
  }

  function cancelPollTick() {
    if (pollTimer === null) return;
    cancelPoll(pollTimer);
    pollTimer = null;
  }

  async function pollTick() {
    if (child) return;
    if (attached) reconcileAttachedExit();
    else if (halt && !restartWait) await attachReplacement(lastExited);
    if (!child && (attached || halt)) schedulePollTick();
  }

  function cancelRestartWait() {
    exitGeneration += 1;
    restartWait = null;
  }

  function haltError() {
    const timedOut = halt?.reason === "restart_timeout";
    const error = new Error(timedOut
      ? "Butler Agent did not come back after an external restart."
      : "Butler Agent was stopped.");
    error.code = timedOut ? "agent_restart_timeout" : "agent_stopped";
    return error;
  }

  // The App stops only its own child, so a restart it requests is one it
  // respawns itself (`respawn_by: app`); a plain stop has no respawner.
  function recordAppStopIntent(target, reason) {
    const pid = typeof target?.pid === "number" ? target.pid : null;
    const instanceId = (target === child ? childInstance : null)?.instanceId ??
      instanceForPid(pid)?.instanceId;
    // Without a published instance id the Agent never became observable, so
    // no other supervisor can mistake this exit; skip the intent.
    if (!pid || !instanceId) return null;
    try {
      writeStopIntent({
        reason,
        pid,
        instanceId,
        requestedBy: "app",
        respawnBy: reason === "restart" ? "app" : null,
      });
      return { pid, instanceId };
    } catch {
      // This supervisor already treats the exit as intentional (phase stopping).
      return null;
    }
  }

  function safeRetractStopIntent(target) {
    try {
      retractStopIntent(target);
    } catch {
      // A stale intent names this instance only; the next ready instance clears it.
    }
  }

  function rememberChildInstance() {
    if (!child || childInstance) return;
    childInstance = instanceForPid(child.pid);
  }

  function instanceForPid(pid) {
    const record = safeReadInstanceRecord();
    if (!record || record.pid !== pid) return null;
    return { instanceId: record.instanceId, appSupervised: record.appSupervised === true };
  }

  function safeReadStopIntent() {
    try {
      return readStopIntent();
    } catch {
      return null;
    }
  }

  function safeReadInstanceRecord() {
    try {
      return readInstanceRecord();
    } catch {
      return null;
    }
  }

  function authHeaders() {
    localAuth = localAuth ?? prepareAppLocalAuth({ butlerData });
    return localAuth.token
      ? { authorization: `Bearer ${localAuth.token}` }
      : {};
  }

  /**
   * Re-reads the DATA-owned token file, e.g. after the connection code was
   * rotated. Keeps the last good token when the file is missing or invalid.
   */
  function reloadLocalAuth() {
    const next = readAppLocalAuth({ butlerData });
    if (!next) return false;
    const changed = next.token !== localAuth?.token;
    localAuth = next;
    return changed;
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
    respawning = false;
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
    let health = await runBoundedProbe(() => healthCheck(localAuth));
    // A connection code rotated elsewhere (CLI, browser) leaves this token
    // stale; the data-folder token file holds the new one.
    if (!health.value && reloadLocalAuth()) {
      health = await runBoundedProbe(() => healthCheck(localAuth));
    }
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
    agentState,
    authHeaders,
    diagnostics,
    ensureReady,
    reloadLocalAuth,
    repair,
    restart,
    resume,
    start,
    stop,
  };
}

function deliverSignal(target, signal) {
  try {
    return target.kill(signal) !== false;
  } catch {
    return false;
  }
}

function defaultSchedulePoll(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
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
