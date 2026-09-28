import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Shared contract with the Rust agent/CLI (#223, #244). The CLI, MCP, or the
// App writes this file atomically before it sends SIGTERM and withdraws it if
// SIGTERM cannot be delivered; the next instance deletes it once it is ready.
// The App reads it only when a supervised or attached Agent process exits.
export const AGENT_STOP_INTENT_SCHEMA = "butler.agent-stop-intent.v1";
export const AGENT_STOP_INTENT_REASONS = Object.freeze(["stop", "restart"]);
export const AGENT_STOP_INTENT_REQUESTERS = Object.freeze(["cli", "app", "mcp"]);
// Who starts the replacement after a restart. `app`: the stopped Agent held
// the App's foreground lease, so the App respawns it with its own environment
// (the controller waits for it). `controller`: the CLI/MCP that wrote the
// intent starts it. A restart intent without one (an older writer) means
// `controller`; a stop has none.
export const AGENT_STOP_INTENT_RESPAWNERS = Object.freeze(["app", "controller"]);

// How long the App waits for an external `butler restart` to publish a ready
// replacement before it shows a recoverable error. Agreed with the Rust side:
// it is this long because a cold disk or a data migration can slow startup.
export const AGENT_RESTART_RECONNECT_TIMEOUT_MS = 90_000;

// An Agent whose announced stop is still draining after this long exits 0 by
// itself; every controller (CLI, MCP, the App) sends SIGKILL only after
// AGENT_STOP_KILL_TIMEOUT_MS, so the self-exit lands first.
export const AGENT_STOP_DRAIN_EXIT_MS = 6_000;
export const AGENT_STOP_KILL_TIMEOUT_MS = 8_000;

export const NATIVE_SERVICE_INSTANCE_SCHEMA = "butler.native-agent-service-instance.v1";

const localHosts = new Set(["127.0.0.1", "localhost"]);

export function agentStopIntentPath(butlerData) {
  return join(butlerData, "state", "agent-stop-intent.json");
}

export function nativeServiceInstancePath(butlerData) {
  return join(butlerData, "state", "butler-agent-native-service.json");
}

/** Parses the intent; anything unknown or malformed is null (a crash), never a throw. */
export function parseAgentStopIntent(input) {
  const value = parseJsonObject(input);
  if (!value || value.schema !== AGENT_STOP_INTENT_SCHEMA) return null;
  if (!AGENT_STOP_INTENT_REASONS.includes(value.reason)) return null;
  if (!AGENT_STOP_INTENT_REQUESTERS.includes(value.requested_by)) return null;
  const respawnBy = value.respawn_by ?? null;
  if (respawnBy !== null && !AGENT_STOP_INTENT_RESPAWNERS.includes(respawnBy)) return null;
  if (!nonEmptyString(value.instance_id) || !positivePid(value.pid)) return null;
  if (!nonEmptyString(value.requested_at) || Number.isNaN(Date.parse(value.requested_at))) {
    return null;
  }
  return {
    reason: value.reason,
    requestedBy: value.requested_by,
    respawnBy,
    instanceId: value.instance_id,
    pid: value.pid,
    requestedAt: value.requested_at,
  };
}

export function readAgentStopIntent(butlerData, { readFile = readFileSync } = {}) {
  return parseAgentStopIntent(readText(agentStopIntentPath(butlerData), readFile));
}

export function writeAgentStopIntent(butlerData, {
  reason,
  pid,
  instanceId,
  requestedBy = "app",
  respawnBy = null,
  now = () => new Date(),
}) {
  const record = {
    schema: AGENT_STOP_INTENT_SCHEMA,
    reason,
    requested_by: requestedBy,
    respawn_by: respawnBy,
    instance_id: instanceId,
    pid,
    requested_at: now().toISOString(),
  };
  if (!parseAgentStopIntent(record)) throw new Error("invalid Agent stop intent");
  const path = agentStopIntentPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return record;
}

/**
 * Withdraws an intent whose SIGTERM could not be delivered, only while the
 * file still names that instance (another controller may have replaced it).
 */
export function retractAgentStopIntent(butlerData, { pid, instanceId }, {
  readFile = readFileSync,
  remove = (path) => rmSync(path, { force: true }),
} = {}) {
  const current = readAgentStopIntent(butlerData, { readFile });
  if (!current || current.instanceId !== instanceId || current.pid !== pid) return false;
  remove(agentStopIntentPath(butlerData));
  return true;
}

/**
 * Decides what an Agent exit means. The intent applies only when its
 * `instance_id` equals the exited Agent's nonce and its `pid` equals the
 * exited PID; otherwise (no intent, unknown instance, another instance) the
 * exit is a crash. The exit status is not an input: every intentional stop
 * exits 0 or is SIGKILLed by its controller, and an unrequested exit never
 * leaves a matching intent.
 *
 * | reason  | respawn_by         | exited Agent            | action        |
 * | stop    | (ignored)          | any                     | stay_stopped  |
 * | restart | app                | spawned by this App     | respawn       |
 * | restart | app                | attached (not spawned)  | await_restart |
 * | restart | controller         | any                     | await_restart |
 * | restart | null / missing     | any (as controller)     | await_restart |
 */
export function decideAgentExit({ intent, exited }) {
  if (!intent) return { action: "recover", cause: "no_intent" };
  if (!nonEmptyString(exited?.instanceId) || !positivePid(exited?.pid)) {
    return { action: "recover", cause: "instance_unknown" };
  }
  if (intent.instanceId !== exited.instanceId || intent.pid !== exited.pid) {
    return { action: "recover", cause: "instance_mismatch" };
  }
  const requestedBy = intent.requestedBy;
  if (intent.reason === "stop") return { action: "stay_stopped", requestedBy, respawnBy: null };
  const respawnBy = intent.respawnBy ?? "controller";
  // Only the App that spawned the Agent can start it again with the App's
  // environment and lease. An attached Agent leased by another App is
  // replaced by that App; this one waits for the replacement like any other.
  if (respawnBy === "app" && exited.spawnedByApp === true) {
    return { action: "respawn", requestedBy, respawnBy };
  }
  return { action: "await_restart", requestedBy, respawnBy };
}

export function parseNativeServiceInstance(input) {
  const value = parseJsonObject(input);
  if (!value || value.schema !== NATIVE_SERVICE_INSTANCE_SCHEMA) return null;
  if (!positivePid(value.pid) || !nonEmptyString(value.nonce)) return null;
  return {
    pid: value.pid,
    instanceId: value.nonce,
    state: typeof value.state === "string" ? value.state : "unknown",
    appEnabled: value.app_enabled === true,
    // The instance holds an App's foreground lease (#244). A CLI/MCP restart
    // of such an instance is left to that App (`respawn_by: app`).
    appSupervised: value.app_supervised === true,
    port: localEndpointPort(value.app_endpoint),
  };
}

export function readNativeServiceInstance(butlerData, { readFile = readFileSync } = {}) {
  return parseNativeServiceInstance(readText(nativeServiceInstancePath(butlerData), readFile));
}

/** A replacement is a different instance (by nonce) that is ready and alive. */
export function selectReplacementInstance(record, {
  exitedInstanceId = null,
  isProcessAlive = processIsAlive,
} = {}) {
  if (!record || record.state !== "ready" || !record.appEnabled || !record.port) return null;
  if (record.instanceId === exitedInstanceId) return null;
  return isProcessAlive(record.pid) ? record : null;
}

export function processIsAlive(pid, kill = process.kill.bind(process)) {
  if (!positivePid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function localEndpointPort(value) {
  if (!nonEmptyString(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !localHosts.has(url.hostname)) return null;
    const port = Number(url.port || 80);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function parseJsonObject(input) {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
      ? value
      : null;
  } catch {
    return null;
  }
}

function readText(path, readFile) {
  try {
    return readFile(path, "utf8");
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}
