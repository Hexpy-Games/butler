import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const APP_FOREGROUND_INSTANCE_SCHEMA = "butler.app-foreground-instance.v1";
export const APP_FOREGROUND_LAST_EXIT_SCHEMA = "butler.app-foreground-last-exit.v1";
export const APP_FOREGROUND_STARTUP_FAILURE_SCHEMA =
  "butler.app-foreground-startup-failure.v1";
export const APP_FOREGROUND_STARTUP_PROGRESS_SCHEMA =
  "butler.app-foreground-startup-progress.v1";
export const APP_FOREGROUND_MIGRATION_SCHEMA = "butler.app-foreground-legacy-migration.v1";
export const APP_FOREGROUND_LIFECYCLE_MODES = Object.freeze({
  foreground: "app-foreground",
  nativeService: "native-service",
});

export const APP_FOREGROUND_PHASES = Object.freeze([
  "not_started",
  "migrating_legacy_service",
  "preparing",
  "starting",
  "ready",
  "degraded",
  "draining",
  "stopping",
  "stopped",
  "recovering",
  "update_pending",
  "failed",
]);

const transitions = new Map([
  ["not_started", new Set(["migrating_legacy_service", "preparing"])],
  ["migrating_legacy_service", new Set(["preparing", "failed", "stopped"])],
  ["preparing", new Set(["starting", "failed", "stopped"])],
  ["starting", new Set(["ready", "recovering", "failed", "stopping"])],
  ["ready", new Set(["degraded", "draining", "stopping", "update_pending"])],
  ["degraded", new Set(["recovering", "draining", "stopping", "failed"])],
  ["recovering", new Set(["starting", "failed", "stopping"])],
  ["update_pending", new Set(["draining", "ready", "failed"])],
  ["draining", new Set(["stopping", "ready", "failed"])],
  ["stopping", new Set(["stopped", "failed"])],
  ["failed", new Set(["preparing", "stopping", "stopped"])],
  ["stopped", new Set(["preparing"])],
]);

export function appForegroundRuntimeDir(butlerData) {
  return join(butlerData, "app", "runtime", "foreground");
}

export function appForegroundInstancePath(butlerData) {
  return join(appForegroundRuntimeDir(butlerData), "instance.json");
}

export function appForegroundLastExitPath(butlerData) {
  return join(appForegroundRuntimeDir(butlerData), "last-exit.json");
}

export function appForegroundStartupFailurePath(butlerData) {
  return join(appForegroundRuntimeDir(butlerData), "startup-failure.json");
}

export function appForegroundStartupProgressPath(butlerData) {
  return join(appForegroundRuntimeDir(butlerData), "startup-progress.json");
}

export function clearAppForegroundStartupFailure(butlerData) {
  rmSync(appForegroundStartupFailurePath(butlerData), { force: true });
}

export function appForegroundMigrationPath(butlerData) {
  return join(appForegroundRuntimeDir(butlerData), "legacy-migration.json");
}

export function resolveAppLifecycleMode({
  platform = process.platform,
  isPackaged = false,
  releaseMode = null,
  env = process.env,
} = {}) {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    return APP_FOREGROUND_LIFECYCLE_MODES.nativeService;
  }
  const testOverride = env.BUTLER_APP_AGENT_LIFECYCLE_MODE?.trim();
  if (testOverride) {
    if (env.BUTLER_APP_ALLOW_LIFECYCLE_TEST_OVERRIDE !== "1") {
      throw new Error("App lifecycle override requires isolated-test consent");
    }
    return assertLifecycleMode(testOverride);
  }
  if (!isPackaged) return APP_FOREGROUND_LIFECYCLE_MODES.foreground;
  return assertLifecycleMode(releaseMode ?? APP_FOREGROUND_LIFECYCLE_MODES.foreground);
}

export function createAppForegroundLaunch({
  appVersion,
  bundledAgentVersion,
  gatewayProfile = "electron",
  host = "127.0.0.1",
  port,
  appPid = process.pid,
  platform = process.platform,
  architecture = process.arch,
  now = () => new Date(),
  generateGeneration = () => randomUUID(),
  generateNonce = () => randomBytes(32).toString("base64url"),
} = {}) {
  const generation = generateGeneration();
  const nonce = generateNonce();
  return {
    nonce,
    record: {
      schema: APP_FOREGROUND_INSTANCE_SCHEMA,
      generation,
      state: "preparing",
      app_pid: appPid,
      agent_host_pid: null,
      process_group_id: null,
      platform: safeString(platform),
      architecture: safeString(architecture),
      containment_kind: null,
      containment_verified: false,
      owner_death_guaranteed: false,
      launch_nonce_hash: createHash("sha256").update(nonce).digest("hex"),
      app_version: safeString(appVersion),
      bundled_agent_version: safeString(bundledAgentVersion),
      gateway_profile: gatewayProfile,
      host,
      port: validPort(port),
      started_at: now().toISOString(),
      updated_at: now().toISOString(),
      clean_exit: false,
      raw_text_included: false,
    },
  };
}

export function transitionAppForeground(record, nextState, {
  generation = record?.generation,
  now = () => new Date(),
  patch = {},
} = {}) {
  if (!record || record.schema !== APP_FOREGROUND_INSTANCE_SCHEMA) {
    throw new Error("invalid App foreground instance record");
  }
  if (generation !== record.generation) {
    throw new Error("stale App foreground generation");
  }
  if (!APP_FOREGROUND_PHASES.includes(nextState)) {
    throw new Error(`invalid App foreground state: ${nextState}`);
  }
  if (nextState !== record.state && !transitions.get(record.state)?.has(nextState)) {
    throw new Error(`invalid App foreground transition: ${record.state} -> ${nextState}`);
  }
  return {
    ...record,
    ...sanitizeLifecyclePatch(patch),
    state: nextState,
    updated_at: now().toISOString(),
    raw_text_included: false,
  };
}

export function writeAppForegroundInstance(butlerData, record) {
  assertInstanceRecord(record);
  atomicWriteJson(appForegroundInstancePath(butlerData), record);
  return record;
}

export function readAppForegroundInstance(butlerData) {
  const record = readJson(appForegroundInstancePath(butlerData));
  return validInstanceRecord(record) ? record : null;
}

export function writeAppForegroundLastExit(butlerData, input, now = () => new Date()) {
  const record = {
    schema: APP_FOREGROUND_LAST_EXIT_SCHEMA,
    generation: safeString(input?.generation),
    exit_reason: safeString(input?.exitReason) ?? "unknown",
    graceful: input?.graceful === true,
    checkpoint_result: safeString(input?.checkpointResult),
    process_group_dead: input?.processGroupDead === true,
    process_tree_dead:
      input?.processTreeDead === true || input?.processGroupDead === true,
    port_released: input?.portReleased === true,
    error_code: safeErrorCode(input?.errorCode),
    exited_at: now().toISOString(),
    raw_text_included: false,
  };
  atomicWriteJson(appForegroundLastExitPath(butlerData), record);
  return record;
}

export function writeAppForegroundStartupFailure(
  butlerData,
  input,
  now = () => new Date(),
) {
  const record = {
    schema: APP_FOREGROUND_STARTUP_FAILURE_SCHEMA,
    platform: safeString(input?.platform),
    architecture: safeString(input?.architecture),
    lifecycle_mode: safeString(input?.lifecycleMode),
    supervisor_phase: safeString(input?.supervisorPhase),
    error_code: safeErrorCode(input?.errorCode) ?? "app_startup_failed",
    exit_code: Number.isInteger(input?.exitCode) ? input.exitCode : null,
    signal: safeErrorCode(input?.signal),
    containment_kind: safeString(input?.containmentKind),
    containment_verified: input?.containmentVerified === true,
    owner_death_guaranteed: input?.ownerDeathGuaranteed === true,
    failed_at: now().toISOString(),
    raw_text_included: false,
  };
  atomicWriteJson(appForegroundStartupFailurePath(butlerData), record);
  return record;
}

export function writeAppForegroundStartupProgress(
  butlerData,
  input,
  now = () => new Date(),
) {
  const record = {
    schema: APP_FOREGROUND_STARTUP_PROGRESS_SCHEMA,
    stage: safeErrorCode(input?.stage) ?? "unknown",
    platform: safeString(input?.platform),
    architecture: safeString(input?.architecture),
    lifecycle_mode: safeString(input?.lifecycleMode),
    agent_phase: safeErrorCode(input?.agentPhase),
    containment_kind: safeString(input?.containmentKind),
    tray_ready: input?.trayReady === true,
    window_ready: input?.windowReady === true,
    updated_at: now().toISOString(),
    raw_text_included: false,
  };
  atomicWriteJson(appForegroundStartupProgressPath(butlerData), record);
  return record;
}

export function writeAppForegroundMigration(butlerData, input, now = () => new Date()) {
  const record = {
    schema: APP_FOREGROUND_MIGRATION_SCHEMA,
    generation: safeString(input?.generation) ?? randomUUID(),
    status: safeString(input?.status) ?? "pending",
    detected_artifacts: Array.isArray(input?.detectedArtifacts)
      ? input.detectedArtifacts.map(safeString).filter(Boolean)
      : [],
    active_work_classification: safeString(input?.activeWorkClassification),
    consent: safeString(input?.consent),
    cleanup_steps: Array.isArray(input?.cleanupSteps) ? input.cleanupSteps : [],
    residual_artifacts: Array.isArray(input?.residualArtifacts)
      ? input.residualArtifacts.map(safeString).filter(Boolean)
      : [],
    started_at: input?.startedAt ?? now().toISOString(),
    completed_at: input?.status === "complete" ? now().toISOString() : null,
    last_error_code: safeErrorCode(input?.errorCode),
    raw_text_included: false,
  };
  atomicWriteJson(appForegroundMigrationPath(butlerData), record);
  return record;
}

export function createRecoveryBudget({ maxAttempts = 3, windowMs = 60_000 } = {}) {
  const attempts = [];
  return {
    record(nowMs = Date.now()) {
      while (attempts.length > 0 && nowMs - attempts[0] >= windowMs) attempts.shift();
      if (attempts.length >= maxAttempts) return false;
      attempts.push(nowMs);
      return true;
    },
    remaining(nowMs = Date.now()) {
      while (attempts.length > 0 && nowMs - attempts[0] >= windowMs) attempts.shift();
      return Math.max(0, maxAttempts - attempts.length);
    },
  };
}

function assertLifecycleMode(value) {
  if (!Object.values(APP_FOREGROUND_LIFECYCLE_MODES).includes(value)) {
    throw new Error(`invalid App lifecycle mode: ${value}`);
  }
  return value;
}

function sanitizeLifecyclePatch(patch) {
  const allowed = {};
  if (Number.isInteger(patch.agent_host_pid) && patch.agent_host_pid > 0) {
    allowed.agent_host_pid = patch.agent_host_pid;
  }
  if (Number.isInteger(patch.process_group_id) && patch.process_group_id > 0) {
    allowed.process_group_id = patch.process_group_id;
  }
  if (typeof patch.containment_kind === "string" && patch.containment_kind.trim()) {
    allowed.containment_kind = patch.containment_kind.trim().slice(0, 80);
  }
  if (typeof patch.containment_verified === "boolean") {
    allowed.containment_verified = patch.containment_verified;
  }
  if (typeof patch.owner_death_guaranteed === "boolean") {
    allowed.owner_death_guaranteed = patch.owner_death_guaranteed;
  }
  if (typeof patch.clean_exit === "boolean") allowed.clean_exit = patch.clean_exit;
  return allowed;
}

function validInstanceRecord(record) {
  return record?.schema === APP_FOREGROUND_INSTANCE_SCHEMA &&
    typeof record.generation === "string" &&
    APP_FOREGROUND_PHASES.includes(record.state) &&
    Number.isInteger(record.app_pid) &&
    record.app_pid > 0 &&
    record.raw_text_included === false;
}

function assertInstanceRecord(record) {
  if (!validInstanceRecord(record)) throw new Error("invalid App foreground instance record");
}

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : null;
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeErrorCode(value) {
  const code = safeString(value);
  return code?.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 120) ?? null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}
